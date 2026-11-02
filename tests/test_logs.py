"""MINITRON's records grouped by day, on a throwaway folder: never the real one."""
import json
from datetime import date, datetime, time, timedelta

from quota import logs

TODAY = date(2026, 10, 19)


def at(day, hour):
    return datetime.combine(day, time(hour)).timestamp()


def make(tmp_path, turns, sessions):
    (tmp_path / "memory").mkdir()
    (tmp_path / "sessions").mkdir()
    lines = [json.dumps(t) for t in turns] + ["not json", json.dumps({"no": "time"})]
    (tmp_path / "memory" / "turns.jsonl").write_text("\n".join(lines))
    for name, data in sessions.items():
        (tmp_path / "sessions" / f"{name}.json").write_text(json.dumps(data))
    return tmp_path


def test_formatting():
    assert logs.format_cost(None) == "—"
    assert logs.format_cost(0.004) == "<$0.01"
    assert logs.format_cost(1.234) == "$1.23"
    assert logs.format_tokens(950) == "950"
    assert logs.format_tokens(34_200) == "34k"
    assert logs.format_tokens(1_000_000) == "1M"
    assert logs.format_tokens(1_250_000) == "1.2M"
    assert logs.format_seconds(42) == "42 s"
    assert logs.format_seconds(120) == "2 min"
    assert logs.format_seconds(3725) == "1 h 2 min"
    assert logs.provider_name("openrouter") == "OpenRouter"
    assert logs.provider_name("agy") == "Antigravity"
    assert logs.provider_name("some-thing") == "Some Thing"
    assert logs.model_name(None) == "Model not recorded" and logs.model_name("") == "Default model"


def test_day_titles():
    assert logs.day_title(TODAY, TODAY) == "Today"
    assert logs.day_title(TODAY - timedelta(days=1), TODAY) == "Yesterday"
    assert logs.day_title(date(2026, 10, 17), TODAY) == "Saturday, 17 October"
    assert logs.day_title(date(2025, 10, 17), TODAY) == "Friday, 17 October 2025"


def test_missing_folder_is_empty(tmp_path):
    assert logs.load_days(tmp_path / "nothing", TODAY) == []


def test_days_groups_and_models(tmp_path):
    yesterday = TODAY - timedelta(days=1)
    folder = make(tmp_path, [
        {"at": at(TODAY, 10), "session": "s1", "provider": "openrouter", "prompt": "  hello \n world ",
         "seconds": 5, "context": 0.25, "cost": 0.10},
        {"at": at(TODAY, 11), "session": "s1", "provider": "openrouter", "prompt": "again", "cost": 0.05},
        {"at": at(TODAY, 12), "session": "s1", "provider": "claude-code", "prompt": "other provider", "cost": 0},
        {"at": at(yesterday, 9), "session": "s2", "provider": "claude-code", "prompt": "old", "cost": None},
    ], {"s1": {"id": "s1", "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5",
               "usage": {"window": 200000}},
        "s2": {"id": "s2", "provider": "claude-code", "model": ""}})
    days = logs.load_days(folder, TODAY)
    assert [d["title"] for d in days] == ["Today", "Yesterday"]
    today = days[0]
    assert today["count"] == 3 and round(today["total"], 2) == 0.15
    top = today["groups"][0]
    assert top["model"] == "anthropic/claude-sonnet-4.5" and top["provider"] == "OpenRouter"
    assert [t["prompt"] for t in top["turns"]] == ["again", "hello world"]  # newest first, spaces folded
    assert top["tokens"] == 50000
    # a turn on another provider than its chat's: the model is not known
    assert today["groups"][1]["model"] == "Model not recorded"
    assert days[1]["groups"][0]["model"] == "Default model"


def test_day_page_adds_unlogged_cost(tmp_path):
    folder = make(tmp_path, [
        {"at": at(TODAY, 10), "session": "chat-2026-10-19", "provider": "openrouter", "cost": 0.25},
    ], {"chat-2026-10-19": {"id": "chat-2026-10-19", "provider": "openrouter", "model": "m",
                            "usage": {"cost": 1.0}}})
    (today,) = logs.load_days(folder, TODAY)
    assert round(today["earlier"]["cost"], 2) == 0.75
    assert round(today["total"], 2) == 1.0


def test_summary():
    days = [{"date": TODAY, "total": 1.0, "count": 2}, {"date": TODAY - timedelta(days=6), "total": 2.0, "count": 1},
            {"date": TODAY - timedelta(days=7), "total": 4.0, "count": 5},
            {"date": TODAY - timedelta(days=30), "total": 8.0, "count": 1}]
    assert logs.summary(days, TODAY) == {"week": 3.0, "month": 7.0, "turns": 3}
