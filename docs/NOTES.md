# Quota: notes on every part

The long version of AGENTS.md. Not imported by CLAUDE.md: read the section for what you change.

## Layout

The shipped extension lives in `src/`; everything else (this file, the README,
the CHANGELOG, the LICENSE, `build.sh`, `tools/`) is repo tooling that stays
out of the bundle.

- `src/extension.js` — the indicator and its menu.
  - `QuotaIndicator` (a `PanelMenu.Button`): the top bar (a `MonolitoMark`,
    nothing else) and the menu, top to bottom: the status line (mark + the
    state in words, from every account on every page), the `Pager` row
    (back/forward `icon-button flat`s around the platform's name, one dot
    per page), then one page per platform (`KINDS`: Claude, Antigravity,
    OpenRouter), only the current one shown, holding a `SourceSection` per
    account and one Open Usage Page row, or, with no account of that kind,
    a quiet "Add a Claude Account…" / "Add an OpenRouter Key…" row that
    opens Settings on the Accounts page; then Refresh (with "Updated …"),
    Report…, Settings. `_reloadSources()` rebuilds the sections (cancelling
    any fetch in flight) when `profiles` or `openrouter-accounts` change.
    `_refresh()` polls every account at once; `_syncStatus()` runs
    `overallStatus()` over all of them after each answer and on the
    countdown tick, and sets the mark, the status line and the accessible
    name. Refresh is a `StayOpenItem`, which acts without closing the menu.
    Pages wrap around and the current one is kept in `menu-page`.
    `_onMenuScroll()` turns them on sideways scrolling anywhere on the menu:
    a tilted wheel's left/right clicks one page each, a touchpad swipe one
    page per gesture past `SWIPE_STEPS` (with natural scrolling, fingers to
    the left bring the next page, as in the app grid); pointer-emulated
    events are skipped and vertical scrolling is left alone.
  - `MonolitoMark` (a Cairo `St.DrawingArea`): paints `lib/mark.js` in its
    own foreground color, set by the state class, like a symbolic icon.
  - `SourceSection`: one account's part of the menu, whatever the platform:
    a header only when its page has several accounts (the account's name;
    the pager already names the platform), the account line, one `Meter` per window keyed by window,
    info lines, error or signed-out note. `lastResult` (null while loading,
    then `ok` | `error` | `signed-out`) and the windows feed the status.
- `src/lib/status.js` — pure judgement, no imports: `windowLevel()` judges a
  window by the consequence of the current pace (would you be locked out,
  and for how long), `judgeWindow()` floors it at the API's own severity,
  `projectionNote()` says it in the meter's caption, and `overallStatus()`
  gives the one state (`unknown` | `good` | `tight` | `critical` | `out`)
  and its sentence. Claude decides the color: each account by the worst of
  its 5-hour and weekly windows (per-model windows only color their meter),
  the state by the account with the most room. OpenRouter only turns it red,
  when a budget, key limit or bought credit is used up.
  `node tools/test-status.mjs`.
- `src/lib/mark.js` — the obelisk outline and `drawMark()`; no imports.
- `src/prefs.js` — two `Adw.PreferencesPage`s. General: Placement, Behavior
  (refresh interval, shortcut), version footer. Accounts: Claude profiles
  (one expander row each, with its config folder and its own PKCE sign-in)
  and OpenRouter accounts (API and management keys to the keyring). It
  opens on the page named by `prefs-page` (then clears it), also while open.
  `addRow()` uses `Adw.ButtonRow` where libadwaita has it (1.6+) and an
  action row on GNOME 46.
- `src/lib/sources.js` — the source list: every Claude profile (profiles.js)
  then every OpenRouter account (`openrouter-accounts` JSON key, `{id, label}`),
  each tagged with `kind`.
- `src/lib/providers/claude.js` / `openrouter.js` — one class per platform with
  the same shape: `kind`, `usageUrl`, `quickTier()`, `fetch(cancellable)` →
  snapshot, `describeError(e)`, `destroy()`. The snapshot is `{subtitle,
  tier: {label} | null, windows, lines: [{text, level}]}`; `windows` use the
  normalised window shape of usageModel.js (`role` says what the status
  makes of it), optionally with `detail` (money caption, put before the
  reset text on the meter). To add a platform: a provider class, a `kind` in
  sources.js, an entry in `KINDS` and a branch in `makeProvider()`, a prefs
  group on the Accounts page, and how `overallStatus()` treats it.
- `src/lib/usageModel.js` — pure shaping of the Claude usage payload
  (`normalizeWindows`, preferring the `limits[]` array and falling back to
  the legacy flat keys; `normalizeSpend`). No GI imports;
  `node tools/test-usageModel.mjs`.
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
- `src/schemas/` — GSettings: `panel-position` + `panel-index`, `quota-toggle-menu` (`as`; keybinding
  names are global in the shell, so never a generic name like
  `toggle-menu`), `poll-seconds`, `profiles`, `profiles-initialized`,
  `profile-tokens`, `openrouter-accounts`, `agy-accounts`, `agy-initialized`,
  and the internal `menu-page` (the platform the menu last showed) and
  `prefs-page` (the Settings page the menu asks for). Recompile after
  edits: `./tools/compile-schemas.sh`.
- `src/stylesheet.css`, `stylesheet-dark.css`, `stylesheet-light.css` —
  `quota-*` classes; see Design rules.
- `src/icons/monolito-symbolic.svg` — the mark, a single `#bebebe` fill.
- `build.sh` — `gnome-extensions pack` into
  `dist/quota@4ndr3lu15.github.io.shell-extension.zip`; `-major`/`-minor`/
  `-patch` bump `version-name` and the integer `version` first.
- `tools/` — `poll.js` (live Claude check: `gjs -m tools/poll.js [configDir]`),
  `poll-openrouter.js`, the four node tests, `compile-schemas.sh`, and
  `git-hooks/` that recompile the schema on checkout, merge and rebase
  (`git config core.hooksPath tools/git-hooks`).

## The app (`quota/`)

Run from source with `./quota-app` (app id `io.github._4ndr3lu15.Quota`,
`QUOTA_DEVEL=1` for a `.Devel` instance with its own settings). Unlike the
extension's menu, the app follows the GNOME HIG's sentence case for buttons
and menus ("Open usage page", "Keyboard shortcuts"); the window title is
"Quota".

- GTK-free, tested with `python3 -m pytest tests`:
  - `status.py` — `src/lib/status.js` in Python (window levels, pace, the
    one state and its sentence). Keep the two in step.
  - `usage.py` — fetch and shape: Claude `api/oauth/usage` with the token in
    `<configDir>/.credentials.json` (or the extension's in-app sign-in),
    OpenRouter `/api/v1/key` and `/credits`. Blocking (urllib), so worker
    threads only; all network goes through `http_get`, which tests and the
    screenshot tool replace.
  - `accounts.py` — the extension's account list from its GSettings schema
    (compiled in `src/schemas` or the installed extension), else the Claude
    Code folders on disk; OpenRouter keys from the keyring (`keys.py`,
    read-only), Quota's own or MINITRON's.
  - `logs.py` — MINITRON's `memory/turns.jsonl` and `sessions/*.json`,
    grouped by local day, provider and model. Read-only.
  - `settings.py` — `~/.config/quota/settings.json` (the last page shown).
- GTK: `application.py` (actions, accelerators, main menu, about,
  shortcuts; the menu's Open Atelier / MINITRON / Tasks / Conduit run
  `xdg-open atelier://launch/<Name>`), `window.py` (an `Adw.ViewStack`
  with Usage and Logs, a view switcher in the header bar and a bottom bar
  below 550sp; refreshes every 5 minutes and on Ctrl+R, follows
  `turns.jsonl` with a file monitor). `data/style.css` uses named colors
  only.
- `quota/tools/screenshot.py` renders the window on sample accounts, a
  fake network and a sample MINITRON folder, light and dark, narrow, and
  out of tokens:
  `dbus-run-session -- mutter --headless --wayland --no-x11 --virtual-monitor 1280x900 -- python3 quota/tools/screenshot.py .screenshots/app`

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
- **Review feedback** from extensions.gnome.org goes into Conventions in AGENTS.md,
  as with the GI version rule, so it is not asked twice.

## Testing in a headless GNOME Shell (no log out needed)

Run a throwaway shell with in-memory settings, enable the extension over D-Bus,
then read its state (1 = active) and look for JS errors in the log. Each run
fetches usage for real: a handful of runs in a few minutes gets the Claude API
to answer 429 for a while.

```sh
dbus-run-session -- bash -c '
  export GSETTINGS_BACKEND=memory XDG_RUNTIME_DIR=$(mktemp -d)
  gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 > /tmp/shell.log 2>&1 & PID=$!
  until gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Extensions.ListExtensions >/dev/null 2>&1; do sleep 1; done
  gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Extensions.EnableExtension quota@4ndr3lu15.github.io
  sleep 8
  gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Extensions.GetExtensionInfo quota@4ndr3lu15.github.io | grep -oE "(state|error).: <[^>]*>"
  kill $PID'
grep -nE "JS ERROR|Quota" /tmp/shell.log
```

`GSETTINGS_BACKEND=memory` matters: with a separate dconf the enable call does
not stick. It also means a `gsettings` command outside the shell process
cannot change the shell's settings (each process has its own memory); set
them from inside, e.g. from a throwaway helper extension, which can also take
screenshots with `Shell.Screenshot` and open the menu.
