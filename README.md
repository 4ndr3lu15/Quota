# Quota

Keep an eye on your AI plans from the GNOME top bar: how much of your Claude
limits you have used and when they reset, or what you have spent on
OpenRouter and what is left. One small gauge in the top bar, the details in
its menu, and a switcher for when you have more than one account.

Quota follows your shell: it uses the shell's own menus, your accent color,
and the light or dark style. It only turns amber or red when a limit is
actually getting close, taking your current pace into account.

## Sources

- **Claude**: the 5-hour session and the weekly limits (and per-model ones,
  when your plan has them), plus extra usage. Accounts signed in with Claude
  Code (`~/.claude`, or a `~/.claude-*` folder used with `CLAUDE_CONFIG_DIR`)
  are found on their own. Another account can sign in from Settings.
- **OpenRouter**: Settings → Accounts → Add OpenRouter Account, then paste an
  API key. You get spend (today, this week, this month), the key's limit and
  budgets with their reset times, and free-model requests on a free account.
  Add a [management key](https://openrouter.ai/settings/management-keys) too
  for the credit balance. Keys are kept in your keyring.

More providers are planned.

## Install

From source:

```sh
git clone https://github.com/4ndr3lu15/Quota.git
cd Quota
./build.sh
gnome-extensions install --force dist/quota@4ndr3lu15.github.io.shell-extension.zip
```

Then log out and back in, and turn Quota on in the Extensions app. Requires
GNOME Shell 46 or later.

## Development

```sh
ln -s "$PWD/src" ~/.local/share/gnome-shell/extensions/quota@4ndr3lu15.github.io
git config core.hooksPath tools/git-hooks
./tools/compile-schemas.sh
gnome-extensions enable quota@4ndr3lu15.github.io
```

On Wayland, log out and back in to load it. Tests:

```sh
node tools/test-usageModel.mjs
node tools/test-openrouterModel.mjs
node tools/test-tokenStore.mjs
gjs -m tools/poll.js                                            # live Claude check
OPENROUTER_API_KEY=sk-or-... gjs -m tools/poll-openrouter.js   # live OpenRouter check
```

## License

GPL-2.0. The Claude and OpenRouter usage endpoints Quota reads are not
documented and may change without notice.
