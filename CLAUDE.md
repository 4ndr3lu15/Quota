@AGENTS.md

## Status: road to 0.1.0 (first GitHub release)

Where things stand (2026-10-12):

- Quota is its own project: no fork, upstream or "based on" wording anywhere
  (README, metadata, prefs footer, CHANGELOG). Keep it that way.
- No screenshots in the repo, by choice. Do not add a `screenshots/` folder
  or images to the README.
- Developer machine: Arch, GNOME Shell 51.0, Wayland. `src/` is symlinked to
  `~/.local/share/gnome-shell/extensions/quota@4ndr3lu15.github.io`; code
  changes need a log out/in (or the headless test below).
- GNOME 51 removed `St.BoxLayout`'s `vertical` property: use the `vbox()`
  helper in extension.js, never `vertical: true`.
- No commits yet: the repo was `git init`ed but nothing is committed, and
  `core.hooksPath` is not set yet.
- Node tests pass (usageModel, openrouterModel, tokenStore); `./build.sh`
  packs a clean bundle (runtime files only).

To do before 0.1.0:

- [ ] Check the real session after login: both sources, the switcher, the
      meters, prefs, OpenRouter with a real key (`gjs -m tools/poll-openrouter.js`
      checks a key without the shell).
- [ ] Unconfirmed: whether GET /api/v1/key accepts a management key (used when
      only a management key is stored).
- [ ] Review nits worth fixing before upload: the 10 s keyring timeout in
      `secrets.js` is not removed on disable; prefs.js connects
      `settings.connect('changed::…')` without disconnecting when the window
      closes.
- [ ] GitHub: install `github-cli`, `gh auth login`, create `4ndr3lu15/Quota`.
- [ ] First commit, push, tag `v0.1.0`, `./build.sh`, upload to
      extensions.gnome.org, attach the zip to a GitHub release.

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
