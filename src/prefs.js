import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {claudeCodeCredentialsAvailable} from './lib/usageClient.js';
import {
    AUTHORIZE_URL, TOKEN_URL, CLIENT_ID, REDIRECT_URI, OAUTH_SCOPES,
    DEFAULT_EXPIRES_IN, encoder, decoder,
} from './lib/oauth.js';
import {loadProfiles, saveProfiles, makeProfileId, labelForDirName, ensureProfiles} from './lib/profiles.js';
import {getToken, setToken, clearToken} from './lib/tokenStore.js';
import {
    loadOpenRouterAccounts, saveOpenRouterAccounts, makeAccountId,
    loadAgyAccounts, saveAgyAccounts, makeAgyAccountId, ensureAgyAccounts, defaultAgyConfigDir,
} from './lib/sources.js';
import {agyCredentialsAvailable} from './lib/providers/agy.js';
import {lookupSecret, storeSecret, clearSecret, lookupMinitronKey} from './lib/secrets.js';

// Keys that type nothing, so binding them without a modifier steals no input:
// the function keys (F1-F35, contiguous) and the XF86 media/extra keys, which
// all sit above 0x1008FF00.
const XF86_KEY_BASE = 0x1008ff00;
function isDedicatedKey(keyval) {
    return (keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35) || keyval >= XF86_KEY_BASE;
}

// Gtk.FileDialog predates GJS's automatic async/finish pairing for this
// class on some GNOME versions, so promisify it explicitly.
Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');

// URL-safe base64 without padding, as required by PKCE.
function base64url(bytes) {
    return GLib.base64_encode(bytes)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function randomToken() {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
        bytes[i] = GLib.random_int_range(0, 256);
    return base64url(bytes);
}

function codeChallenge(verifier) {
    const hex = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, verifier, -1);
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
        raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return base64url(raw);
}

// A path with the home folder written as "~", as GNOME shows paths.
function tildePath(path) {
    const home = GLib.get_home_dir();
    return path === home || path?.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// A list row that adds something: a button row where libadwaita has them
// (1.6, GNOME 47), else an activatable row with a plus icon.
function addRow(title, onActivate) {
    if (Adw.ButtonRow) {
        const row = new Adw.ButtonRow({title, start_icon_name: 'list-add-symbolic'});
        row.connect('activated', onActivate);
        return row;
    }
    const row = new Adw.ActionRow({title, activatable: true});
    row.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
    row.connect('activated', onActivate);
    return row;
}

// Opens a native folder picker rooted at initialPath; returns the chosen path,
// or null if the user cancelled (or the dialog failed for any reason - not
// worth surfacing, the user can just try again).
async function pickFolder(window, initialPath) {
    const dialog = new Gtk.FileDialog({title: 'Select a Claude Code Config Folder'});
    if (initialPath) {
        try {
            dialog.set_initial_folder(Gio.File.new_for_path(initialPath));
        } catch {
            // Best-effort; the dialog falls back to its own default location.
        }
    }
    try {
        const folder = await dialog.select_folder(window, null);
        return folder.get_path();
    } catch {
        return null;
    }
}

export default class QuotaPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);
        // Settings handlers, dropped when the window closes so nothing
        // updates widgets that are gone.
        this._handlers = [];
        window.connect('close-request', () => {
            for (const [obj, id] of this._handlers)
                obj.disconnect(id);
            this._handlers = [];
            return false;
        });

        const general = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(general);
        const accounts = new Adw.PreferencesPage({
            title: 'Accounts',
            icon_name: 'system-users-symbolic',
        });
        window.add(accounts);

        // ---- where it sits ----
        const placement = new Adw.PreferencesGroup({title: 'Placement'});
        general.add(placement);
        placement.add(this._comboRow(settings, 'panel-position', 'Section', '',
            [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]));
        const indexRow = new Adw.SpinRow({
            title: 'Position',
            subtitle: 'Order within the section, 0 is first',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 20, step_increment: 1, page_increment: 5}),
        });
        placement.add(indexRow);
        settings.bind('panel-index', indexRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // ---- behavior ----
        const behavior = new Adw.PreferencesGroup({title: 'Behavior'});
        general.add(behavior);
        const interval = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'Seconds between updates',
            adjustment: new Gtk.Adjustment({lower: 30, upper: 600, step_increment: 10, page_increment: 60}),
        });
        behavior.add(interval);
        settings.bind('poll-seconds', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(this._buildShortcutRow(settings, window));

        this._addAboutGroup(general);

        // ---- accounts ----
        await this._addProfilesGroup(accounts, settings, window);
        await this._addAgyGroup(accounts, settings, window);
        this._addOpenRouterGroup(accounts, settings);

        // The menu asks for a page through prefs-page ("Add an OpenRouter
        // Key…" wants Accounts), also when this window is already open.
        const showPage = () => {
            if (settings.get_string('prefs-page') === 'accounts')
                window.set_visible_page(accounts);
            if (settings.get_string('prefs-page') !== '')
                settings.set_string('prefs-page', '');
        };
        showPage();
        this._watch(settings, 'changed::prefs-page', showPage);
    }

    // Connects a settings signal that the window's close-request drops.
    _watch(settings, signal, callback) {
        this._handlers.push([settings, settings.connect(signal, callback)]);
    }

    // A combo row over a string key with fixed choices ([value, title]),
    // kept in sync both ways.
    _comboRow(settings, key, title, subtitle, choices) {
        const model = new Gtk.StringList();
        for (const [, label] of choices)
            model.append(label);
        const row = new Adw.ComboRow({title, subtitle, model});
        const sync = () => {
            row.selected = Math.max(0, choices.findIndex(([v]) => v === settings.get_string(key)));
        };
        sync();
        row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
        this._watch(settings, `changed::${key}`, sync);
        return row;
    }

    // Adds a "Claude profiles" group: one expandable row per configured
    // profile (name, config folder, its own sign-in, and — only when another
    // profile would remain — remove), plus an "Add profile" row. Each
    // profile is just a Claude Code config directory (the CLAUDE_CONFIG_DIR
    // convention for running multiple accounts on one machine); the extension
    // shows every configured profile side by side and refreshes them together.
    async _addProfilesGroup(page, settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Claude',
            description: 'Accounts signed in with Claude Code are found on their own. ' +
                'For another one, add its config folder (e.g. ~/.claude-work, used with ' +
                'CLAUDE_CONFIG_DIR) or connect it here.',
        });
        page.add(group);

        let rows = [];
        const rerender = () => {
            for (const row of rows)
                group.remove(row);
            // Profile rows first, "Add profile" always last. Removal is only
            // offered when another profile would remain: with a single profile
            // there is nothing to fall back to, and deleting it by accident
            // leaves an empty panel that is fiddly to recover from.
            const profiles = loadProfiles(settings);
            rows = profiles.map(p => buildProfileRow(p, profiles.length > 1));
            rows.push(buildAddRow());
        };

        const persist = profiles => {
            saveProfiles(settings, profiles);
            rerender();
        };

        const buildProfileRow = (profile, canRemove) => {
            const row = new Adw.ExpanderRow({title: profile.label, subtitle: tildePath(profile.configDir)});
            group.add(row);

            const nameRow = new Adw.EntryRow({title: 'Name', text: profile.label, show_apply_button: true});
            nameRow.connect('apply', () => {
                const profiles = loadProfiles(settings);
                const p = profiles.find(x => x.id === profile.id);
                if (p) {
                    p.label = nameRow.get_text().trim() || p.label;
                    persist(profiles);
                }
            });
            row.add_row(nameRow);

            const folderRow = new Adw.ActionRow({title: 'Config Folder', subtitle: tildePath(profile.configDir)});
            const changeBtn = new Gtk.Button({label: 'Change…', valign: Gtk.Align.CENTER, css_classes: ['flat']});
            changeBtn.connect('clicked', async () => {
                const dir = await pickFolder(window, profile.configDir);
                if (!dir)
                    return;
                const profiles = loadProfiles(settings);
                const p = profiles.find(x => x.id === profile.id);
                if (p) {
                    p.configDir = dir;
                    persist(profiles);
                }
            });
            folderRow.add_suffix(changeBtn);
            row.add_row(folderRow);

            this._addSignInRows(row, settings, profile);

            if (!canRemove)
                return row;

            const removeRow = new Adw.ActionRow({title: 'Remove Account'});
            const removeBtn = new Gtk.Button({
                label: 'Remove', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'],
            });
            removeBtn.connect('clicked', () => {
                // Drop the profile's stored sign-in too, so a removed account's
                // tokens don't linger in settings.
                clearToken(settings, profile.id);
                Gio.Settings.sync();
                persist(loadProfiles(settings).filter(x => x.id !== profile.id));
            });
            removeRow.add_suffix(removeBtn);
            row.add_row(removeRow);

            return row;
        };

        const buildAddRow = () => {
            const row = addRow('Add Claude Account…', async () => {
                const dir = await pickFolder(window, GLib.get_home_dir());
                if (!dir)
                    return;
                const profiles = loadProfiles(settings);
                if (profiles.some(p => p.configDir === dir))
                    return;
                profiles.push({
                    id: makeProfileId(),
                    label: labelForDirName(GLib.path_get_basename(dir)),
                    configDir: dir,
                });
                persist(profiles);
            });
            group.add(row);
            return row;
        };

        await ensureProfiles(settings);
        rerender();
    }

    // Adds the "Antigravity (Google AI)" group: one expandable row per account
    // (name, config folder, status from agy login, and remove).
    async _addAgyGroup(page, settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Antigravity (Google AI)',
            description: 'Google AI Pro and Ultra subscriptions signed in with Antigravity (`agy auth login`) ' +
                'are found automatically in ~/.gemini/antigravity-cli or your keyring.',
        });
        page.add(group);

        let rows = [];
        const rerender = () => {
            for (const row of rows)
                group.remove(row);
            const list = loadAgyAccounts(settings);
            rows = list.map(a => buildAgyRow(a));
            rows.push(buildAddRow());
        };

        const persist = list => {
            saveAgyAccounts(settings, list);
            Gio.Settings.sync();
            rerender();
        };

        const buildAgyRow = account => {
            const row = new Adw.ExpanderRow({title: account.label, subtitle: tildePath(account.configDir)});
            group.add(row);

            const nameRow = new Adw.EntryRow({title: 'Name', text: account.label, show_apply_button: true});
            nameRow.connect('apply', () => {
                const list = loadAgyAccounts(settings);
                const a = list.find(x => x.id === account.id);
                if (a) {
                    a.label = nameRow.get_text().trim() || a.label;
                    persist(list);
                }
            });
            row.add_row(nameRow);

            const folderRow = new Adw.ActionRow({title: 'Config Folder', subtitle: tildePath(account.configDir)});
            const changeBtn = new Gtk.Button({label: 'Change…', valign: Gtk.Align.CENTER, css_classes: ['flat']});
            changeBtn.connect('clicked', async () => {
                const dir = await pickFolder(window, account.configDir);
                if (!dir)
                    return;
                const list = loadAgyAccounts(settings);
                const a = list.find(x => x.id === account.id);
                if (a) {
                    a.configDir = dir;
                    persist(list);
                }
            });
            folderRow.add_suffix(changeBtn);
            row.add_row(folderRow);

            const statusRow = new Adw.ActionRow({title: 'Sign-In'});
            const statusLabel = new Gtk.Label({valign: Gtk.Align.CENTER});
            statusRow.add_suffix(statusLabel);
            row.add_row(statusRow);
            agyCredentialsAvailable(account.configDir).then(ok => {
                statusLabel.set_label(ok ? 'Using Antigravity CLI' : 'Run `agy auth login`');
                statusLabel.set_css_classes(ok ? ['success'] : ['dim-label']);
            });

            const removeRow = new Adw.ActionRow({title: 'Remove Account'});
            const removeBtn = new Gtk.Button({
                label: 'Remove', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'],
            });
            removeBtn.connect('clicked', () => {
                clearToken(settings, account.id);
                persist(loadAgyAccounts(settings).filter(x => x.id !== account.id));
            });
            removeRow.add_suffix(removeBtn);
            row.add_row(removeRow);

            return row;
        };

        const buildAddRow = () => {
            const row = addRow('Add Google Antigravity Account…', async () => {
                const list = loadAgyAccounts(settings);
                if (!list.length) {
                    list.push({
                        id: makeAgyAccountId(),
                        label: 'Google AI',
                        configDir: defaultAgyConfigDir(),
                    });
                    persist(list);
                    return;
                }
                const dir = await pickFolder(window, GLib.get_home_dir());
                if (!dir)
                    return;
                if (list.some(a => a.configDir === dir))
                    return;
                list.push({
                    id: makeAgyAccountId(),
                    label: `Google AI ${list.length + 1}`,
                    configDir: dir,
                });
                persist(list);
            });
            group.add(row);
            return row;
        };

        await ensureAgyAccounts(settings);
        rerender();
    }

    // A row showing the current shortcut for opening the popup, which opens a
    // small capture dialog when activated. The key is an "as" array, matching
    // how the shell stores its own keybindings.
    _buildShortcutRow(settings, window) {
        const row = new Adw.ActionRow({
            title: 'Keyboard Shortcut',
            subtitle: 'Opens and closes the menu',
            activatable: true,
        });

        const label = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });
        const syncLabel = () => {
            label.set_accelerator(settings.get_strv('quota-toggle-menu')[0] ?? '');
        };
        syncLabel();
        this._watch(settings, 'changed::quota-toggle-menu', syncLabel);
        row.add_suffix(label);

        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Remove Shortcut',
        });
        clear.connect('clicked', () => settings.set_strv('quota-toggle-menu', []));
        row.add_suffix(clear);

        row.connect('activated', () => this._captureShortcut(settings, window));
        return row;
    }

    // Modal that grabs the next key combination. Escape cancels, Backspace
    // clears, and a bare key without modifiers is ignored — otherwise typing a
    // letter would steal it system-wide.
    _captureShortcut(settings, window) {
        const dialog = new Adw.Window({
            modal: true,
            transient_for: window,
            default_width: 380,
            default_height: 180,
            title: 'Set Shortcut',
        });

        const view = new Adw.ToolbarView();
        view.add_top_bar(new Adw.HeaderBar({show_end_title_buttons: false, show_start_title_buttons: false}));
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            spacing: 8,
            margin_start: 24, margin_end: 24, margin_top: 12, margin_bottom: 24,
        });
        box.append(new Gtk.Label({
            label: 'Press the new shortcut. It needs a modifier key, unless it is a function or media key.',
            wrap: true,
        }));
        box.append(new Gtk.Label({
            label: 'Press Esc to cancel or Backspace to remove the shortcut.',
            wrap: true,
            css_classes: ['dim-label'],
        }));
        view.set_content(box);
        dialog.set_content(view);

        const controller = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();

            if (keyval === Gdk.KEY_Escape && !mask) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace && !mask) {
                settings.set_strv('quota-toggle-menu', []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Gtk.accelerator_valid() accepts a bare letter, so it cannot be
            // relied on alone: binding one would swallow ordinary typing
            // system-wide. Require a modifier, except for keys that produce no
            // text at all — the function keys and the XF86 media/extra keys are
            // safe on their own, and are exactly what a keyboard with more than
            // twelve F-keys is for.
            if ((!mask && !isDedicatedKey(keyval)) || !Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
            settings.set_strv('quota-toggle-menu', [accel]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present();
    }

    // The name and version, under the last group.
    _addAboutGroup(page) {
        const footer = new Adw.PreferencesGroup();
        page.add(footer);
        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        footer.add(new Gtk.Label({
            label: `Quota ${version}`,
            justify: Gtk.Justification.CENTER,
            css_classes: ['dim-label'],
        }));
    }

    // Adds the "OpenRouter" group: one expandable row per account (name, API
    // key, optional management key, remove) and an "Add account" row. The keys
    // go to the keyring, never to GSettings; the fields only ever show whether
    // one is stored, not the key itself.
    _addOpenRouterGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'OpenRouter',
            description: 'An API key shows its spend, limits and budgets. Add a ' +
                'management key as well to see the credit balance. Keys are kept in ' +
                'your keyring.',
        });
        page.add(group);

        let rows = [];
        const rerender = () => {
            for (const row of rows)
                group.remove(row);
            const accounts = loadOpenRouterAccounts(settings);
            rows = accounts.map(buildAccountRow);
            rows.push(buildMinitronRow());
            rows.push(buildAddRow());
        };

        // MINITRON's key, shown read-only: it is pasted in MINITRON, and Quota
        // uses it for any account below that has no key of its own.
        const buildMinitronRow = () => {
            const row = new Adw.ActionRow({title: 'MINITRON', subtitle: 'Looking for MINITRON’s key…'});
            group.add(row);
            lookupMinitronKey().then(key => {
                row.set_subtitle(key
                    ? `Shared from MINITRON (\u2026${key.slice(-4)}). Used by any account without its own key.`
                    : 'No key in MINITRON. Add one in MINITRON’s Preferences, or add an account below.');
            }).catch(() => row.set_subtitle('Keyring unavailable'));
            return row;
        };
        const persist = accounts => {
            saveOpenRouterAccounts(settings, accounts);
            Gio.Settings.sync();
            rerender();
        };

        const keyRow = (expander, account, kind, title) => {
            const row = new Adw.PasswordEntryRow({title, show_apply_button: true});
            const status = new Gtk.Label({valign: Gtk.Align.CENTER, css_classes: ['dim-label']});
            const clear = new Gtk.Button({
                icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                css_classes: ['flat'], tooltip_text: 'Forget Key',
            });
            row.add_suffix(status);
            row.add_suffix(clear);
            const sync = async () => {
                let stored;
                try {
                    stored = await lookupSecret(account.id, kind);
                } catch (e) {
                    status.set_label('Keyring unavailable');
                    clear.set_visible(false);
                    console.error(`Quota prefs: ${e.message}`);
                    return;
                }
                status.set_label(stored ? `Saved (\u2026${stored.slice(-4)})` : 'Not set');
                clear.set_visible(!!stored);
            };
            // Re-saving the account list makes the extension refetch now,
            // rather than at the next poll.
            const touch = () => persist(loadOpenRouterAccounts(settings));
            row.connect('apply', async () => {
                const value = row.get_text().trim();
                if (!value)
                    return;
                try {
                    await storeSecret(account.id, kind,
                        `Quota: OpenRouter ${kind === 'api' ? 'API' : 'management'} key (${account.label})`, value);
                    row.set_text('');
                    await sync();
                    touch();
                } catch (e) {
                    status.set_label('Could not save to the keyring');
                    console.error(`Quota prefs: keyring store failed: ${e.message}`);
                }
            });
            clear.connect('clicked', async () => {
                await clearSecret(account.id, kind);
                await sync();
                touch();
            });
            sync();
            expander.add_row(row);
        };

        const buildAccountRow = account => {
            const row = new Adw.ExpanderRow({title: account.label, subtitle: 'OpenRouter'});
            group.add(row);

            const nameRow = new Adw.EntryRow({title: 'Name', text: account.label, show_apply_button: true});
            nameRow.connect('apply', () => {
                const accounts = loadOpenRouterAccounts(settings);
                const a = accounts.find(x => x.id === account.id);
                if (a) {
                    a.label = nameRow.get_text().trim() || a.label;
                    persist(accounts);
                }
            });
            row.add_row(nameRow);

            keyRow(row, account, 'api', 'API Key');
            keyRow(row, account, 'management', 'Management Key (Optional)');

            const removeRow = new Adw.ActionRow({title: 'Remove Account'});
            const removeBtn = new Gtk.Button({
                label: 'Remove', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'],
            });
            removeBtn.connect('clicked', async () => {
                await clearSecret(account.id, 'api');
                await clearSecret(account.id, 'management');
                persist(loadOpenRouterAccounts(settings).filter(x => x.id !== account.id));
            });
            removeRow.add_suffix(removeBtn);
            row.add_row(removeRow);
            return row;
        };

        const buildAddRow = () => {
            const row = addRow('Add OpenRouter Account', () => {
                const accounts = loadOpenRouterAccounts(settings);
                const label = accounts.length ? `OpenRouter ${accounts.length + 1}` : 'OpenRouter';
                accounts.push({id: makeAccountId(), label});
                persist(accounts);
                rows.at(-2)?.set_expanded(true);
            });
            group.add(row);
            return row;
        };

        rerender();
    }

    // Adds this profile's own sign-in rows: a status line, Connect (which opens
    // the browser for a PKCE flow), a field to paste the returned code, and
    // Disconnect. Each profile signs in to its own Claude account, so the tokens
    // are stored per profile id rather than as one shared credential.
    _addSignInRows(expander, settings, profile) {
        const hasInApp = () => getToken(settings, profile.id) !== null;

        const statusRow = new Adw.ActionRow({title: 'Sign-In'});
        const statusLabel = new Gtk.Label({valign: Gtk.Align.CENTER});
        statusRow.add_suffix(statusLabel);
        expander.add_row(statusRow);

        const setStatus = (msg, good) => {
            statusLabel.set_label(msg);
            statusLabel.set_css_classes(good ? ['success'] : ['dim-label']);
        };

        const connectRow = new Adw.ActionRow({
            title: 'Connect',
            subtitle: 'Sign in from the browser, for accounts that don\u2019t use Claude Code',
        });
        const connectButton = new Gtk.Button({
            label: 'Connect', valign: Gtk.Align.CENTER, css_classes: ['suggested-action'],
        });
        connectRow.add_suffix(connectButton);
        connectRow.set_activatable_widget(connectButton);
        expander.add_row(connectRow);

        const codeRow = new Adw.EntryRow({title: 'Code From the Browser', show_apply_button: true});
        codeRow.set_visible(false);
        expander.add_row(codeRow);

        const disconnectRow = new Adw.ActionRow({
            title: 'Disconnect', subtitle: 'Forget the sign-in made here',
        });
        const disconnectButton = new Gtk.Button({
            label: 'Disconnect', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'],
        });
        disconnectRow.add_suffix(disconnectButton);
        disconnectRow.set_activatable_widget(disconnectButton);
        disconnectRow.set_visible(hasInApp());
        expander.add_row(disconnectRow);

        // Claude Code's own credentials win when they are usable, so say so
        // rather than implying the user still has to sign in here.
        const refreshStatus = async () => {
            if (hasInApp()) {
                setStatus('Connected', true);
                disconnectRow.set_visible(true);
            } else if (await claudeCodeCredentialsAvailable(profile.configDir)) {
                setStatus('Using Claude Code', true);
                disconnectRow.set_visible(false);
            } else {
                setStatus('Not connected', false);
                disconnectRow.set_visible(false);
            }
        };
        refreshStatus();

        // PKCE state for the in-progress flow.
        let codeVerifier = null;
        let oauthState = null;

        connectButton.connect('clicked', () => {
            codeVerifier = randomToken();
            oauthState = randomToken();
            const params = [
                'response_type=code',
                `client_id=${encodeURIComponent(CLIENT_ID)}`,
                `redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
                `scope=${encodeURIComponent(OAUTH_SCOPES)}`,
                `code_challenge=${encodeURIComponent(codeChallenge(codeVerifier))}`,
                'code_challenge_method=S256',
                `state=${encodeURIComponent(oauthState)}`,
            ].join('&');
            Gio.AppInfo.launch_default_for_uri(`${AUTHORIZE_URL}?${params}`, null);
            codeRow.set_text('');
            codeRow.set_visible(true);
            setStatus('Waiting for code\u2026', false);
        });

        codeRow.connect('apply', () => {
            if (!codeVerifier) {
                setStatus('Click Connect first', false);
                return;
            }

            // Accept the raw "code#state" the callback page shows, or a full
            // pasted callback URL.
            const input = codeRow.get_text().trim();
            let code = input;
            let state = oauthState;
            try {
                const url = new URL(input);
                if (url.searchParams.has('code'))
                    code = url.searchParams.get('code');
                if (url.searchParams.has('state'))
                    state = url.searchParams.get('state');
            } catch {
                const hash = code.indexOf('#');
                if (hash !== -1) {
                    state = code.slice(hash + 1);
                    code = code.slice(0, hash);
                }
            }

            if (!code) {
                setStatus('Code cannot be empty', false);
                return;
            }

            setStatus('Exchanging code\u2026', false);
            connectButton.set_sensitive(false);

            const body = JSON.stringify({
                grant_type: 'authorization_code',
                code,
                state,
                client_id: CLIENT_ID,
                redirect_uri: REDIRECT_URI,
                code_verifier: codeVerifier,
            });
            const session = new Soup.Session();
            const message = Soup.Message.new('POST', TOKEN_URL);
            message.request_headers.append('Content-Type', 'application/json');
            message.set_request_body_from_bytes(
                'application/json', new GLib.Bytes(encoder.encode(body)));

            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    const text = bytes ? decoder.decode(bytes.get_data()) : '';
                    if (message.status_code !== 200) {
                        console.error(`Quota prefs: token exchange HTTP ${message.status_code}: ${text}`);
                        setStatus(`Error ${message.status_code}`, false);
                        return;
                    }
                    const resp = JSON.parse(text);
                    setToken(settings, profile.id, {
                        accessToken: resp.access_token,
                        refreshToken: resp.refresh_token ?? '',
                        expiresAt: Date.now() + (resp.expires_in ?? DEFAULT_EXPIRES_IN) * 1000,
                    });
                    // prefs is short-lived and may exit as soon as the window
                    // closes; force the token to disk rather than trusting the
                    // backend's async flush, or a sign-in done just before
                    // closing is silently lost.
                    Gio.Settings.sync();
                    setStatus('Connected', true);
                    codeRow.set_visible(false);
                    disconnectRow.set_visible(true);
                    codeVerifier = null;
                    oauthState = null;
                } catch (e) {
                    console.error(`Quota prefs: token exchange failed: ${e.message}`);
                    setStatus('Exchange failed', false);
                } finally {
                    connectButton.set_sensitive(true);
                }
            });
        });

        disconnectButton.connect('clicked', () => {
            clearToken(settings, profile.id);
            Gio.Settings.sync();
            codeRow.set_visible(false);
            codeVerifier = null;
            oauthState = null;
            refreshStatus();
        });
    }
}
