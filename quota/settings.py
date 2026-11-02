"""A small JSON file of preferences, under ~/.config/quota while running from source. No GTK."""
import json
import os
from pathlib import Path

DEVEL = os.environ.get("QUOTA_DEVEL") == "1"
DEFAULTS = {"page": "usage"}


def settings_path() -> Path:
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / ("quota-devel" if DEVEL else "quota") / "settings.json"


def load() -> dict:
    try:
        stored = json.loads(settings_path().read_text())
    except (OSError, ValueError):
        stored = {}
    return {**DEFAULTS, **(stored if isinstance(stored, dict) else {})}


def save(settings: dict):
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings, indent=2))
    tmp.replace(path)
