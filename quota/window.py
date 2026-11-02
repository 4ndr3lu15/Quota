"""Quota's window: Usage (Claude limits, OpenRouter spend, cost per day) and Logs (model calls). GTK.

The data comes from the GTK-free modules: accounts (which accounts), usage (fetch and shape),
status (the one state), logs (MINITRON's records). Fetching runs in worker threads; the window only
renders what they hand back, so it never blocks.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gio, GLib, GObject, Gtk  # noqa: E402

from . import accounts, logs, settings, status, usage  # noqa: E402

REFRESH_SECONDS = 300
LOG_DAYS = 30
SPEND_DAYS = 14
TURNS_PER_GROUP = 50
MARK_ICON = "quota-monolito-symbolic"


def find_accounts():
    """(claude, openrouter, agy) account lists. Blocking (keyring): runs in a worker thread.
    The screenshot tool replaces it with sample accounts."""
    gsettings = accounts.extension_settings()
    return (accounts.claude_accounts(gsettings), accounts.openrouter_accounts(gsettings),
            accounts.agy_accounts(gsettings))


def fetch(kind: str, account: dict):
    """(result, data): ("ok", snapshot) | ("signed-out", message) | ("error", message)."""
    try:
        if kind == "claude":
            return "ok", usage.fetch_claude(account)
        if kind == "agy":
            from .keys import lookup
            return "ok", usage.fetch_agy(account, lookup=lookup)
        return "ok", usage.fetch_openrouter(account)
    except usage.SignedOut as error:
        return "signed-out", str(error)
    except usage.UsageError as error:
        return "error", str(error)
    except Exception as error:  # noqa: BLE001  a payload of an unexpected shape: say so, keep going
        return "error", f"Usage unavailable: {error}"


def mark_class(state: str) -> str:
    """The top bar's two colors: green while you can work, red when out; dim while unknown."""
    return {"out": "out", "unknown": ""}.get(state, "good")


def window_caption(w: dict, now: float) -> str:
    parts = [w.get("detail"), status.relative_reset(w.get("resets_at"), now)]
    if w.get("utilization") is not None and w.get("total_seconds"):
        parts.append(status.projection_note(w["utilization"], w.get("resets_at"), w["total_seconds"], now))
    text = " · ".join(p for p in parts if p)
    return text[:1].upper() + text[1:]


def _clear(box: Gtk.Box):
    while (child := box.get_first_child()) is not None:
        box.remove(child)


def _label(text: str, *classes) -> Gtk.Label:
    return Gtk.Label(label=text, valign=Gtk.Align.CENTER, css_classes=list(classes))


def _row(title: str, subtitle: str = "", suffix: Gtk.Widget | None = None, lines: int = 0) -> Adw.ActionRow:
    row = Adw.ActionRow(title=title, subtitle=subtitle, use_markup=False, title_lines=lines, subtitle_lines=lines)
    if suffix is not None:
        row.add_suffix(suffix)
    return row


def _scrolled(child: Gtk.Widget) -> Gtk.ScrolledWindow:
    clamp = Adw.Clamp(maximum_size=720, tightening_threshold=560, child=child)
    return Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER, child=clamp, vexpand=True)


def _page_box() -> Gtk.Box:
    return Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24, margin_top=24, margin_bottom=36,
                   margin_start=12, margin_end=12)


class Window(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Quota", default_width=760, default_height=820,
                         width_request=360, height_request=294)
        self.settings = settings.load()
        self.claude: list[dict] = []
        self.agy: list[dict] = []
        self.router: list[dict] = []
        self.results: dict[str, tuple | None] = {}
        self.days: list[dict] = []
        self.days_loaded = False
        self.updated_at: float | None = None
        self.busy = False
        self._generation = 0

        self._toasts = Adw.ToastOverlay()
        view = Adw.ToolbarView()
        header = Adw.HeaderBar()
        self._refresh_button = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Refresh",
                                          action_name="win.refresh")
        header.pack_start(self._refresh_button)
        header.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", tooltip_text="Main menu",
                                       menu_model=app.main_menu(), primary=True))

        self.stack = Adw.ViewStack(vexpand=True)
        self._usage_box = _page_box()
        self.stack.add_titled_with_icon(_scrolled(self._usage_box), "usage", "Usage", "power-profile-balanced-symbolic")
        self._logs_box = _page_box()
        self._logs_stack = Gtk.Stack()
        self._logs_stack.add_named(_scrolled(self._logs_box), "list")
        self._logs_stack.add_named(Adw.StatusPage(icon_name="document-open-recent-symbolic", title="No model calls yet",
                                                  description="MINITRON's model calls appear here, by day, "
                                                              "with what each one cost"), "empty")
        self._logs_stack.add_named(Adw.Spinner(halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER,
                                               width_request=32, height_request=32), "loading")
        self._logs_stack.set_visible_child_name("loading")
        self.stack.add_titled_with_icon(self._logs_stack, "logs", "Logs", "view-list-symbolic")

        switcher = Adw.ViewSwitcher(stack=self.stack, policy=Adw.ViewSwitcherPolicy.WIDE)
        header.set_title_widget(switcher)
        bar = Adw.ViewSwitcherBar(stack=self.stack)
        view.add_top_bar(header)
        view.add_bottom_bar(bar)
        view.set_content(self.stack)
        self._toasts.set_child(view)
        self.set_content(self._toasts)

        narrow = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 550sp"))
        narrow.add_setter(header, "title-widget", GObject.Value(Gtk.Widget, None))
        narrow.add_setter(bar, "reveal", True)
        self.add_breakpoint(narrow)

        for name, callback in (("refresh", self.refresh), ("show-usage", lambda: self.show("usage")),
                               ("show-logs", lambda: self.show("logs"))):
            action = Gio.SimpleAction(name=name)
            action.connect("activate", lambda _a, _p, cb=callback: cb())
            self.add_action(action)

        self.stack.set_visible_child_name(self.settings.get("page") if self.settings.get("page") in ("usage", "logs")
                                          else "usage")
        self.stack.connect("notify::visible-child-name", self._on_page)

        self._watch_logs()
        self.render_usage()
        self.refresh()
        self._timers = [GLib.timeout_add_seconds(REFRESH_SECONDS, self._auto_refresh),
                        GLib.timeout_add_seconds(60, self._tick)]
        self.connect("close-request", self._on_close)

    # ---- actions ----

    def show(self, page: str):
        self.stack.set_visible_child_name(page)

    def toast(self, text: str):
        self._toasts.add_toast(Adw.Toast(title=text))

    def _on_page(self, stack, _pspec):
        self.settings["page"] = stack.get_visible_child_name()
        settings.save(self.settings)

    def _on_close(self, *_):
        for source in self._timers:
            GLib.source_remove(source)
        self._timers = []
        if self._monitor:
            self._monitor.cancel()
        return False

    def _auto_refresh(self):
        self.refresh()
        return GLib.SOURCE_CONTINUE

    def _tick(self):
        """The reset times and paces move with the clock."""
        self.render_usage()
        return GLib.SOURCE_CONTINUE

    def _open_uri(self, uri: str):
        Gtk.UriLauncher(uri=uri).launch(self, None, None)

    # ---- loading ----

    def refresh(self):
        if self.busy:
            return
        self.busy = True
        self._generation += 1
        generation = self._generation
        self._refresh_button.set_sensitive(False)
        threading.Thread(target=self._work, args=(generation,), daemon=True).start()

    def _work(self, generation):
        try:
            found = find_accounts()
            if len(found) == 3:
                claude, router, agy = found
            else:
                claude, router = found
                agy = []
        except Exception:  # noqa: BLE001  no settings, no keyring: show what is on disk
            claude, router, agy = accounts.claude_accounts(), [], accounts.agy_accounts()
        GLib.idle_add(self._got_accounts, generation, claude, router, agy)
        jobs = ([("claude", a) for a in claude] + [("agy", a) for a in agy]
                + [("openrouter", a) for a in router])
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(fetch, kind, a): (kind, a) for kind, a in jobs}
            for future, (kind, a) in futures.items():
                GLib.idle_add(self._got_result, generation, f"{kind}:{a['id']}", future.result())
        self._load_logs(generation)
        GLib.idle_add(self._done, generation)

    def _load_logs(self, generation=None):
        try:
            days = logs.load_days()
        except Exception:  # noqa: BLE001  an unreadable record: an empty log, not a crash
            days = []
        GLib.idle_add(self._got_days, days)

    def _got_accounts(self, generation, claude, router, agy=None):
        if generation != self._generation:
            return GLib.SOURCE_REMOVE
        self.claude, self.router, self.agy = claude, router, agy or []
        keys = ({f"claude:{a['id']}" for a in claude}
                | {f"agy:{a['id']}" for a in self.agy}
                | {f"openrouter:{a['id']}" for a in router})
        # keep the last answer on screen while the new one is on its way
        self.results = {k: self.results.get(k) for k in keys}
        self.render_usage()
        return GLib.SOURCE_REMOVE

    def _got_result(self, generation, key, result):
        if generation == self._generation:
            self.results[key] = result
            self.render_usage()
        return GLib.SOURCE_REMOVE

    def _got_days(self, days):
        self.days = days
        self.days_loaded = True
        self.render_usage()
        self.render_logs()
        return GLib.SOURCE_REMOVE

    def _done(self, generation):
        if generation == self._generation:
            self.busy = False
            self.updated_at = time.time()
            self._refresh_button.set_sensitive(True)
            self.render_usage()
        return GLib.SOURCE_REMOVE

    def _watch_logs(self):
        """Follow MINITRON's turn log, so a model call shows up without a refresh."""
        self._monitor = None
        self._logs_pending = False
        try:
            file = Gio.File.new_for_path(str(logs.data_dir() / "memory" / "turns.jsonl"))
            self._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, None)
        except GLib.Error:
            return
        self._monitor.connect("changed", self._on_log_changed)

    def _on_log_changed(self, *_):
        if self._logs_pending:
            return
        self._logs_pending = True

        def later():
            self._logs_pending = False
            threading.Thread(target=self._load_logs, daemon=True).start()
            return GLib.SOURCE_REMOVE
        GLib.timeout_add(800, later)

    # ---- the Usage page ----

    def sources(self) -> list[dict]:
        out = []
        for kind, items in (("claude", self.claude), ("agy", self.agy), ("openrouter", self.router)):
            for a in items:
                got = self.results.get(f"{kind}:{a['id']}")
                out.append({"kind": kind, "label": a["label"], "result": got[0] if got else None,
                            "windows": got[1].get("windows") if got and got[0] == "ok" else None})
        return out

    def render_usage(self):
        now = time.time()
        box = self._usage_box
        _clear(box)
        overall = status.overall_status(self.sources(), now)
        if not self.claude and not self.agy and not self.router:
            overall = {"state": "unknown", "text": "Checking usage…"} if self.busy else overall
        group = Adw.PreferencesGroup()
        mark = Gtk.Image(icon_name=MARK_ICON, pixel_size=32, css_classes=["quota-mark"])
        if mark_class(overall["state"]):
            mark.add_css_class(mark_class(overall["state"]))
        when = (f"Updated {datetime.fromtimestamp(self.updated_at):%H:%M}" if self.updated_at else "")
        row = _row(overall["text"], "Checking…" if self.busy else when)
        row.add_css_class("quota-status")
        row.add_prefix(mark)
        group.add(row)
        box.append(group)

        many = len(self.claude) > 1
        for a in self.claude:
            title = f"Claude · {a['label']}" if many else "Claude"
            box.append(self._account_group("claude", a, title, usage.CLAUDE_USAGE_PAGE, now))
        many_agy = len(self.agy) > 1
        for a in self.agy:
            title = f"Antigravity · {a['label']}" if many_agy else "Antigravity"
            box.append(self._account_group("agy", a, title, usage.AGY_PAGE, now))
        if self.router:
            many = len(self.router) > 1
            for a in self.router:
                title = f"OpenRouter · {a['label']}" if many else "OpenRouter"
                box.append(self._account_group("openrouter", a, title, usage.OPENROUTER_PAGE, now))
        elif self.claude or self.agy:
            group = Adw.PreferencesGroup(title="OpenRouter")
            group.add(_row("No OpenRouter key yet", "Add one in MINITRON's preferences or the extension's settings",
                           lines=2))
            box.append(group)
        box.append(self._spend_group())

    def _account_group(self, kind, account, title, page, now) -> Adw.PreferencesGroup:
        got = self.results.get(f"{kind}:{account['id']}")
        group = Adw.PreferencesGroup(title=title)
        link = Gtk.Button(icon_name="adw-external-link-symbolic", tooltip_text="Open usage page",
                          valign=Gtk.Align.CENTER, css_classes=["flat"])
        link.connect("clicked", lambda *_: self._open_uri(page))
        group.set_header_suffix(link)
        if got is None:
            group.add(_row("Checking usage…", suffix=Adw.Spinner()))
            return group
        result, data = got
        if result == "signed-out":
            group.add(_row("Not signed in" if kind in ("claude", "agy") else "No key", data, lines=2))
            return group
        if result == "error":
            row = _row("Usage unavailable", data, lines=2)
            row.add_prefix(Gtk.Image(icon_name="dialog-warning-symbolic", css_classes=["warning"]))
            group.add(row)
            return group
        if kind in ("claude", "agy"):
            group.set_description(data.get("plan") or None)
        else:
            tier = data.get("tier") or ""
            group.set_description(f"{tier} · MINITRON's key" if account.get("shared") else tier)
        for w in data.get("windows") or []:
            group.add(self._meter_row(w, now))
        spend = data.get("spend") if kind == "claude" else None
        if spend:
            text = f"{spend['used']} of {spend['limit']}" if spend.get("limit") else f"{spend['used']} spent"
            if spend.get("percent") is not None:
                group.add(self._meter_row({"label": "Extra usage", "utilization": spend["percent"],
                                           "api_level": spend.get("level"), "detail": text}, now))
            else:
                group.add(_row("Extra usage", text))
        for when, amount in data.get("spent") or []:
            group.add(_row(f"Spent {when.lower()}" if when != "In all" else "Spent in all",
                           suffix=_label(amount, "quota-cost")))
        if data.get("note"):
            group.add(_row(data["note"], lines=2))
        if kind in ("claude", "agy") and not data.get("windows") and not spend and not data.get("note"):
            group.add(_row("No limits reported"))
        return group

    def _meter_row(self, w: dict, now: float) -> Adw.ActionRow:
        util = w.get("utilization")
        known = isinstance(util, (int, float)) and util == util
        level = (status.judge_window(w, now) if known and w.get("total_seconds") else
                 status.max_level(status.util_level(util) if known else "ok", w.get("api_level") or "ok"))
        css = {"ok": [], "warn": ["warn"], "crit": ["crit"]}[level]
        suffix = Gtk.Box(spacing=12, valign=Gtk.Align.CENTER)
        bar = Gtk.LevelBar(min_value=0, max_value=100, value=min(100, util) if known else 0, width_request=120,
                           valign=Gtk.Align.CENTER)
        for name in ("quota-meter", *css):  # added, not replaced: Adwaita sizes the bar by "horizontal"
            bar.add_css_class(name)
        for name in ("low", "high", "full"):
            bar.remove_offset_value(name)
        suffix.append(bar)
        pct = _label(f"{round(util)}%" if known else "—", "quota-pct", "numeric", *css)
        pct.set_xalign(1)
        suffix.append(pct)
        return _row(w.get("label") or "", window_caption(w, now), suffix, lines=2)

    def _spend_group(self) -> Adw.PreferencesGroup:
        today = date.today()
        group = Adw.PreferencesGroup(title="Spend by day", description="What MINITRON's model calls cost")
        if not self.days_loaded:
            group.add(_row("Reading the logs…", suffix=Adw.Spinner()))
            return group
        totals = logs.summary(self.days, today)
        group.set_header_suffix(_label(f"{logs.format_cost(totals['week'])} this week", "dim-label", "quota-cost"))
        recent = [d for d in self.days if (today - d["date"]).days < SPEND_DAYS]
        if not recent:
            group.add(_row("No model calls in the last two weeks"))
            return group
        for d in recent:
            calls = f"{d['count']} call" + ("" if d["count"] == 1 else "s")
            row = _row(d["title"], calls, _label(logs.format_cost(d["total"]), "quota-cost"))
            row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
            row.set_activatable(True)
            row.connect("activated", lambda *_: self.show("logs"))
            group.add(row)
        return group

    # ---- the Logs page ----

    def render_logs(self):
        today = date.today()
        days = [d for d in self.days if (today - d["date"]).days < LOG_DAYS]
        if not days:
            self._logs_stack.set_visible_child_name("empty")
            return
        box = self._logs_box
        _clear(box)
        for d in days:
            calls = f"{d['count']} call" + ("" if d["count"] == 1 else "s")
            group = Adw.PreferencesGroup(title=d["title"], description=calls)
            group.set_header_suffix(_label(logs.format_cost(d["total"]), "quota-cost", "heading"))
            for g in d["groups"]:
                expander = Adw.ExpanderRow(title=g["model"], use_markup=False,
                                           subtitle=f"{g['provider']} · {len(g['turns'])} call"
                                                    + ("" if len(g["turns"]) == 1 else "s"))
                expander.add_suffix(_label(logs.format_cost(g["cost"]), "quota-cost"))
                for t in g["turns"][:TURNS_PER_GROUP]:
                    expander.add_row(self._turn_row(t))
                if len(g["turns"]) > TURNS_PER_GROUP:
                    expander.add_row(_row(f"{len(g['turns']) - TURNS_PER_GROUP} earlier calls not shown"))
                group.add(expander)
            if d["earlier"]:
                e = d["earlier"]
                group.add(_row("Before the log began", f"{e['provider']} · {e['model']}",
                               _label(logs.format_cost(e["cost"]), "quota-cost")))
            box.append(group)
        self._logs_stack.set_visible_child_name("list")

    def _turn_row(self, t: dict) -> Adw.ActionRow:
        parts = [f"{datetime.fromtimestamp(t['at']):%H:%M}"]
        if t.get("seconds"):
            parts.append(logs.format_seconds(t["seconds"]))
        if t.get("tokens"):
            parts.append(f"{logs.format_tokens(t['tokens'])} tokens of context")
        if t.get("error"):
            parts.append("failed")
        row = _row(t.get("prompt") or t.get("title") or "No prompt", " · ".join(parts),
                   _label(logs.format_cost(t.get("cost")), "quota-cost", "dim-label"), lines=1)
        row.set_tooltip_text(t.get("prompt") or None)
        return row
