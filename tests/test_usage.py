"""Shaping the Claude and OpenRouter payloads, and fetching with the network replaced."""
import json
from datetime import datetime, timezone

import pytest

from quota import usage


def test_parse_time():
    assert usage.parse_time(None) is None
    assert usage.parse_time("nonsense") is None
    assert usage.parse_time(12) == 12.0
    assert usage.parse_time("2026-10-19T12:00:00Z") == datetime(2026, 10, 19, 12, tzinfo=timezone.utc).timestamp()


def test_limits_array_sorted_by_role():
    windows = usage.normalize_windows({"limits": [
        {"kind": "weekly_scoped", "group": "weekly", "percent": 23, "scope": {"model": {"display_name": "Fable"}}},
        {"kind": "weekly_all", "group": "weekly", "percent": 61, "severity": "warning"},
        {"kind": "session", "group": "session", "percent": 42, "resets_at": "2026-10-19T12:00:00Z"},
        {"kind": "session", "group": "session"},  # no percent: dropped
    ]})
    assert [w["label"] for w in windows] == ["5-hour session", "Weekly", "Weekly · Fable"]
    assert [w["role"] for w in windows] == ["session", "weekly", "scoped"]
    assert windows[0]["total_seconds"] == usage.FIVE_HOURS and windows[1]["total_seconds"] == usage.WEEK
    assert windows[1]["api_level"] == "warn"


def test_legacy_flat_keys():
    windows = usage.normalize_windows({"five_hour": {"utilization": 12}, "seven_day": {"utilization": 30},
                                       "seven_day_opus": {"utilization": 5}, "seven_day_oauth_apps": None})
    assert [w["label"] for w in windows] == ["5-hour session", "Weekly", "Weekly · Opus"]


def test_spend_structured_and_legacy():
    spend = usage.normalize_spend({"spend": {"enabled": True, "percent": 25, "severity": "warning",
                                             "used": {"amount_minor": 500, "currency": "USD", "exponent": 2},
                                             "limit": {"amount_minor": 2000, "currency": "USD", "exponent": 2}}})
    assert spend == {"used": "USD 5.00", "limit": "USD 20.00", "percent": 25, "level": "warn"}
    legacy = usage.normalize_spend({"extra_usage": {"is_enabled": True, "used_credits": 150, "monthly_limit": 1000,
                                                    "utilization": 15.2}})
    assert legacy == {"used": "1.50", "limit": "10.00", "percent": 15, "level": "ok"}
    assert usage.normalize_spend({}) is None


def test_next_utc_reset():
    now = datetime(2026, 10, 21, 15, tzinfo=timezone.utc).timestamp()  # a Wednesday
    assert usage.next_utc_reset("daily", now) == datetime(2026, 10, 22, tzinfo=timezone.utc).timestamp()
    assert usage.next_utc_reset("weekly", now) == datetime(2026, 10, 26, tzinfo=timezone.utc).timestamp()
    assert usage.next_utc_reset("monthly", now) == datetime(2026, 11, 1, tzinfo=timezone.utc).timestamp()
    dec = datetime(2026, 12, 5, tzinfo=timezone.utc).timestamp()
    assert usage.next_utc_reset("monthly", dec) == datetime(2027, 1, 1, tzinfo=timezone.utc).timestamp()
    assert usage.next_utc_reset(None, now) is None


def test_openrouter_budget_spend_and_credits():
    result = usage.normalize_openrouter(
        {"usage_daily": 0.94, "usage_weekly": 4.31, "usage_monthly": 14.82, "is_free_tier": False,
         "budgets": [{"scope": "api_key", "reset_interval": "monthly", "spend_usd": 10, "limit_usd": 40,
                      "remaining_usd": 30}]},
        {"total_credits": 20, "total_usage": 20})
    budget, credits = result["windows"]
    assert budget["label"] == "Key budget (monthly)" and budget["utilization"] == 25
    assert budget["detail"] == "$10.00 of $40.00" and budget["api_level"] == "ok"
    assert credits["utilization"] == 100 and credits["api_level"] == "crit"
    assert result["balance"] == 0 and result["tier"] == "Pay as you go"
    assert result["spent"] == [("Today", "$0.94"), ("This week", "$4.31"), ("This month", "$14.82")]


def test_openrouter_key_limit_fallback():
    result = usage.normalize_openrouter({"limit": 10, "limit_remaining": 0, "usage": 10})
    (w,) = result["windows"]
    assert w["utilization"] == 100 and w["api_level"] == "crit"
    assert result["spent"] == [("In all", "$10.00")]


def test_fetch_claude_signed_out(tmp_path):
    with pytest.raises(usage.SignedOut):
        usage.fetch_claude({"label": "C", "config_dir": tmp_path})


def test_fetch_claude_with_credentials(tmp_path, monkeypatch):
    (tmp_path / ".credentials.json").write_text(json.dumps(
        {"claudeAiOauth": {"accessToken": "tok", "subscriptionType": "max"}}))
    seen = {}

    def fake(url, headers, timeout=15):
        seen.update(url=url, headers=headers)
        return {"limits": [{"kind": "session", "group": "session", "percent": 50}]}
    monkeypatch.setattr(usage, "http_get", fake)
    result = usage.fetch_claude({"label": "C", "config_dir": tmp_path})
    assert seen["url"] == usage.USAGE_URL and seen["headers"]["Authorization"] == "Bearer tok"
    assert seen["headers"]["anthropic-beta"] == "oauth-2025-04-20"
    assert result["plan"] == "Max plan" and result["windows"][0]["utilization"] == 50


def test_fetch_claude_explains_401(tmp_path, monkeypatch):
    (tmp_path / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {"accessToken": "tok"}}))

    def fake(url, headers, timeout=15):
        raise usage.UsageError("HTTP 401", 401)
    monkeypatch.setattr(usage, "http_get", fake)
    with pytest.raises(usage.UsageError, match="expired"):
        usage.fetch_claude({"label": "C", "config_dir": tmp_path})


def test_fetch_openrouter(monkeypatch):
    with pytest.raises(usage.SignedOut):
        usage.fetch_openrouter({"label": "OR"})

    def fake(url, headers, timeout=15):
        if url == usage.CREDITS_URL:
            raise usage.UsageError("HTTP 403", 403)
        return {"data": {"usage": 2.5}}
    monkeypatch.setattr(usage, "http_get", fake)
    result = usage.fetch_openrouter({"label": "OR", "api_key": "a", "management_key": "m"})
    assert result["spent"] == [("In all", "$2.50")]
    assert "not a management key" in result["note"]


def test_normalize_agy_and_fetch(tmp_path, monkeypatch):
    assert usage.parse_window_seconds("5h") == 5 * 3600
    assert usage.parse_window_seconds("7d") == 7 * 86400
    assert usage.agy_tier_label("g1-pro-tier") == "Google AI Pro"
    assert usage.agy_tier_label("g1-ultra-tier") == "Google AI Ultra"

    quota = {"groups": [{"displayName": "Models", "buckets": [
        {"bucketId": "pro", "displayName": "Gemini 3.1 Pro", "window": "5h", "remainingFraction": 0.75,
         "remainingAmount": 120, "resetTime": "2026-10-21T23:00:00Z"},
    ]}]}
    assist = {"paidTier": {"id": "g1-pro-tier", "name": "Google AI Pro",
                           "availableCredits": [{"creditAmount": 500}]}}
    res = usage.normalize_agy(quota, assist)
    assert res["plan"] == "Google AI Pro"
    assert res["credits"] == 500
    assert res["note"] == "Google AI credits: 500 remaining"
    assert len(res["windows"]) == 1
    assert res["windows"][0]["utilization"] == 25.0
    assert res["windows"][0]["detail"] == "120 left"

    (tmp_path / "antigravity-oauth-token").write_text(json.dumps({"token": {"access_token": "gtok"}}))

    def fake_post(url, body, headers, timeout=15):
        if "loadCodeAssist" in url:
            return assist
        return quota
    monkeypatch.setattr(usage, "http_post", fake_post)
    fetched = usage.fetch_agy({"id": "agy", "label": "Google AI", "config_dir": tmp_path})
    assert fetched["plan"] == "Google AI Pro"
    assert fetched["windows"][0]["utilization"] == 25.0

    # When HTTP fails (e.g. 403 on standalone consumer accounts), fall back to `agy -p /usage`.
    def fail_post(url, body, headers, timeout=15):
        raise usage.UsageError("HTTP 403", 403)
    monkeypatch.setattr(usage, "http_post", fail_post)
    monkeypatch.setattr(usage, "_run_agy_cli", lambda cmd, d=None: {"command": {"name": "usage", "data": quota}} if cmd == "/usage" else None)
    fallback = usage.fetch_agy({"id": "agy", "label": "Google AI", "config_dir": tmp_path})
    assert fallback["windows"][0]["utilization"] == 25.0



def test_an_expired_agy_token_goes_to_agy_itself(tmp_path, monkeypatch):
    """Quota carries no Google OAuth client: an expired token is never refreshed here, `agy` does it."""
    quota = {"groups": [{"displayName": "Models", "buckets": [
        {"bucketId": "pro", "displayName": "Gemini 3.1 Pro", "window": "5h", "remainingFraction": 0.5}]}]}
    (tmp_path / "antigravity-oauth-token").write_text(json.dumps({"token": {
        "access_token": "old", "refresh_token": "r", "expiry": "2020-01-01T00:00:00Z"}}))
    posted = []
    monkeypatch.setattr(usage, "http_post", lambda url, *a, **k: posted.append(url) or {})
    monkeypatch.setattr(usage, "_run_agy_cli",
                        lambda cmd, d=None: {"command": {"name": "usage", "data": quota}} if cmd == "/usage" else None)
    fetched = usage.fetch_agy({"id": "agy", "label": "Google AI", "config_dir": tmp_path})
    assert posted == [] and fetched["windows"][0]["utilization"] == 50.0
    assert not hasattr(usage, "AGY_CLIENT_SECRET")
