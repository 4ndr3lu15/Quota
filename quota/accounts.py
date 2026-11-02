"""Which accounts to show: the same ones the extension watches. No GTK.

The extension keeps its account list in GSettings (`org.gnome.shell.extensions.quota`, compiled
next to it in src/schemas): `profiles` (Claude config folders) and `openrouter-accounts` (ids whose
keys sit in the keyring). The app reads that list when the schema is there; otherwise it finds the
Claude Code folders itself (`~/.claude`, `~/.claude-*`), like the extension's first run does.
OpenRouter keys come from the keyring: Quota's own entries, else the key MINITRON keeps.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_ID = "org.gnome.shell.extensions.quota"
UUID = "quota@4ndr3lu15.github.io"


def label_for_dir(name: str) -> str:
    """".claude" -> "Claude", ".claude-work" -> "Work", ".claude-my-team" -> "My Team"."""
    if name == ".claude":
        return "Claude"
    words = [w.capitalize() for w in name.removeprefix(".claude-").replace("_", "-").split("-") if w]
    return " ".join(words) or "Claude"


def discover_config_dirs(home: Path | None = None) -> list[dict]:
    """~/.claude and every ~/.claude-* folder that holds Claude Code credentials, ~/.claude first."""
    home = home or Path.home()
    found = [d for d in home.glob(".claude*") if d.is_dir() and (d.name == ".claude" or d.name.startswith(".claude-"))
             and (d / ".credentials.json").is_file()]
    found.sort(key=lambda d: (d.name != ".claude", d.name))
    return [{"id": d.name, "label": label_for_dir(d.name), "config_dir": d} for d in found]


def parse_profiles(text: str) -> list[dict]:
    try:
        items = json.loads(text)
    except (TypeError, ValueError):
        return []
    return [{"id": p.get("id") or p["configDir"], "label": p.get("label") or "Claude", "config_dir": Path(p["configDir"])}
            for p in items if isinstance(p, dict) and isinstance(p.get("configDir"), str) and p["configDir"]] \
        if isinstance(items, list) else []


def parse_openrouter_accounts(text: str) -> list[dict]:
    try:
        items = json.loads(text)
    except (TypeError, ValueError):
        return []
    return [{"id": a["id"], "label": str(a.get("label") or "OpenRouter")}
            for a in items if isinstance(a, dict) and isinstance(a.get("id"), str) and a["id"]] \
        if isinstance(items, list) else []


def parse_agy_accounts(text: str, home: Path | None = None) -> list[dict]:
    default_dir = (home or Path.home()) / ".gemini" / "antigravity-cli"
    try:
        items = json.loads(text)
    except (TypeError, ValueError):
        return []
    return [{"id": a["id"], "label": str(a.get("label") or "Google AI"),
             "config_dir": Path(a.get("configDir") or default_dir)}
            for a in items if isinstance(a, dict) and isinstance(a.get("id"), str) and a["id"]] \
        if isinstance(items, list) else []


def extension_settings():
    """The extension's Gio.Settings, or None when its schema is not compiled here."""
    from gi.repository import Gio
    for folder in (ROOT / "src" / "schemas",
                   Path.home() / ".local/share/gnome-shell/extensions" / UUID / "schemas"):
        if not (folder / "gschemas.compiled").is_file():
            continue
        try:
            source = Gio.SettingsSchemaSource.new_from_directory(str(folder), Gio.SettingsSchemaSource.get_default(),
                                                                 False)
        except Exception:  # noqa: BLE001  a broken compiled file: try the next one
            continue
        schema = source.lookup(SCHEMA_ID, False)
        if schema:
            return Gio.Settings.new_full(schema, None, None)
    return None


def claude_accounts(settings=None, home: Path | None = None) -> list[dict]:
    """[{id, label, config_dir, token?}]: the extension's profiles, or the folders found on disk."""
    profiles = parse_profiles(settings.get_string("profiles")) if settings else []
    if profiles:
        try:
            tokens = json.loads(settings.get_string("profile-tokens"))
        except ValueError:
            tokens = {}
        for p in profiles:
            token = (tokens.get(p["id"]) or {}) if isinstance(tokens, dict) else {}
            if token.get("accessToken"):
                p["token"] = token["accessToken"]
        return profiles
    return discover_config_dirs(home) or [{"id": ".claude", "label": "Claude",
                                           "config_dir": (home or Path.home()) / ".claude"}]


def openrouter_accounts(settings=None, lookup=None) -> list[dict]:
    """[{id, label, api_key, management_key, shared}]. lookup(schema, attributes) reads the keyring
    (keys.lookup by default); blocking, so call it from a worker thread."""
    if lookup is None:
        from .keys import lookup
    own = parse_openrouter_accounts(settings.get_string("openrouter-accounts")) if settings else []
    minitron = None
    out = []
    for account in own:
        api = lookup("quota", {"account": account["id"], "kind": "api"})
        mgmt = lookup("quota", {"account": account["id"], "kind": "management"})
        if not api and not mgmt:
            minitron = minitron if minitron is not None else (lookup("minitron", {"provider": "openrouter"}) or "")
            api = minitron or None
        out.append({**account, "api_key": api, "management_key": mgmt, "shared": False})
    if not own:
        key = lookup("minitron", {"provider": "openrouter"})
        if key:
            out.append({"id": "minitron", "label": "MINITRON", "api_key": key, "management_key": None, "shared": True})
    return out


def agy_accounts(settings=None, home: Path | None = None) -> list[dict]:
    """[{id, label, config_dir, token?}]: Antigravity / Google AI accounts."""
    home = home or Path.home()
    default_dir = home / ".gemini" / "antigravity-cli"
    accounts = parse_agy_accounts(settings.get_string("agy-accounts"), home) if settings else []
    if accounts:
        try:
            tokens = json.loads(settings.get_string("profile-tokens"))
        except ValueError:
            tokens = {}
        for a in accounts:
            token = (tokens.get(a["id"]) or {}) if isinstance(tokens, dict) else {}
            if token.get("accessToken"):
                a["token"] = token["accessToken"]
        return accounts
    return [{"id": "antigravity", "label": "Google AI", "config_dir": default_dir}]
