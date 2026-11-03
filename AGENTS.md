# Quota (GNOME app and top bar extension)

Quota shows how much of your AI plans you have used, from the GNOME top bar:
one Monolito mark (an obelisk) whose color says whether you can work, and a
menu with every account at once, Claude usage limits and OpenRouter spend,
budgets and balance; and an app (`quota/`, Python, GTK 4 + libadwaita) for a
closer look: a Usage page and a Logs page of model calls. It looks and
behaves like part of GNOME.
UUID `quota@4ndr3lu15.github.io`, schema `org.gnome.shell.extensions.quota`.

Details (layout, the app, data sources, release, maintenance, the headless Shell test) are in `docs/NOTES.md`,
not imported: read the section for what you change.

## Design rules

- Follow the shell, do not restyle it. The menu is built from plain
  `PopupMenu` items: a labelled `PopupSeparatorMenuItem` as each section's
  header (the shell's own style), `PopupBaseMenuItem`s for the status line
  and the meters, plain `PopupMenuItem`s for the actions; text uses the
  theme's colors, secondary text is the same color at `DIM_OPACITY`; meters
  fill with `-st-accent-color`.
- The top bar shows only the Monolito mark: a slender obelisk (shaft
  tapering to a pyramid tip, like the Washington Monument), flat, one
  silhouette on the 16 px grid. `icons/monolito-symbolic.svg` and
  `lib/mark.js` (Cairo) hold the same outline; keep them in sync. It is drawn
  solid: a fill-from-the-bottom with the 5-hour usage was tried and dropped,
  because at low usage the faint body read dimmer than the gray "unknown".
- The mark has two colors: green while you can work (`quota-good`, and
  also `quota-tight` and `quota-critical`, whose pace is told in words in
  the status line) and red when out of tokens (`quota-out`), in the top bar
  and beside the menu's status line; `unknown` is the theme's text color at
  half strength. The app's mark uses the same rule with libadwaita's
  `@success_color` / `@error_color`. Bright tones in `stylesheet.css` (dark
  style, and fallback), darker ones in `stylesheet-light.css` (GNOME 51's top bar is light in the
  light style). Both variant files `@import` `stylesheet.css`, and
  `stylesheet-dark.css` exists only so the shell reloads the styles when the
  style switches (it reloads variant files only). The meters keep their
  `quota-warn` / `quota-crit` mid-tones.
- Display-only rows are `reactive: false`, which the shell styles as
  insensitive; they carry `quota-item`, whose stylesheet rule keeps the
  normal text color.
- Few settings (GNOME HIG): placement, refresh interval, shortcut, accounts.
  Nothing about what the top bar shows; no style editor.
- Header capitalization for titles and menu items ("Open Usage Page",
  "Refresh Interval", "Add an OpenRouter Key…"), sentence case for
  subtitles, captions and the status line.

## Conventions

- All file I/O must stay cheap and non-blocking; never parse large transcripts on
  the shell main loop (it janks the compositor). Network calls use libsoup async,
  and file reads/writes use the `_async` GIO variants — the review tooling
  rejects synchronous `load_contents()` / `replace_contents()` in shell code.
- Keep `src/lib/usageClient.js` and `src/lib/usageModel.js` free of
  `resource:///org/gnome/shell` imports so they stay runnable under plain `gjs`
  (both are also imported by `prefs.js` or the tools).

### Never pin a GI version

Import GI libraries unversioned — `import Soup from 'gi://Soup'`, never
`gi://Soup?version=3.0`, and no `imports.gi.versions` module either. Reviewers
have asked for this twice now: once to delete a `lib/versions.js` that set
`imports.gi.versions.Soup`, and again (rejecting 1.4.1) for the inline
`?version=` spelling of the same thing. It is *not* in the written review
guidelines, so it will not show up in the checklist — it comes from the human
reviewer.

The reason it matters: a pin is an assertion, not a preference. If the host
process has already loaded another version, the import is a fatal error —
`Error: Version 3.0 of GI module Soup already loaded, cannot load version 2.4`.
GNOME Shell loads libsoup itself, so a pin can only match (redundant) or
mismatch (breaks the extension outright on some future GNOME release). There is
no upside inside the shell.

The tempting reason to add one: on a machine with both the Soup 2.4 and 3.0
typelibs, plain `gjs` warns "Requiring Soup but it has 2 versions available".
That warning only appears in standalone `gjs` (i.e. `tools/poll.js`), where
nothing has preloaded Soup, and it is harmless — GJS still resolves to 3.0.
Inside the shell and prefs processes Soup 3 is already loaded. Do not "fix" it
with a pin.

### Teardown rules

extensions.gnome.org runs a static analysis (Shexli) on every upload, and it
checks these mechanically. Getting them wrong fails review, so:

- **Connect signals with `connectObject(..., this)`, never a bare `connect()`**,
  and drop them with a single `disconnectObject(this)` during teardown. A raw
  `connect()` stored on a `this.*` field with no matching disconnect is flagged
  (EGO-L-003). Disconnect *before* destroying the actors, so nothing fires
  mid-teardown.
- **Destroy every object you create, explicitly.** Call `.destroy()` on each
  child widget (leaf-first, then the container) rather than relying on the
  parent to cascade — the analyser matches each `this._x = new St.…` against a
  corresponding `this._x.destroy()` and cannot infer cascading (EGO-L-002).
- **Null the references afterwards** (`this._x = null`), and null the indicator
  in `disable()` (EGO-L-005). Prefer this over a `this._destroyed` flag; guard
  late async callbacks with a `Gio.Cancellable` that teardown cancels.

Helper classes that own widgets (`Meter`, `SourceSection`, `Pager`) therefore each expose a `destroy()` that follows all three
rules; call it from the indicator's `destroy()`.

## Install (development)

Symlink `src/` (not the repo root) into the extensions folder:

```sh
ln -s "$PWD/src" ~/.local/share/gnome-shell/extensions/quota@4ndr3lu15.github.io
git config core.hooksPath tools/git-hooks
./tools/compile-schemas.sh
gnome-extensions enable quota@4ndr3lu15.github.io
```

On Wayland a new extension only loads after logging out and back in.

The `core.hooksPath` line matters more than it looks. The extensions folder
symlinks `src/`, so the code follows every branch switch instantly, but
`gschemas.compiled` is a gitignored build artifact that nothing regenerates.
Checking out a branch that adds a GSettings key then leaves the shell reading a
stale schema, and the extension dies at startup with `GSettings key <name> not
found in schema …`. The hooks recompile on checkout, merge, and rebase so that
cannot happen; `./tools/compile-schemas.sh` does it by hand. That error message
always means "recompile", never a code fault.

