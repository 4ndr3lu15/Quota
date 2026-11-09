# Changelog

## Unreleased

- 2026-11-03: Fall back to `agy -p /usage` in the Python app when Google Cloud Code HTTP returns 403, and include non-scoped Antigravity buckets (Claude/GPT group) in account status judgement.
- **Pages in the menu**: one page per platform (Claude, Antigravity,
  OpenRouter) instead of all of them in one long list. Turn the page with
  the arrows beside its name or a sideways two-finger swipe; the dots show
  where you are, and the menu opens on the page you left. The mark and the
  status line still judge every account.
- **The Quota app**: a GNOME window (GTK 4, libadwaita) with a Usage page
  (the status line, Claude limits and OpenRouter budgets with meters,
  OpenRouter spend, and MINITRON's model cost per day) and a Logs page
  (MINITRON's model calls by day and model, with prompt, time and cost).
  Its main menu opens Atelier, MINITRON, Tasks and Harness.
- **Two colors**: the mark is green while you can work and red when out of
  tokens; the top bar no longer shows a percentage beside it.
- **MINITRON's OpenRouter key**: with no OpenRouter account of its own,
  Quota reads the key MINITRON keeps in the keyring, live, and shows its
  spend as a "MINITRON" account. Paste the key once, in MINITRON. Settings →
  Accounts lists it read-only (last four characters). An OpenRouter account
  of Quota's own with no key stored uses MINITRON's key too.
- **The Monolito mark**: the top bar now shows only a small obelisk, colored
  by whether you can work: green, red when out of tokens, dim while
  loading, signed out or failing. Claude's 5-hour and weekly limits decide
  the color; OpenRouter turns it red when a balance or budget is spent.
  Darker tones in the light style, where the top bar is light.
- **Everything at once**: the menu shows every account, no switcher. A
  status line at the top says the state in words, then a Claude section and
  an OpenRouter section (or "Add an OpenRouter Key…", which opens Settings
  on the Accounts page), each with its own Open Usage Page, then Refresh,
  Report… and Settings. Every account is polled, not only the one shown.
- **Report…** in the menu opens the Monolito report popup.
- **Fewer settings**: the gauge, percentage, time until reset, account
  icon, plan and top bar limit options are gone with the gauge itself;
  Settings keeps placement, the refresh interval, the shortcut and accounts.
- Durations read "1 h 20 min".
- Fixed: the menu's usage bars shrank by their own fraction on every
  refresh or reopening (50% drew as 25%, then 12.5%).

## 0.1.0

First release.

- **Sources**: Claude (every profile found on disk, or signed in from
  Settings) and OpenRouter (spend, key limit, budgets, free-model requests,
  and the credit balance with a management key; keys kept in the keyring).
  The source shown is picked from the menu.
- **Looks like GNOME**: the menu is made of the shell's own menu rows, the
  meters use the system accent color, text follows the light and dark
  styles, and the top bar gauge is drawn in the panel's text color like a
  symbolic icon. Colors only appear when a limit is getting close.
- **Few settings**: preferences are two pages, General and Accounts.
- 2026-11-09: Antigravity: Quota no longer carries Google's OAuth client to refresh tokens itself; an expired token goes to `agy`, which refreshes and saves it. The client's values are removed from history too, so the repository can be pushed (GitHub's push protection).
