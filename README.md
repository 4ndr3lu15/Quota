# Quota

Keep an eye on your AI plans from the GNOME top bar. Quota puts one small
Monolito mark there, an obelisk whose color tells you at a glance whether
you can work:

- **green**: you can work;
- **red**: out of tokens (a Claude limit used up, or an OpenRouter balance
  or budget spent);
- **dim**: not known yet (loading, signed out, or an error).

Click it for the details: a status line that says the same thing in words
("Pace is tight: 5-hour limit resets in 1 h 20 min"), then one page per
platform, Claude, Antigravity and OpenRouter, with every account of it: your
Claude limits with their reset times, your Antigravity limits, your
OpenRouter spend and balance. Turn the page with the arrows beside its name,
or swipe sideways with two fingers; the menu opens on the page you left.

Quota follows your shell: it uses the shell's own menus, your accent color,
and the light or dark style. The color takes your current pace into account,
not just the percentage.

## The app

For a closer look, the Quota app (GTK 4 and libadwaita) has two pages:

- **Usage**: the same status line, every Claude limit and OpenRouter
  budget with a meter, OpenRouter spend, and what MINITRON's model calls
  cost per day over the last two weeks.
- **Logs**: MINITRON's model calls by day, grouped by model, each with its
  prompt, time, duration, context and cost. It follows the log as it grows.

Run it from the source tree with `./quota-app`. The main menu opens the
other Monolito apps (Atelier, MINITRON, Tasks, Conduit) through Atelier.

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
node tools/test-status.mjs
node tools/test-usageModel.mjs
node tools/test-openrouterModel.mjs
node tools/test-tokenStore.mjs
python3 -m pytest tests                                         # the app's GTK-free modules
gjs -m tools/poll.js                                            # live Claude check
OPENROUTER_API_KEY=sk-or-... gjs -m tools/poll-openrouter.js   # live OpenRouter check
```

## License

GPL-2.0. The Claude and OpenRouter usage endpoints Quota reads are not
documented and may change without notice.
