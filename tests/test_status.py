"""The judgement behind the mark's color and the status line, at a pinned clock."""
from quota import status

NOW = 1_800_000_000.0
H = 3600
FIVE = 5 * H
WEEK = 7 * 24 * H


def win(role, util, resets_in, total, api="ok", label="X"):
    return {"key": role, "label": label, "role": role, "utilization": util, "resets_at": NOW + resets_in,
            "total_seconds": total, "api_level": api}


def test_util_level_thresholds():
    assert [status.util_level(u) for u in (0, 74.9, 75, 89.9, 90, 100)] == ["ok", "ok", "warn", "warn", "crit", "crit"]


def test_projection_and_exhaustion():
    # 40% used in the first hour of five: on pace for 200%, out after 1.5 h more
    assert status.projected_util(40, NOW + 4 * H, FIVE, NOW) == 200
    assert status.exhaust_seconds(40, NOW + 4 * H, FIVE, NOW) == 1.5 * H
    assert status.lockout_seconds(40, NOW + 4 * H, FIVE, NOW) == 2.5 * H
    assert status.window_level(40, NOW + 4 * H, FIVE, NOW) == "crit"
    # too early in the window to judge the pace
    assert status.projected_util(3, NOW + FIVE - 60, FIVE, NOW) == 3
    assert status.exhaust_seconds(3, NOW + FIVE - 60, FIVE, NOW) is None


def test_calm_pace_is_ok():
    assert status.window_level(20, NOW + 2.5 * H, FIVE, NOW) == "ok"
    assert status.projection_note(20, NOW + 2.5 * H, FIVE, NOW) == ""


def test_api_severity_floors_the_level():
    assert status.judge_window(win("session", 10, 4 * H, FIVE, api="crit"), NOW) == "crit"


def test_human_duration():
    assert status.human_duration(45) == "45 s"
    assert status.human_duration(12 * 60) == "12 min"
    assert status.human_duration(80 * 60) == "1 h 20 min"
    assert status.human_duration(2 * H) == "2 h"
    assert status.human_duration(53 * H) == "2 d 5 h"


def test_relative_reset():
    assert status.relative_reset(None, NOW) == ""
    assert status.relative_reset(NOW - 1, NOW) == "Resetting…"
    assert status.relative_reset(NOW + 90 * 60, NOW) == "Resets in 1 h 30 min"


def test_projection_note_words():
    assert status.projection_note(40, NOW + 4 * H, FIVE, NOW) == "runs out in 1 h 30 min at this pace"
    assert status.projection_note(100, NOW + 4 * H, FIVE, NOW) == ""
    # on track for 80% by the reset, without running out
    assert status.projection_note(40, NOW + 2.5 * H, FIVE, NOW) == "on track for 80% by the reset"


def test_overall_no_accounts_and_loading():
    assert status.overall_status([], NOW) == {"state": "unknown", "text": "No accounts yet"}
    loading = [{"kind": "claude", "label": "Claude", "result": None, "windows": None}]
    assert status.overall_status(loading, NOW)["text"] == "Checking usage…"
    signed_out = [{"kind": "claude", "label": "Claude", "result": "signed-out", "windows": None}]
    assert status.overall_status(signed_out, NOW)["text"] == "Not signed in to Claude"


def test_overall_good_and_out():
    good = [{"kind": "claude", "label": "C", "result": "ok",
             "windows": [win("session", 10, 2.5 * H, FIVE), win("weekly", 20, 3.5 * 24 * H, WEEK)]}]
    assert status.overall_status(good, NOW) == {"state": "good", "text": "Ready to work"}
    out = [{"kind": "claude", "label": "C", "result": "ok", "windows": [win("session", 100, 2 * H, FIVE)]}]
    st = status.overall_status(out, NOW)
    assert st["state"] == "out" and st["text"].startswith("Out of tokens until ")


def test_account_with_most_room_decides():
    full = {"kind": "claude", "label": "A", "result": "ok", "windows": [win("session", 100, 2 * H, FIVE)]}
    fine = {"kind": "claude", "label": "B", "result": "ok", "windows": [win("session", 10, 2.5 * H, FIVE)]}
    assert status.overall_status([full, fine], NOW)["state"] == "good"


def test_per_model_window_does_not_decide():
    windows = [win("session", 10, 2.5 * H, FIVE), win("scoped", 100, 2 * 24 * H, WEEK, label="Fable")]
    assert status.claude_account_status(windows, NOW)["state"] == "good"


def test_openrouter_only_turns_it_red():
    spent = {"kind": "openrouter", "label": "OR", "result": "ok",
             "windows": [{"utilization": 100, "role": "budget", "api_level": "crit"}]}
    claude = {"kind": "claude", "label": "C", "result": "ok", "windows": [win("session", 10, 2.5 * H, FIVE)]}
    assert status.overall_status([claude, spent], NOW) == {"state": "out", "text": "OpenRouter is out of credit"}
    fine = {**spent, "windows": [{"utilization": 30, "role": "budget", "api_level": "ok"}]}
    assert status.overall_status([fine], NOW) == {"state": "good", "text": "Ready to work"}


def test_overall_agy_subscription():
    agy = [{"kind": "agy", "label": "Google AI", "result": "ok",
            "windows": [win("quota", 92, 2 * H, FIVE, label="Gemini 3.1 Pro")]}]
    st = status.overall_status(agy, NOW)
    assert st["state"] == "critical"
    assert "Gemini 3.1 Pro limit at 92%" in st["text"]
    signed_out = [{"kind": "agy", "label": "Google AI", "result": "signed-out", "windows": None}]
    assert status.overall_status(signed_out, NOW)["text"] == "Not signed in to Antigravity"
