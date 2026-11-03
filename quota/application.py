"""Quota as a GNOME app: model usage and logs in one window. GTK."""
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gdk, Gio, GLib, Gtk  # noqa: E402

from .settings import DEVEL  # noqa: E402
from .window import Window  # noqa: E402

APP_ID = "io.github._4ndr3lu15.Quota"
VERSION = "0.2"
DATA = Path(__file__).resolve().parent.parent / "data"

# the other Monolito apps, by link (never by import): Atelier launches them
LINKS = tuple((f"Open {name}", f"atelier://launch/{name}") for name in ("Atelier", "MINITRON", "Tasks", "Harness"))

SHORTCUTS = (
    ("Quota", (
        ("Refresh", "<Control>r"),
        ("Show usage", "<Control>1"),
        ("Show logs", "<Control>2"),
    )),
    ("General", (
        ("Keyboard shortcuts", "<Control>question"),
        ("Close the window", "<Control>w"),
        ("Quit", "<Control>q"),
    )),
)


class Application(Adw.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID + ".Devel" if DEVEL else APP_ID,
                         flags=Gio.ApplicationFlags.DEFAULT_FLAGS)

    def do_startup(self):
        Adw.Application.do_startup(self)
        GLib.set_application_name("Quota")
        display = Gdk.Display.get_default()
        Gtk.IconTheme.get_for_display(display).add_search_path(str(DATA / "icons"))
        Gtk.Window.set_default_icon_name(APP_ID)
        css = Gtk.CssProvider()
        css.load_from_path(str(DATA / "style.css"))
        Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        for name, callback in (("quit", self._quit), ("about", self._about), ("shortcuts", self._shortcuts),
                               ("close", self._close)):
            action = Gio.SimpleAction(name=name)
            action.connect("activate", lambda _a, _p, cb=callback: cb())
            self.add_action(action)
        link = Gio.SimpleAction(name="open-link", parameter_type=GLib.VariantType("s"))
        link.connect("activate", lambda _a, uri: self.open_link(uri.get_string()))
        self.add_action(link)
        for action, accels in (("app.quit", ["<Control>q"]), ("app.close", ["<Control>w"]),
                               ("app.shortcuts", ["<Control>question"]), ("win.refresh", ["<Control>r", "F5"]),
                               ("win.show-usage", ["<Control>1"]), ("win.show-logs", ["<Control>2"])):
            self.set_accels_for_action(action, accels)

    def do_activate(self):
        window = self.get_active_window() or Window(self)
        window.present()

    def main_menu(self) -> Gio.Menu:
        menu = Gio.Menu()
        apps = Gio.Menu()
        for label, uri in LINKS:
            item = Gio.MenuItem.new(label, None)
            item.set_action_and_target_value("app.open-link", GLib.Variant("s", uri))
            apps.append_item(item)
        menu.append_section(None, apps)
        general = Gio.Menu()
        general.append("Refresh", "win.refresh")
        general.append("Keyboard shortcuts", "app.shortcuts")
        general.append("About Quota", "app.about")
        menu.append_section(None, general)
        return menu

    def open_link(self, uri: str):
        """`xdg-open atelier://launch/<Name>`: Atelier owns the scheme and starts the app."""
        window = self.get_active_window()
        try:
            proc = Gio.Subprocess.new(["xdg-open", uri], Gio.SubprocessFlags.STDOUT_SILENCE |
                                      Gio.SubprocessFlags.STDERR_SILENCE)
        except GLib.Error:
            proc = None

        def failed():
            if window:
                window.toast("Could not open Atelier. Install it, then try again")
        if proc is None:
            failed()
            return

        def done(source, result):
            try:
                ok = source.wait_check_finish(result)
            except GLib.Error:
                ok = False
            if not ok:
                failed()
        proc.wait_check_async(None, done)

    def _quit(self):
        for window in self.get_windows():
            window.close()
        self.quit()

    def _close(self):
        window = self.get_active_window()
        if window:
            window.close()

    def _about(self):
        Adw.AboutDialog(application_name="Quota", application_icon=APP_ID, developer_name="André Luís",
                        version=VERSION, website="https://github.com/4ndr3lu15/Quota",
                        comments="How much of your AI plans is left, and what each model call has cost. "
                                 "The Monolito mark in the top bar says the same at a glance.",
                        license_type=Gtk.License.GPL_2_0).present(self.get_active_window())

    def _shortcuts(self):
        dialog = Adw.ShortcutsDialog()
        for title, items in SHORTCUTS:
            section = Adw.ShortcutsSection(title=title)
            for name, accel in items:
                section.add(Adw.ShortcutsItem(title=name, accelerator=accel))
            dialog.add(section)
        dialog.present(self.get_active_window())


def main():
    return Application().run(sys.argv)
