"""Which accounts the app shows, from the extension's settings or what is on disk."""
import json

from quota import accounts


class FakeSettings:
    def __init__(self, **values):
        self.values = values

    def get_string(self, key):
        return self.values.get(key, "")


def test_label_for_dir():
    assert accounts.label_for_dir(".claude") == "Claude"
    assert accounts.label_for_dir(".claude-work") == "Work"
    assert accounts.label_for_dir(".claude-my_team") == "My Team"


def test_discover_config_dirs(tmp_path):
    for name in (".claude-work", ".claude", ".claude-empty", ".clauderc"):
        (tmp_path / name).mkdir()
    for name in (".claude-work", ".claude", ".clauderc"):
        (tmp_path / name / ".credentials.json").write_text("{}")
    found = accounts.discover_config_dirs(tmp_path)
    assert [a["id"] for a in found] == [".claude", ".claude-work"]


def test_parse_profiles_and_openrouter():
    assert accounts.parse_profiles("not json") == []
    assert accounts.parse_profiles('{"a": 1}') == []
    profiles = accounts.parse_profiles(json.dumps([{"id": "w", "label": "Work", "configDir": "/x"}, {"label": "bad"}]))
    assert [(p["id"], p["label"], str(p["config_dir"])) for p in profiles] == [("w", "Work", "/x")]
    assert accounts.parse_openrouter_accounts(json.dumps([{"id": "a"}, {"id": ""}, 3])) == \
        [{"id": "a", "label": "OpenRouter"}]


def test_claude_accounts_from_settings_with_token():
    settings = FakeSettings(profiles=json.dumps([{"id": "w", "label": "Work", "configDir": "/x"}]),
                            **{"profile-tokens": json.dumps({"w": {"accessToken": "t"}})})
    (p,) = accounts.claude_accounts(settings)
    assert p["token"] == "t"


def test_claude_accounts_fallback(tmp_path):
    (p,) = accounts.claude_accounts(None, tmp_path)
    assert p["id"] == ".claude" and p["config_dir"] == tmp_path / ".claude"


def test_openrouter_uses_minitron_key():
    keys = {("minitron", "openrouter"): "mk"}

    def lookup(schema, attrs):
        return keys.get((schema, attrs.get("provider") or (attrs["account"], attrs["kind"])))
    (shared,) = accounts.openrouter_accounts(None, lookup)
    assert shared == {"id": "minitron", "label": "MINITRON", "api_key": "mk", "management_key": None, "shared": True}
    # an own account with no key borrows MINITRON's; one with keys keeps its own
    keys[("quota", ("b", "api"))] = "own"
    settings = FakeSettings(**{"openrouter-accounts": json.dumps([{"id": "a"}, {"id": "b", "label": "Team"}])})
    a, b = accounts.openrouter_accounts(settings, lookup)
    assert a["api_key"] == "mk" and not a["shared"]
    assert b["api_key"] == "own" and b["label"] == "Team"


def test_no_keys_no_accounts():
    assert accounts.openrouter_accounts(None, lambda *_: None) == []


def test_agy_accounts(tmp_path):
    (a,) = accounts.agy_accounts(None, tmp_path)
    assert a["id"] == "antigravity" and a["label"] == "Google AI"
    settings = FakeSettings(**{"agy-accounts": json.dumps([{"id": "g1", "label": "Pro", "configDir": "/g"}]),
                               "profile-tokens": json.dumps({"g1": {"accessToken": "gt"}})})
    (g,) = accounts.agy_accounts(settings, tmp_path)
    assert g["id"] == "g1" and g["label"] == "Pro" and g["token"] == "gt"
