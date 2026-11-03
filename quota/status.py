"""Pure judgement of usage, the same as the extension's src/lib/status.js: how serious each window is
at the current pace, and the one state (and sentence) the app's status line shows. No GTK.

Times are epoch seconds; every function that depends on the clock takes `now` so tests can pin it.
A window is a dict: {key, label, role, utilization, resets_at (epoch s or None), total_seconds,
api_level, detail}. Keep it in step with status.js: the mark in the top bar and the app must agree.
"""
from __future__ import annotations

import math
import time
from datetime import datetime

LEVEL_RANK = {"ok": 0, "warn": 1, "crit": 2}
STATE_RANK = {"good": 0, "tight": 1, "critical": 2, "out": 3}
LOCKOUT_CRIT_FRAC = 0.10


def _now(now):
    return time.time() if now is None else now


def max_level(a: str, b: str) -> str:
    return a if LEVEL_RANK.get(a, 0) >= LEVEL_RANK.get(b, 0) else b


def util_level(util: float) -> str:
    if util >= 90:
        return "crit"
    if util >= 75:
        return "warn"
    return "ok"


def _remaining(resets_at, now):
    if resets_at is None:
        return None
    remaining = resets_at - now
    return remaining if remaining > 0 else None


def projected_util(util, resets_at, total, now=None):
    now = _now(now)
    remaining = _remaining(resets_at, now)
    if remaining is None or not total:
        return util
    elapsed = total - remaining
    if elapsed <= 0 or elapsed / total < 0.05:
        return util
    return max(util, util * total / elapsed)


def exhaust_seconds(util, resets_at, total, now=None):
    """Seconds until 100% at the average rate so far, only when that lands before the reset."""
    now = _now(now)
    remaining = _remaining(resets_at, now)
    if remaining is None or not total or not util or util <= 0:
        return None
    elapsed = total - remaining
    if elapsed <= 0 or elapsed / total < 0.05:
        return None
    to_exhaust = elapsed * (100 - util) / util
    return to_exhaust if 0 < to_exhaust < remaining else None


def lockout_seconds(util, resets_at, total, now=None):
    now = _now(now)
    exhaust = exhaust_seconds(util, resets_at, total, now)
    if exhaust is None:
        return None
    return max(0.0, _remaining(resets_at, now) - exhaust)


def window_level(util, resets_at, total, now=None):
    now = _now(now)
    level = util_level(util)
    lockout = lockout_seconds(util, resets_at, total, now)
    if lockout is not None:
        level = max_level(level, "crit" if lockout >= total * LOCKOUT_CRIT_FRAC else "warn")
    elif projected_util(util, resets_at, total, now) >= 75:
        level = max_level(level, "warn")
    return level


def judge_window(w: dict, now=None) -> str:
    return max_level(window_level(w["utilization"], w.get("resets_at"), w.get("total_seconds"), now),
                     w.get("api_level") or "ok")


def human_duration(seconds: float) -> str:
    """"45 s", "12 min", "1 h 20 min", "2 d 5 h": the two largest units."""
    s = max(0, math.floor(seconds))
    if s < 60:
        return f"{s} s"
    mins = round(s / 60)
    if mins < 60:
        return f"{mins} min"
    hrs = mins // 60
    if hrs < 24:
        return f"{hrs} h {mins % 60} min" if mins % 60 else f"{hrs} h"
    days = hrs // 24
    return f"{days} d {hrs % 24} h" if hrs % 24 else f"{days} d"


def relative_reset(resets_at, now=None) -> str:
    now = _now(now)
    if resets_at is None:
        return ""
    if resets_at - now <= 0:
        return "Resetting…"
    return f"Resets in {human_duration(resets_at - now)}"


def clock_time(at: float, now=None) -> str:
    """"18:40" within a day, else with the weekday ("Mon 18:40")."""
    now = _now(now)
    d = datetime.fromtimestamp(at)
    return f"{d:%H:%M}" if at - now < 20 * 3600 else f"{d:%a %H:%M}"


def projection_note(util, resets_at, total, now=None) -> str:
    """What the pace means, for a meter's caption."""
    now = _now(now)
    if util >= 100:
        return ""
    lockout = lockout_seconds(util, resets_at, total, now)
    if lockout is not None:
        if lockout >= total * LOCKOUT_CRIT_FRAC:
            return f"runs out in {human_duration(exhaust_seconds(util, resets_at, total, now))} at this pace"
        return "may run out just before the reset"
    proj = projected_util(util, resets_at, total, now)
    if proj >= 75 and round(proj) > round(util):
        return f"on track for {round(proj)}% by the reset"
    return ""


def _window_name(w):
    if w["role"] == "session":
        return "5-hour limit"
    if w["role"] == "weekly":
        return "weekly limit"
    label = str(w.get("label") or "")
    return label if label.lower().endswith(" limit") else f"{label} limit"


def _usable(w):
    return w is not None and isinstance(w.get("utilization"), (int, float)) and math.isfinite(w["utilization"])


def claude_account_status(windows, now=None):
    """{state, window, level, resets_at} for one Claude or Antigravity account, or None with nothing to judge."""
    now = _now(now)
    everything = [w for w in windows or [] if _usable(w)]
    main = [w for w in everything if w["role"] != "scoped"]
    pool = main or everything
    if not pool:
        return None
    full = [w for w in pool if w["utilization"] >= 100]
    if full:
        resets = [w["resets_at"] for w in full if w.get("resets_at") is not None]
        return {"state": "out", "window": full[0], "level": "crit", "resets_at": max(resets) if resets else None}
    worst, worst_level = None, "ok"
    for w in pool:
        level = judge_window(w, now)
        if worst is None or LEVEL_RANK[level] > LEVEL_RANK[worst_level] or \
                (level == worst_level and w["utilization"] > worst["utilization"]):
            worst, worst_level = w, level
    state = {"crit": "critical", "warn": "tight"}.get(worst_level, "good")
    return {"state": state, "window": worst, "level": worst_level, "resets_at": worst.get("resets_at")}


def openrouter_exhausted(windows) -> bool:
    return any(_usable(w) and (w["utilization"] >= 100 or w.get("api_level") == "crit") for w in windows or [])


def _claude_text(st, now):
    w = st["window"]
    left = human_duration(st["resets_at"] - now) if st.get("resets_at") else None
    state = st["state"]
    if state == "out":
        return f"Out of tokens until {clock_time(st['resets_at'], now)}" if st.get("resets_at") else "Out of tokens"
    if state == "critical":
        exhaust = exhaust_seconds(w["utilization"], w.get("resets_at"), w.get("total_seconds"), now)
        if w["utilization"] < 90 and exhaust is not None:
            return f"Burning fast: {_window_name(w)} runs out in {human_duration(exhaust)}"
        return f"Nearly out: {_window_name(w)} at {round(w['utilization'])}%" + (f", resets in {left}" if left else "")
    if state == "tight":
        return (f"Pace is tight: {_window_name(w)} resets in {left}" if left
                else f"Pace is tight: {_window_name(w)} at {round(w['utilization'])}%")
    return "Ready to work"


def overall_status(sources, now=None) -> dict:
    """The one state and its sentence. sources: [{kind, label, result, windows}], result None while
    loading, else "ok" | "error" | "signed-out". Returns {state, text}; state is "unknown" | "good" |
    "tight" | "critical" | "out"."""
    now = _now(now)
    sources = sources or []
    if not sources:
        return {"state": "unknown", "text": "No accounts yet"}
    subs = [s for s in sources if s["kind"] in ("claude", "agy")]
    router = [s for s in sources if s["kind"] == "openrouter"]
    best = None
    for s in subs:
        if s.get("result") != "ok":
            continue
        st = claude_account_status(s.get("windows"), now)
        if st and (best is None or STATE_RANK[st["state"]] < STATE_RANK[best["state"]]):
            best = st
    empty = next((s for s in router if s.get("result") == "ok" and openrouter_exhausted(s.get("windows"))), None)
    if best and best["state"] == "out":
        return {"state": "out", "text": _claude_text(best, now)}
    if empty:
        name = f"OpenRouter ({empty['label']})" if len(router) > 1 else "OpenRouter"
        return {"state": "out", "text": f"{name} is out of credit"}
    if best:
        return {"state": best["state"], "text": _claude_text(best, now)}
    if not subs and any(s.get("result") == "ok" for s in router):
        return {"state": "good", "text": "Ready to work"}
    if any(s.get("result") is None for s in sources):
        return {"state": "unknown", "text": "Checking usage…"}
    if subs and all(s.get("result") == "signed-out" for s in subs):
        if all(s["kind"] == "claude" for s in subs):
            return {"state": "unknown", "text": "Not signed in to Claude"}
        if all(s["kind"] == "agy" for s in subs):
            return {"state": "unknown", "text": "Not signed in to Antigravity"}
        return {"state": "unknown", "text": "Not signed in"}
    return {"state": "unknown", "text": "Usage unavailable right now"}
