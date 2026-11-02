@AGENTS.md

## Status: 0.1.0 released on GitHub, waiting for extensions.gnome.org

Where things stand (2026-10-12):

- Repo: https://github.com/4ndr3lu15/Quota (public, capital Q). Tag
  `v0.1.0` and a GitHub release with the zip are up.
- Quota is its own project: no fork, upstream or "based on" wording anywhere
  (README, metadata, prefs footer, CHANGELOG). Keep it that way.
- No screenshots in the repo, by choice. Do not add a `screenshots/` folder
  or images to the README. Local renders go to `.screenshots/`, which is
  gitignored.
- Developer machine: Arch, GNOME Shell 51.0, Wayland. `src/` is symlinked to
  `~/.local/share/gnome-shell/extensions/quota@4ndr3lu15.github.io` (the
  link went stale once when the folder was renamed; check it if the
  extension seems missing). Code changes need a log out/in (or the headless
  test below).
- GNOME 51 removed `St.BoxLayout`'s `vertical` property: use the `vbox()`
  helper in extension.js, never `vertical: true`.
- `core.hooksPath` is set to `tools/git-hooks`.

To do:

- [ ] Upload `dist/quota@4ndr3lu15.github.io.shell-extension.zip` at
      https://extensions.gnome.org/upload/ (needs the user's EGO login), then
      answer the review.
- [ ] Check the real session after login: the Monolito mark's colors, every
      account in the menu, the meters, prefs, OpenRouter with a real key (`gjs -m tools/poll-openrouter.js`
      checks a key without the shell).
- [ ] Unconfirmed: whether GET /api/v1/key accepts a management key (used when
      only a management key is stored).

Headless Shell test, layout, the app, data sources, release and maintenance: `docs/NOTES.md`.
