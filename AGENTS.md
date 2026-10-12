# Quota (GNOME Shell extension)

Quota shows how much of your AI plans you have used, in the GNOME top bar:
Claude usage limits and OpenRouter spend, budgets and balance, one source at a
time, picked from the menu. It looks and behaves like part of GNOME.
UUID `quota@4ndr3lu15.github.io`, schema `org.gnome.shell.extensions.quota`.

## Design rules

- Follow the shell, do not restyle it. The menu is built from
  `PopupMenu` items (submenu with check ornaments for the source switcher,
  `PopupBaseMenuItem`s for the meters, plain `PopupMenuItem`s for the
  actions); text uses the theme's colors, secondary text is the same color
  at `DIM_OPACITY`; meters fill with `-st-accent-color`.
- The only colors in stylesheet.css are for usage that needs attention
  (`quota-warn`, `quota-crit`): bright ones for the top bar (always dark),
  mid-tones for the menu (light or dark).
- The top bar gauge (`Gauge`, a Cairo `St.DrawingArea`) paints in its own
  foreground color, so it looks like a symbolic icon; a level class changes
  that color. Its size and `-quota-line-width` come from the stylesheet.
- Display-only rows are `reactive: false`, which the shell styles as
  insensitive; they carry `quota-item`, whose stylesheet rule keeps the
  normal text color.
- Few settings (GNOME HIG): what the top bar shows, which Claude windows,
  placement, refresh interval, shortcut, accounts. No style editor.
- Header capitalization for titles and menu items ("Open Usage Page",
  "Refresh Interval"), sentence case for subtitles and captions.

## Layout

The shipped extension lives in `src/`; everything else (this file, the README,
the CHANGELOG, the LICENSE, `build.sh`, `tools/`) is repo tooling that stays
out of the bundle.

- `src/extension.js` — the indicator and its menu.
  - `QuotaIndicator` (a `PanelMenu.Button`): the top bar box (optional source
    icon, then the view's block), the menu shell (source switcher or plain
    heading, the view's section, separator, Open Usage Page / Refresh /
    Settings), the poll timer and the countdown tick. `_reloadSources()`
    rebuilds the switcher when `profiles` or `openrouter-accounts` change;
    `_showActive()` rebuilds the view (cancelling any fetch in flight) when
    `active-source` changes. Refresh and the source items are `StayOpenItem`s,
    which act without closing the menu.
  - `SourceView`: everything for the shown source, whatever the platform.
    It renders a provider snapshot into the menu (account line, one `Meter`
    per window keyed by window, info lines, error or signed-out note) and the
    top bar (`PanelGroup`s of `PanelGauge`s, then the plan or balance).
    `renderPanel()` runs after every poll, setting change and countdown tick;
    it rebuilds the gauges only when the layout signature (window keys and
    tags) changed. While `lastResult === 'error'` every gauge reads `!`, so
    set `lastResult` before calling it.
  - Levels: `windowLevel()` judges a window by the consequence of the
    current pace (would you be locked out, and for how long), floored at the
    API's own severity; `projectionNote()` says it in words in the caption.
- `src/prefs.js` — two `Adw.PreferencesPage`s. General: Top Bar (gauge,
  percentage, time until reset, account icon, plan or balance), Claude Limits
  in the Top Bar (`panel-windows`), Placement, Behavior (refresh interval,
  shortcut), version footer. Accounts: Claude profiles (one expander row each,
  with its config folder and its own PKCE sign-in) and OpenRouter accounts
  (API and management keys to the keyring). `addRow()` uses `Adw.ButtonRow`
  where libadwaita has it (1.6+) and an action row on GNOME 46.
- `src/lib/sources.js` — the source list: every Claude profile (profiles.js)
  then every OpenRouter account (`openrouter-accounts` JSON key, `{id, label}`),
  each tagged with `kind`. `activeSource()` resolves `active-source`, falling
  back to the first source.
- `src/lib/providers/claude.js` / `openrouter.js` — one class per platform with
  the same shape: `kind`, `icon` (a `-symbolic.svg` in `icons/`), `usageUrl`,
  `quickTier()`, `fetch(cancellable)` → snapshot,
  `panelWindows(windows, selectors, score)`, `describeError(e)`, `destroy()`.
  The snapshot is `{subtitle, tier: {label, panelLabel} | null, windows,
  lines: [{text, level}]}`; `windows` use the normalised window shape of
  usageModel.js, optionally with `tag` (top bar tag, wins in `windowTag`) and
  `detail` (money caption, put before the reset text on the meter). To add a
  platform: a provider class, a `kind` in sources.js, a branch in
  `makeProvider()`, a prefs group on the Accounts page, and its symbolic icon.
- `src/lib/usageModel.js` — pure shaping of the Claude usage payload
  (`normalizeWindows`, preferring the `limits[]` array and falling back to
  the legacy flat keys; `normalizeSpend`), the top bar's window selection
  (`selectPanelWindows` over the `panel-windows` selectors), its grouping
  (`groupPanelWindows`: weekly windows that reset within 5 minutes share one
  countdown) and tags (`windowTag`). No GI imports; `node tools/test-usageModel.mjs`.
- `src/lib/openrouterModel.js` — pure shaping of `GET /api/v1/key` (budgets,
  key limit, free-model requests, spend) and `GET /api/v1/credits`
  (management key only; balance). `node tools/test-openrouterModel.mjs`;
  `gjs -m tools/poll-openrouter.js` checks a key against the live API.
- `src/lib/usageClient.js` — Claude: resolves a token for a `configDir` (that
  profile's on-disk credentials first, its in-app sign-in from tokenStore.js
  second), calls the usage and profile endpoints, refreshes the token when
  near expiry and writes it back where it came from. A profile with neither
  resolves to a `SignedOutError`, shown as a quiet note. Also
  `claudeCodeCredentialsAvailable()`, `defaultConfigDir()`, `discoverConfigDirs()`.
- `src/lib/profiles.js` — the Claude profile list (`profiles` JSON key) and
  `ensureProfiles()`, which seeds it from `discoverConfigDirs()` once, gated by
  `profiles-initialized`.
- `src/lib/tokenStore.js` — per-profile in-app OAuth tokens in the
  `profile-tokens` JSON key. No imports; `node tools/test-tokenStore.mjs`.
- `src/lib/secrets.js` — API keys in the keyring through libsecret, one per
  (account id, kind = `api` | `management`), schema
  `org.gnome.shell.extensions.quota.ApiKey`. A lookup gives up after 10 s
  with a `KeyringError`. Never store keys in GSettings.
- `src/lib/oauth.js` — shared Claude OAuth/API constants and text codecs.
- `src/schemas/` — GSettings: `panel-gauge` (`ring`|`bar`|`none`),
  `show-percentage`, `show-reset`, `show-icon`, `show-plan`, `panel-windows`
  (`as` of `five-hour`|`seven-day`|`scoped`|`max`|`worst`, default `worst`),
  `panel-position` + `panel-index`, `quota-toggle-menu` (`as`; keybinding
  names are global in the shell, so never a generic name like
  `toggle-menu`), `poll-seconds`, `profiles`, `profiles-initialized`,
  `profile-tokens`, `openrouter-accounts`, `active-source`. Recompile after
  edits: `./tools/compile-schemas.sh`.
- `src/stylesheet.css` — `quota-*` classes; see Design rules.
- `src/icons/` — `quota-symbolic.svg` (shown with no account), and one
  symbolic icon per provider (`claude-symbolic.svg`, `openrouter-symbolic.svg`),
  all single-color `#bebebe` fills so the shell recolors them.
- `build.sh` — `gnome-extensions pack` into
  `dist/quota@4ndr3lu15.github.io.shell-extension.zip`; `-major`/`-minor`/
  `-patch` bump `version-name` and the integer `version` first.
- `tools/` — `poll.js` (live Claude check: `gjs -m tools/poll.js [configDir]`),
  `poll-openrouter.js`, the three node tests, `compile-schemas.sh`, and
  `git-hooks/` that recompile the schema on checkout, merge and rebase
  (`git config core.hooksPath tools/git-hooks`).

## Data sources

- Tier: `~/.claude/.credentials.json` (`claudeAiOauth.subscriptionType` /
  `rateLimitTier`), confirmed via `GET https://api.anthropic.com/api/oauth/profile`.
- Limits: `GET https://api.anthropic.com/api/oauth/usage`. The current shape is
  a self-describing `limits[]` array — each entry has `kind`
  (`session`/`weekly_all`/`weekly_scoped`), `group` (`session`/`weekly`),
  `percent`, `severity` (`normal`/`warning`/`critical`), `resets_at`,
  `is_active`, and an optional `scope.model.display_name` naming a per-model
  window (e.g. Fable). Money now comes as a structured `spend` object
  (`used`/`limit` as `{amount_minor, currency, exponent}` + `percent` +
  `severity`). The older flat keys (`five_hour`, `seven_day`,
  `seven_day_<model>` with `utilization` %, plus `extra_usage`) are still parsed
  as a fallback in `usageModel.js`. Required headers:
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
  `anthropic-version: 2023-06-01`.
- Refresh: `POST https://platform.claude.com/v1/oauth/token` with
  `grant_type=refresh_token` and the public Claude Code `client_id`.

These are undocumented internal endpoints and may change without notice.

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

Helper classes that own widgets (`Meter`, `PanelGauge`, `PanelGroup`,
`SourceView`) therefore each expose a `destroy()` that follows all three
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

## Release

`./build.sh` packs `src/` into `dist/quota@4ndr3lu15.github.io.shell-extension.zip`
for upload to extensions.gnome.org. The bundle contains only runtime files.
Add a CHANGELOG.md entry for every release.

## Maintenance

- **New GNOME release** (March and September): run the headless test on the
  new shell, fix any API breaks (like `vertical` in GNOME 51), add the
  version to `shell-version` in `metadata.json`, and release.
- **An endpoint changes shape**: `gjs -m tools/poll.js` and
  `gjs -m tools/poll-openrouter.js` print the raw payloads. Fix the pure
  models (`usageModel.js`, `openrouterModel.js`) and add a node test with the
  new payload before touching the UI.
- **Every release**: run the node tests, add a CHANGELOG entry,
  `./build.sh -patch|-minor`, commit, tag `vX.Y.Z`, upload the zip to
  extensions.gnome.org and attach it to the GitHub release. The integer
  `version` must go up on every upload, which `build.sh` does.
- **Review feedback** from extensions.gnome.org goes into Conventions above,
  as with the GI version rule, so it is not asked twice.
