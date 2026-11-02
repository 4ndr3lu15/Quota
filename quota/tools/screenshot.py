"""Render Quota's window to PNGs: Usage and Logs, light and dark, narrow, and out of tokens.

Run it inside a headless compositor so nothing shows on screen, on its own bus. It always works on
sample accounts and a sample MINITRON folder in a fresh temp dir, and never goes online:

    dbus-run-session -- mutter --headless --wayland --no-x11 --virtual-monitor 1280x900 \\
        -- python3 quota/tools/screenshot.py .screenshots
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

SAMPLE = Path(tempfile.mkdtemp(prefix="quota-sample-"))
os.environ["XDG_DATA_HOME"] = str(SAMPLE / "data")
os.environ["XDG_CONFIG_HOME"] = str(SAMPLE / "config")

import gi  # noqa: E402

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, GLib, Gtk  # noqa: E402

from quota import usage, window  # noqa: E402
from quota.application import Application  # noqa: E402

OUT = Path(next((a for a in sys.argv[1:] if not a.startswith("--")), ".screenshots"))
NOW = time.time()
SCENE = {"session": 42, "weekly": 61}


def iso(seconds_from_now):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW + seconds_from_now))


def seed():
    claude = SAMPLE / "claude"
    claude.mkdir()
    (claude / ".credentials.json").write_text(json.dumps(
        {"claudeAiOauth": {"accessToken": "sample", "subscriptionType": "max"}}))
    minitron = SAMPLE / "data" / "minitron"
    (minitron / "memory").mkdir(parents=True)
    (minitron / "sessions").mkdir()
    (minitron / "sessions" / "s1.json").write_text(json.dumps(
        {"id": "s1", "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5", "title": "Quota",
         "usage": {"window": 200000}}))
    (minitron / "sessions" / "s2.json").write_text(json.dumps(
        {"id": "s2", "provider": "claude-code", "model": "", "title": "Tasks", "usage": {"window": 200000}}))
    prompts = ["Turn Quota into a GNOME app with Usage and Logs pages", "Why is the top bar mark gray?",
               "Write tests for the logs module", "Summarise yesterday's notes", "Draw the Monolito icon in green",
               "Fix the narrow layout of Tasks", "What did OpenRouter cost this week?"]
    lines = []
    for i in range(18):
        at = NOW - i * 3 * 3600 - 600
        session = "s1" if i % 3 else "s2"
        lines.append(json.dumps({"at": at, "session": session, "provider": "openrouter" if session == "s1" else
                                 "claude-code", "prompt": prompts[i % len(prompts)], "seconds": 8 + i * 7,
                                 "context": 0.05 + i * 0.03, "cost": round(0.012 + (i % 5) * 0.031, 3)
                                 if session == "s1" else 0}))
    (minitron / "memory" / "turns.jsonl").write_text("\n".join(lines) + "\n")
    return claude


CLAUDE_DIR = seed()


def find_accounts():
    return ([{"id": "personal", "label": "Personal", "config_dir": CLAUDE_DIR}],
            [{"id": "minitron", "label": "MINITRON", "api_key": "sample", "management_key": None, "shared": True}])


def http_get(url, headers, timeout=15):
    time.sleep(0.2)
    if url == usage.USAGE_URL:
        return {"limits": [
            {"kind": "session", "group": "session", "percent": SCENE["session"], "severity": "normal",
             "resets_at": iso(2 * 3600 + 900)},
            {"kind": "weekly_all", "group": "weekly", "percent": SCENE["weekly"], "severity": "normal",
             "resets_at": iso(2 * 86400 + 3 * 3600)},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 23, "severity": "normal",
             "resets_at": iso(2 * 86400 + 3 * 3600), "scope": {"model": {"display_name": "Fable"}}}]}
    if url == usage.KEY_URL:
        return {"data": {"label": "MINITRON", "usage": 14.82, "usage_daily": 0.94, "usage_weekly": 4.31,
                         "usage_monthly": 14.82, "is_free_tier": False, "budgets": [
                             {"scope": "api_key", "reset_interval": "monthly", "spend_usd": 14.82,
                              "limit_usd": 40, "remaining_usd": 25.18}]}}
    raise usage.UsageError("offline")


window.find_accounts = find_accounts
usage.http_get = http_get

app = Application()
steps = []


def save_widget(widget, name):
    snap = Gtk.Snapshot()
    Gtk.WidgetPaintable(widget=widget).snapshot(snap, widget.get_width(), widget.get_height())
    node = snap.to_node()
    if node is not None:
        widget.get_native().get_renderer().render_texture(node, None).save_to_png(str(OUT / f"{name}.png"))
        print("saved", OUT / f"{name}.png")


def plan():
    OUT.mkdir(parents=True, exist_ok=True)
    win = app.get_active_window()
    style = Adw.StyleManager.get_default()

    def size(w, h):
        return lambda: win.set_default_size(w, h)

    def expand_first_log():
        child = win._logs_box.get_first_child()
        # the first day's first expander row
        listbox = next(w for w in walk(child) if isinstance(w, Adw.ExpanderRow))
        listbox.set_expanded(True)

    def out_of_tokens():
        SCENE["session"] = 100
        win.refresh()

    steps.append(size(760, 900))
    for scheme, tag in [(Adw.ColorScheme.FORCE_LIGHT, "light"), (Adw.ColorScheme.FORCE_DARK, "dark")]:
        steps.append(lambda s=scheme: style.set_color_scheme(s))
        steps.append(lambda: win.show("usage"))
        steps.append(lambda t=tag: save_widget(win, f"usage-{t}"))
        steps.append(lambda: win.show("logs"))
        steps.append(lambda t=tag: save_widget(win, f"logs-{t}"))
    steps.append(expand_first_log)
    steps.append(lambda: save_widget(win, "logs-expanded-dark"))
    steps.append(lambda: win.show("usage"))
    steps.append(size(360, 760))
    steps.append(lambda: None)
    steps.append(lambda: save_widget(win, "usage-narrow-dark"))
    steps.append(size(760, 900))
    steps.append(out_of_tokens)
    steps.append(lambda: None)
    steps.append(lambda: save_widget(win, "usage-out-dark"))
    steps.append(lambda: style.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT))
    steps.append(lambda: save_widget(win, "usage-out-light"))
    steps.append(lambda: os._exit(0))
    GLib.timeout_add(700, tick)
    return GLib.SOURCE_REMOVE


def walk(widget):
    yield widget
    child = widget.get_first_child()
    while child is not None:
        yield from walk(child)
        child = child.get_next_sibling()


def tick():
    if steps:
        steps.pop(0)()
    return GLib.SOURCE_CONTINUE


app.connect("activate", lambda *_: GLib.timeout_add(1500, plan))
GLib.timeout_add_seconds(120, lambda: os._exit(1))
app.run([sys.argv[0]])
