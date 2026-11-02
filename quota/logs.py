"""Model usage over time, read-only, from MINITRON's records. No GTK.

- `memory/turns.jsonl`: one digest per finished turn (Minitron/minitron/memory.py): `at`, `session`,
  `provider`, `prompt`, `seconds`, `context` (how full the context was, 0-1), `cost` (the turn's $).
- `sessions/<id>.json`: each chat, with `provider`, `model` and a `usage` dict (`context` tokens,
  `window`, `last_cost`, `cost` in all). The day pages are `chat-YYYY-MM-DD.json`.

Turns are grouped by local day, then by provider and model. A day page whose cost is more than its
logged turns (turns from before the log began) adds that rest as one line, so a day's total matches.
Nothing here writes.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

PROVIDERS = {"claude-code": "Claude Code", "openrouter": "OpenRouter", "claude": "Claude", "agy": "Antigravity"}


def data_dir() -> Path:
    base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    return base / "minitron"


def provider_name(provider: str) -> str:
    return PROVIDERS.get(provider or "", (provider or "Unknown").replace("-", " ").title())


def model_name(model: str | None) -> str:
    """None: not recorded (the turn ran on another provider than its chat's); "": the default."""
    if model is None:
        return "Model not recorded"
    return model or "Default model"


def format_tokens(n) -> str:
    if n is None:
        return ""
    n = int(n)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M".replace(".0M", "M")
    if n >= 1000:
        return f"{round(n / 1000)}k"
    return str(n)


def format_cost(cost) -> str:
    if cost is None:
        return "—"
    if 0 < cost < 0.01:
        return "<$0.01"
    return f"${cost:.2f}"


def format_seconds(seconds) -> str:
    s = int(round(seconds or 0))
    if s < 60:
        return f"{s} s"
    if s < 3600:
        return f"{s // 60} min {s % 60} s" if s % 60 else f"{s // 60} min"
    return f"{s // 3600} h {s % 3600 // 60} min"


def day_title(day: date, today: date | None = None) -> str:
    today = today or date.today()
    if day == today:
        return "Today"
    if day == today - timedelta(days=1):
        return "Yesterday"
    title = f"{day:%A}, {day.day} {day:%B}"
    return title if day.year == today.year else f"{title} {day.year}"


def read_turns(path: Path) -> list[dict]:
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict) and isinstance(item.get("at"), (int, float)):
            out.append(item)
    return out


_sessions: dict[Path, tuple[float, dict]] = {}


def read_session(path: Path) -> dict | None:
    """The few keys of a chat the log needs; cached by mtime (day pages grow large)."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    cached = _sessions.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    head = {"id": data.get("id") or path.stem, "provider": data.get("provider") or "", "model": data.get("model") or "",
            "title": data.get("title") or "", "usage": data.get("usage") if isinstance(data.get("usage"), dict) else {}}
    _sessions[path] = (mtime, head)
    return head


def load_days(folder: Path | None = None, today: date | None = None) -> list[dict]:
    """Newest day first: [{date, title, total, count, groups: [{provider, model, cost, turns, tokens}],
    earlier: {cost, page} | None, page: usage | None}]."""
    folder = folder or data_dir()
    sessions_dir = folder / "sessions"
    turns = read_turns(folder / "memory" / "turns.jsonl")
    heads = {}

    def head(session_id):
        if session_id not in heads:
            heads[session_id] = read_session(sessions_dir / f"{session_id}.json") if session_id else None
        return heads[session_id]

    by_day: dict[date, list[dict]] = defaultdict(list)
    for t in turns:
        session = head(t.get("session")) or {}
        fill = t.get("context")
        cost = t.get("cost") if isinstance(t.get("cost"), (int, float)) else None
        provider = t.get("provider") or session.get("provider") or ""
        # the digest keeps no model: the chat's, unless the turn ran on another provider than the chat's
        same = provider == session.get("provider")
        model = session.get("model", "") if same else None
        window = (session.get("usage") or {}).get("window") if same else None
        by_day[datetime.fromtimestamp(t["at"]).date()].append({
            "at": t["at"], "session": t.get("session"), "title": t.get("title") or session.get("title") or "",
            "provider": provider, "model": model,
            "prompt": " ".join(str(t.get("prompt") or "").split()), "seconds": t.get("seconds"),
            "cost": cost, "context": fill,
            "tokens": round(fill * window) if isinstance(fill, (int, float)) and window else None,
            "error": t.get("error")})
    pages = {}
    for path in sessions_dir.glob("chat-????-??-??.json") if sessions_dir.is_dir() else []:
        try:
            day = date.fromisoformat(path.stem[len("chat-"):])
        except ValueError:
            continue
        page = read_session(path)
        if page:
            pages[day] = page

    days = []
    for day in sorted(set(by_day) | set(pages), reverse=True):
        items = sorted(by_day.get(day, []), key=lambda t: t["at"], reverse=True)
        groups: dict[tuple, dict] = {}
        for t in items:
            g = groups.setdefault((t["provider"], t["model"]), {
                "provider": provider_name(t["provider"]), "model": model_name(t["model"]),
                "cost": 0.0, "turns": [], "tokens": None})
            g["turns"].append(t)
            g["cost"] += t["cost"] or 0
            if t["tokens"] is not None:
                g["tokens"] = max(g["tokens"] or 0, t["tokens"])
        page = pages.get(day)
        earlier = None
        if page:
            logged = sum(t["cost"] or 0 for t in items if t["session"] == page["id"])
            rest = (page["usage"].get("cost") or 0) - logged
            if rest > 0.005:
                earlier = {"cost": rest, "provider": provider_name(page["provider"]), "model": model_name(page["model"])}
        total = sum(g["cost"] for g in groups.values()) + (earlier["cost"] if earlier else 0)
        days.append({"date": day, "title": day_title(day, today), "total": total, "count": len(items),
                     "groups": sorted(groups.values(), key=lambda g: -g["cost"]), "earlier": earlier,
                     "page": page["usage"] if page else None})
    return days


def summary(days: list[dict], today: date | None = None) -> dict:
    """Totals for the last 7 and 30 days, today included."""
    today = today or date.today()
    week = sum(d["total"] for d in days if (today - d["date"]).days < 7)
    month = sum(d["total"] for d in days if (today - d["date"]).days < 30)
    return {"week": week, "month": month, "turns": sum(d["count"] for d in days if (today - d["date"]).days < 7)}
