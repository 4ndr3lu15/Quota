"""Where the usage comes from and what it means, without GTK: the Claude plan's limits
(`api/oauth/usage` with the token Claude Code keeps in `<configDir>/.credentials.json`) and an
OpenRouter key's spend (`/api/v1/key`, and `/api/v1/credits` with a management key).

The shaping mirrors the extension's src/lib/usageModel.js and openrouterModel.js, so the app and
the top bar read the same payload the same way. Fetching is blocking (urllib): call it from a
worker thread. The network calls go through `http_get`, which the tests and screenshots replace.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_USAGE_PAGE = "https://claude.ai/settings/usage"
KEY_URL = "https://openrouter.ai/api/v1/key"
CREDITS_URL = "https://openrouter.ai/api/v1/credits"
OPENROUTER_PAGE = "https://openrouter.ai/activity"
AGY_PAGE = "https://one.google.com/ai"
AGY_ENDPOINTS = ("https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com")

FIVE_HOURS = 5 * 3600
DAY = 24 * 3600
WEEK = 7 * DAY
GROUP_SECONDS = {"session": FIVE_HOURS, "weekly": WEEK}
ROLE_ORDER = {"session": 0, "weekly": 1, "scoped": 2, "other": 3}


class UsageError(Exception):
    def __init__(self, message: str, status: int = 0, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body


class SignedOut(UsageError):
    """Nothing to ask with: no login, no key. Shown as a quiet note, not an error."""


def http_get(url: str, headers: dict, timeout: float = 15) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "quota", **headers})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode()
    except urllib.error.HTTPError as error:
        raise UsageError(f"HTTP {error.code}", error.code, error.read().decode(errors="replace")) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise UsageError(f"Could not connect: {getattr(error, 'reason', error)}") from None
    return json.loads(text) if text else {}


def http_post(url: str, body: dict, headers: dict, timeout: float = 15) -> dict:
    raw = json.dumps(body).encode()
    request = urllib.request.Request(url, data=raw, method="POST",
                                     headers={"Accept": "application/json", "Content-Type": "application/json",
                                              "User-Agent": "quota", **headers})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode()
    except urllib.error.HTTPError as error:
        raise UsageError(f"HTTP {error.code}", error.code, error.read().decode(errors="replace")) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise UsageError(f"Could not connect: {getattr(error, 'reason', error)}") from None
    return json.loads(text) if text else {}


def parse_time(value) -> float | None:
    """An ISO time (or epoch seconds) as epoch seconds; None when missing or unreadable."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _number(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


# ---- Claude ----

def read_credentials(config_dir: Path) -> dict | None:
    """Claude Code's OAuth block for a config folder ({accessToken, expiresAt, subscriptionType, ...})."""
    try:
        oauth = json.loads((Path(config_dir) / ".credentials.json").read_text()).get("claudeAiOauth") or {}
    except (OSError, ValueError, AttributeError):
        return None
    return oauth if oauth.get("accessToken") else None


def plan_label(oauth: dict | None) -> str:
    kind = (oauth or {}).get("subscriptionType") or ""
    return f"{kind.capitalize()} plan" if kind else ""


_KNOWN_MODEL = {"opus": "Opus", "sonnet": "Sonnet", "haiku": "Haiku", "oauth_apps": "OAuth Apps"}


def _humanize(token) -> str:
    return " ".join(w[:1].upper() + w[1:] for w in str(token or "").replace("_", " ").split())


def limit_label(entry: dict) -> str:
    scope = entry.get("scope") or {}
    model = (scope.get("model") or {}).get("display_name")
    kind = entry.get("kind")
    if kind == "session":
        base = "5-hour session"
    elif kind == "weekly_all":
        base = "Weekly"
    elif kind == "weekly_scoped":
        base = f"Weekly · {model}" if model else "Weekly (scoped)"
    else:
        base = _humanize(kind or entry.get("group") or "usage") + (f" {model}" if model else "")
    if scope.get("surface"):
        base += f" · {_humanize(scope['surface'])}"
    return base


def _role(entry: dict) -> str:
    kind, group = entry.get("kind"), entry.get("group")
    if kind == "session" or group == "session":
        return "session"
    if kind == "weekly_all":
        return "weekly"
    if kind == "weekly_scoped":
        return "scoped"
    return "weekly" if group == "weekly" else "other"


def _api_level(severity) -> str:
    return {"critical": "crit", "warning": "warn"}.get(severity, "ok")


def normalize_windows(usage: dict) -> list[dict]:
    """The windows to show, from the `limits[]` array, or the older flat keys."""
    out = []
    for entry in usage.get("limits") or []:
        if not isinstance(entry, dict) or _number(entry.get("percent")) is None:
            continue
        role = _role(entry)
        total = GROUP_SECONDS.get(entry.get("group")) or (
            WEEK if role in ("scoped", "weekly") else FIVE_HOURS if role == "session" else None)
        out.append({"key": f"limit:{entry.get('kind')}:{entry.get('group')}:{limit_label(entry)}",
                    "label": limit_label(entry), "role": role, "utilization": _number(entry["percent"]),
                    "resets_at": parse_time(entry.get("resets_at")), "total_seconds": total,
                    "api_level": _api_level(entry.get("severity"))})
    if out:
        return sorted(out, key=lambda w: ROLE_ORDER[w["role"]])

    def legacy(key, label, role, win, total):
        util = _number((win or {}).get("utilization"))
        if util is not None:
            out.append({"key": f"legacy:{key}", "label": label, "role": role, "utilization": util,
                        "resets_at": parse_time(win.get("resets_at")), "total_seconds": total, "api_level": "ok"})
    legacy("five_hour", "5-hour session", "session", usage.get("five_hour"), FIVE_HOURS)
    legacy("seven_day", "Weekly", "weekly", usage.get("seven_day"), WEEK)
    for key, win in usage.items():
        if key.startswith("seven_day_") and isinstance(win, dict):
            name = key[len("seven_day_"):]
            legacy(key, f"Weekly · {_KNOWN_MODEL.get(name, _humanize(name))}", "scoped", win, WEEK)
    return out


def _minor(m) -> str | None:
    if not isinstance(m, dict) or _number(m.get("amount_minor")) is None:
        return None
    exp = int(_number(m.get("exponent")) if _number(m.get("exponent")) is not None else 2)
    cur = f"{m['currency']} " if m.get("currency") else ""
    return f"{cur}{_number(m['amount_minor']) / 10 ** exp:.{exp}f}"


def normalize_spend(usage: dict) -> dict | None:
    """Extra usage beyond the plan: {used, limit, percent, level} or None."""
    spend = usage.get("spend") or {}
    if spend.get("enabled"):
        cap = spend.get("cap") or {}
        used = _minor(spend.get("used"))
        limit = _minor(spend.get("limit")) or _minor(cap.get("money")) or _minor(cap.get("credits"))
        if used or limit:
            return {"used": used, "limit": limit, "percent": _number(spend.get("percent")),
                    "level": _api_level(spend.get("severity"))}
    xu = usage.get("extra_usage") or {}
    if xu.get("is_enabled"):
        places = int(_number(xu.get("decimal_places")) or 2)
        cur = f"{xu['currency']} " if xu.get("currency") else ""

        def money(v):
            return f"{cur}{v / 10 ** places:.{places}f}" if v is not None else None
        used = money(_number(xu.get("used_credits")))
        limit = money(_number(xu.get("monthly_limit"))) if (_number(xu.get("monthly_limit")) or 0) > 0 else None
        if used or limit:
            pct = _number(xu.get("utilization"))
            return {"used": used or f"{cur}0.00", "limit": limit,
                    "percent": round(pct) if pct is not None else None, "level": "ok"}
    return None


def fetch_claude(account: dict) -> dict:
    """{plan, windows, spend} for one Claude account ({label, config_dir, token?}); raises
    SignedOut or UsageError."""
    oauth = read_credentials(account["config_dir"])
    token = (oauth or {}).get("accessToken") or account.get("token")
    if not token:
        raise SignedOut("Not signed in. Sign in with Claude Code, or from the extension's settings.")
    try:
        data = http_get(USAGE_URL, {"Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20",
                                    "anthropic-version": "2023-06-01"})
    except UsageError as error:
        if error.status == 401:
            raise UsageError("The sign-in has expired. Open Claude Code to sign in again.", 401) from None
        if error.status == 429:
            raise UsageError("Claude is rate limiting usage checks. Trying again shortly.", 429) from None
        raise
    return {"plan": plan_label(oauth), "windows": normalize_windows(data), "spend": normalize_spend(data)}


# ---- OpenRouter ----

def money(value) -> str | None:
    n = _number(value)
    return None if n is None else f"${n:.2f}"


def _pct(used, limit):
    u, lim = _number(used), _number(limit)
    if u is None or lim is None or lim <= 0:
        return None
    return max(0.0, u / lim * 100)


def next_utc_reset(interval: str | None, now: float | None = None) -> float | None:
    """Start of the next UTC day, week (Monday) or month after now."""
    d = datetime.fromtimestamp(time.time() if now is None else now, timezone.utc)
    start = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    if interval == "daily":
        return (start + timedelta(days=1)).timestamp()
    if interval == "weekly":
        return (start + timedelta(days=7 - d.weekday())).timestamp()
    if interval == "monthly":
        return datetime(d.year + d.month // 12, d.month % 12 + 1, 1, tzinfo=timezone.utc).timestamp()
    return None


_INTERVAL_SECONDS = {"daily": DAY, "weekly": WEEK, "monthly": 30 * DAY}
_SCOPE_LABEL = {"key_limit": "Key limit", "api_key": "Key budget", "member": "Member budget",
                "workspace": "Workspace budget", "workspace_default_member": "Default member budget",
                "workspace_default_key": "Default key budget"}


def _windowed(label, interval, used, limit, remaining, key, role="budget", resets_at=None, detail=None):
    resets = resets_at if resets_at is not None else next_utc_reset(interval)
    return {"key": key, "label": f"{label} ({interval})" if interval else label, "role": role,
            "utilization": _pct(used, limit), "resets_at": resets, "total_seconds": _INTERVAL_SECONDS.get(interval),
            "api_level": "crit" if remaining is not None and remaining <= 0 else "ok",
            "detail": detail or f"{money(used)} of {money(limit)}"}


def normalize_openrouter(key: dict, credits: dict | None = None) -> dict:
    """{windows, tier, spent: [(when, $)], balance, expires_at, label} from the `data` of /key (and /credits)."""
    key = key or {}
    windows = []
    for i, b in enumerate(key.get("budgets") or []):
        if not isinstance(b, dict):
            continue
        w = _windowed(_SCOPE_LABEL.get(b.get("scope"), "Budget"), b.get("reset_interval"), b.get("spend_usd"),
                      b.get("limit_usd"), _number(b.get("remaining_usd")), f"or:budget:{i}",
                      resets_at=parse_time(b.get("resets_at")))
        if w["utilization"] is not None:
            windows.append(w)
    limit, remaining = _number(key.get("limit")), _number(key.get("limit_remaining"))
    if not windows and limit and limit > 0 and remaining is not None:
        windows.append(_windowed("Key limit", key.get("limit_reset"), limit - remaining, limit, remaining,
                                 "or:key-limit"))
    balance = None
    total, used = _number((credits or {}).get("total_credits")), _number((credits or {}).get("total_usage"))
    if total is not None and used is not None:
        balance = total - used
        windows.append({"key": "or:credits", "label": "Credits used", "role": "credits",
                        "utilization": min(100.0, used / total * 100) if total > 0 else float("nan"),
                        "resets_at": None, "total_seconds": None, "api_level": "crit" if balance <= 0 else "ok",
                        "detail": f"{money(max(0.0, balance))} left of {money(total)}"})
    free = key.get("free_model_daily_requests") or {}
    if key.get("is_free_tier") and (_number(free.get("limit")) or 0) > 0 and _number(free.get("used")) is not None:
        windows.append({"key": "or:free", "label": "Free model requests (daily)", "role": "free",
                        "utilization": _pct(free["used"], free["limit"]), "resets_at": next_utc_reset("daily"),
                        "total_seconds": DAY, "api_level": "crit" if (_number(free.get("remaining")) or 1) <= 0 else "ok",
                        "detail": f"{int(free['used'])} of {int(free['limit'])} requests"})
    spent = [(when, money(key.get(k))) for when, k in (("Today", "usage_daily"), ("This week", "usage_weekly"),
                                                       ("This month", "usage_monthly")) if money(key.get(k))]
    if not spent and money(key.get("usage")):
        spent = [("In all", money(key.get("usage")))]
    return {"windows": windows, "tier": "Free" if key.get("is_free_tier") else "Pay as you go", "spent": spent,
            "balance": balance, "has_expiry": "expires_at" in key, "expires_at": parse_time(key.get("expires_at")),
            "label": key.get("label") or ""}


def fetch_openrouter(account: dict) -> dict:
    """The key's spend for one OpenRouter account ({label, api_key, management_key, shared})."""
    api, mgmt = account.get("api_key"), account.get("management_key")
    if not api and not mgmt:
        raise SignedOut("No OpenRouter key yet. Add one in MINITRON's preferences or the extension's settings.")
    try:
        key = http_get(KEY_URL, {"Authorization": f"Bearer {api or mgmt}"}).get("data") or {}
    except UsageError as error:
        if error.status == 401:
            raise UsageError("OpenRouter rejected the key. Check it where you added it.", 401) from None
        if error.status == 429:
            raise UsageError("OpenRouter is rate limiting requests. Trying again shortly.", 429) from None
        raise
    credits, note = None, ""
    if mgmt:
        try:
            credits = http_get(CREDITS_URL, {"Authorization": f"Bearer {mgmt}"}).get("data")
        except UsageError as error:
            note = ("Balance unavailable: that key is not a management key." if error.status in (401, 403)
                    else "Balance unavailable right now.")
    result = normalize_openrouter(key, credits)
    result["note"] = note
    return result


# ---- Google Antigravity (agy) ----

_UNIT_SECONDS = {"w": WEEK, "d": DAY, "h": 3600, "m": 60, "s": 1}
_KNOWN_AGY_TIERS = {
    "g1-pro-tier": "Google AI Pro",
    "g1-ultra-tier": "Google AI Ultra",
    "free-tier": "Free",
    "standard-tier": "Standard",
}


def parse_window_seconds(window_str: str | None) -> int | None:
    if not isinstance(window_str, str) or not window_str.strip():
        return None
    matches = re.findall(r"(\d+(?:\.\d+)?)\s*([wdhms])", window_str.strip().lower())
    if not matches:
        return None
    total = sum(float(n) * _UNIT_SECONDS[u] for n, u in matches)
    return round(total) if total > 0 else None


def agy_tier_label(raw: str | None) -> str:
    if not isinstance(raw, str) or not raw.strip():
        return ""
    trimmed = raw.strip()
    lower = trimmed.lower()
    if lower in _KNOWN_AGY_TIERS:
        return _KNOWN_AGY_TIERS[lower]
    m = re.match(r"^g1-([a-z0-9]+)-tier$", lower)
    if m:
        return f"Google AI {m.group(1).capitalize()}"
    if trimmed != lower:
        return trimmed
    cleaned = re.sub(r"[_-]+tier$", "", trimmed, flags=re.IGNORECASE)
    return _humanize(cleaned.replace("-", "_"))


def _unwrap_cmd(payload: dict | None, expected: str | None = None) -> dict:
    if not isinstance(payload, dict):
        return {}
    cmd = payload.get("command")
    if isinstance(cmd, dict) and (expected is None or cmd.get("name") == expected):
        return cmd.get("data") if isinstance(cmd.get("data"), dict) else {}
    return payload


def _clean_agy_bucket_name(raw_name: str, group_name: str | None) -> str:
    name = str(raw_name or "").strip()
    if group_name and name.lower().startswith(group_name.lower() + " "):
        name = name[len(group_name):].strip()
    name = re.sub(r"\s+remaining$", "", name, flags=re.IGNORECASE).strip()
    if re.match(r"^five\s+hour\s+limit$", name, flags=re.IGNORECASE):
        return "5-hour limit"
    if re.match(r"^weekly\s+limit$", name, flags=re.IGNORECASE):
        return "Weekly limit"
    return name or str(raw_name or "Quota")


def normalize_agy(quota: dict | None, assist: dict | None = None, stored_token: dict | None = None) -> dict:
    """{plan, windows, credits, note} for one Antigravity / Google AI account."""
    q = _unwrap_cmd(quota, "usage")
    a = _unwrap_cmd(assist, "credits")
    token = stored_token if isinstance(stored_token, dict) else {}

    groups = q.get("groups") if isinstance(q.get("groups"), list) else []
    multi = len(groups) > 1
    windows = []

    def add_bucket(b, group_name=None, idx=0):
        if not isinstance(b, dict):
            return
        rem_frac = _number(b.get("remainingFraction") if "remainingFraction" in b else b.get("remaining_fraction"))
        disabled = bool(b.get("disabled"))
        if rem_frac is not None:
            util = max(0.0, min(100.0, (1.0 - rem_frac) * 100.0))
        elif disabled:
            util = 100.0
        else:
            return
        raw_name = b.get("displayName") or b.get("name") or group_name or "Quota"
        clean_name = _clean_agy_bucket_name(raw_name, group_name)
        label = (f"{group_name} · {clean_name}"
                 if (multi and group_name and group_name.lower() != clean_name.lower())
                 else str(clean_name))
        bid = b.get("bucketId") or b.get("id") or raw_name or str(idx)
        key = f"agy:{group_name}:{bid}" if group_name else f"agy:{bid}"
        total = parse_window_seconds(b.get("window"))
        resets_at = parse_time(b.get("resetTime") or b.get("reset_time"))
        rem_amt = _number(b.get("remainingAmount") if "remainingAmount" in b else b.get("remaining_amount"))
        detail = f"{int(rem_amt)} left" if rem_amt is not None else None
        bid_lower = str(bid).lower()
        clean_lower = clean_name.lower()
        if total is None:
            if "5h" in bid_lower or "5-hour" in clean_lower:
                total = FIVE_HOURS
            elif "weekly" in bid_lower or "weekly" in clean_lower:
                total = WEEK
        is_primary = not group_name or bool(re.match(r"^gemini(\s+models)?$", str(group_name), flags=re.IGNORECASE))
        if bid_lower == "gemini-5h" or (is_primary and clean_lower in ("5-hour session", "5-hour limit", "session") and total == FIVE_HOURS):
            role = "session"
        elif bid_lower == "gemini-weekly" or (is_primary and clean_lower in ("weekly", "weekly limit") and total == WEEK):
            role = "weekly"
        else:
            role = "quota"
        w = {"key": key, "label": label, "role": role, "utilization": util,
             "resets_at": resets_at, "total_seconds": total,
             "api_level": "crit" if disabled or util >= 100 else "ok"}
        if detail:
            w["detail"] = detail
        windows.append(w)

    idx = 0
    for g in groups:
        if not isinstance(g, dict):
            continue
        gname = g.get("displayName") or g.get("name")
        for b in g.get("buckets") or []:
            add_bucket(b, gname, idx)
            idx += 1
    if not windows:
        for b in q.get("buckets") or []:
            add_bucket(b, None, idx)
            idx += 1

    paid = a.get("paidTier") if isinstance(a.get("paidTier"), dict) else {}
    curr = a.get("currentTier") if isinstance(a.get("currentTier"), dict) else {}
    plan = ""
    for cand in (paid.get("name"), curr.get("name"), a.get("plan_name"), a.get("planName"),
                 token.get("tier_display_name"), paid.get("id"), curr.get("id"), a.get("g1Tier"),
                 token.get("user_tier")):
        plan = agy_tier_label(cand)
        if plan:
            break

    credits = _number(a.get("remaining_credits") if "remaining_credits" in a else a.get("remainingCredits"))
    if credits is None:
        avail = paid.get("availableCredits") or curr.get("availableCredits") or []
        if isinstance(avail, list):
            amounts = [_number(c.get("creditAmount") if isinstance(c, dict) else None) for c in avail]
            valid = [x for x in amounts if x is not None]
            if valid:
                credits = sum(valid)
    credits_int = int(credits) if credits is not None else None
    note = f"Google AI credits: {credits_int} remaining" if credits_int is not None else ""
    return {"plan": plan, "windows": windows, "credits": credits_int, "note": note}


def read_agy_credentials(config_dir: Path | None = None, lookup=None) -> dict | None:
    """Reads Antigravity's stored token dict from disk or keyring."""
    candidates = []
    if config_dir:
        candidates.append(Path(config_dir) / "antigravity-oauth-token")
        candidates.append(Path(config_dir).parent / "jetski-standalone-oauth-token")
    candidates.append(Path.home() / ".gemini" / "antigravity-cli" / "antigravity-oauth-token")
    candidates.append(Path.home() / ".gemini" / "jetski-standalone-oauth-token")
    for path in candidates:
        try:
            data = json.loads(path.read_text())
            if isinstance(data, dict) and ((data.get("token") or {}).get("access_token") or data.get("access_token")
                                           or (data.get("token") or {}).get("refresh_token")):
                return data
        except (OSError, ValueError):
            continue
    if lookup:
        for username in ("antigravity", "antigravity-oauth-token", "jetski-standalone-oauth-token"):
            raw = lookup("agy", {"service": "gemini", "username": username})
            if raw:
                try:
                    data = json.loads(raw)
                    if isinstance(data, dict):
                        try:
                            cache_path = candidates[0]
                            cache_path.parent.mkdir(parents=True, exist_ok=True)
                            cache_path.write_text(json.dumps(data, indent=2))
                            cache_path.chmod(0o600)
                        except OSError:
                            pass
                        return data
                except ValueError:
                    continue
    return None


def _run_agy_cli(slash_cmd: str, config_dir: Path | None = None) -> dict | None:
    bin_path = shutil.which("agy")
    if not bin_path:
        fallback = Path.home() / ".local/bin/agy"
        bin_path = str(fallback) if fallback.is_file() and os.access(fallback, os.X_OK) else None
    if not bin_path:
        return None
    env = os.environ.copy()
    if config_dir:
        env["AGY_APP_DATA_DIR"] = str(config_dir)
    try:
        proc = subprocess.run([bin_path, "-p", slash_cmd, "--output-format", "json"],
                              capture_output=True, text=True, timeout=15, env=env, check=False)
        return json.loads(proc.stdout) if proc.returncode == 0 and proc.stdout.strip() else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def fetch_agy(account: dict, lookup=None) -> dict:
    """{plan, windows, credits, note} for one Antigravity / Google AI account."""
    config_dir = account.get("config_dir")
    stored = read_agy_credentials(config_dir, lookup=lookup)
    tok_block = (stored or {}).get("token") if isinstance((stored or {}).get("token"), dict) else (stored or {})
    token = tok_block.get("access_token") or tok_block.get("accessToken") or account.get("token")
    exp = parse_time(tok_block.get("expiry") or tok_block.get("expiresAt"))
    # Quota never refreshes Antigravity's token itself (that needs Google's OAuth client, which isn't
    # ours to carry): an expired token goes to `agy` below, which refreshes and saves it, so the next
    # check reads the API directly again.
    if exp is not None and exp - time.time() < 300:
        token = None

    last_err = None
    if token:
        headers = {"Authorization": f"Bearer {token}"}
        assist = None
        for base in AGY_ENDPOINTS:
            try:
                assist = http_post(f"{base}/v1internal:loadCodeAssist",
                                   {"metadata": {"ideType": "ANTIGRAVITY", "pluginType": "GEMINI"}}, headers)
                break
            except UsageError as err:
                last_err = err
                if err.status in (401, 403):
                    break
        raw_proj = (assist or {}).get("cloudaicompanionProject")
        project = (raw_proj if isinstance(raw_proj, str)
                   else (raw_proj or {}).get("id") if isinstance(raw_proj, dict)
                   else "") or (stored or {}).get("project_id") or ""
        for base in AGY_ENDPOINTS:
            try:
                quota = http_post(f"{base}/v1internal:retrieveUserQuotaSummary",
                                  {"project": project} if project else {}, headers)
                return normalize_agy(quota, assist, stored)
            except UsageError as err:
                last_err = err
                if err.status in (401, 403):
                    break

    usage_cli = _run_agy_cli("/usage", config_dir)
    credits_cli = _run_agy_cli("/credits", config_dir)
    if usage_cli or credits_cli:
        res = normalize_agy(usage_cli or {}, credits_cli or {}, stored)
        if res["windows"] or res["plan"] or res["note"]:
            return res

    if last_err:
        if last_err.status == 401:
            raise UsageError("Google session expired. Run `agy auth login` to sign in again.", 401) from None
        if last_err.status == 429:
            raise UsageError("Google is rate limiting quota checks. Trying again shortly.", 429) from None
        raise last_err

    raise SignedOut("Not signed in. Run `agy auth login` in a terminal to connect your Google subscription.")
