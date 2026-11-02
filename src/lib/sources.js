// The sources Quota watches, all at once: every Claude profile (profiles.js),
// every Google Antigravity (agy) subscription account, and every OpenRouter
// account. A source is {id, kind, label, ...}; Claude and Antigravity sources
// also carry their configDir. OpenRouter accounts are stored as a JSON array of
// {id, label} in the `openrouter-accounts` key, and their API keys live in the
// keyring under the same id (secrets.js).
// When Quota has no OpenRouter account of its own but MINITRON holds a key,
// that key is shown as one shared account (id MINITRON_ID), read live; an
// account of Quota's own with no key stored uses it as well (providers/openrouter.js).
// No shell imports, so prefs uses it too.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {loadProfiles, makeProfileId} from './profiles.js';

export function defaultAgyConfigDir() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.gemini', 'antigravity-cli']);
}

export function loadAgyAccounts(settings) {
    let list;
    try {
        list = JSON.parse(settings.get_string('agy-accounts'));
    } catch {
        list = [];
    }
    return Array.isArray(list)
        ? list.filter(a => a && typeof a.id === 'string' && a.id)
            .map(a => ({
                id: a.id,
                label: String(a.label || 'Antigravity'),
                configDir: String(a.configDir || defaultAgyConfigDir()),
            }))
        : [];
}

export function saveAgyAccounts(settings, accounts) {
    settings.set_string('agy-accounts', JSON.stringify(accounts));
}

export function makeAgyAccountId() {
    return `agy-${makeProfileId()}`;
}

export async function ensureAgyAccounts(settings) {
    const existing = loadAgyAccounts(settings);
    if (existing.length > 0)
        return existing;
    try {
        if (settings.get_boolean('agy-initialized'))
            return existing;
    } catch {
        return existing;
    }
    const seeded = [{
        id: makeAgyAccountId(),
        label: 'Google AI',
        configDir: defaultAgyConfigDir(),
    }];
    saveAgyAccounts(settings, seeded);
    settings.set_boolean('agy-initialized', true);
    Gio.Settings.sync();
    return seeded;
}

export function loadOpenRouterAccounts(settings) {
    let list;
    try {
        list = JSON.parse(settings.get_string('openrouter-accounts'));
    } catch {
        list = [];
    }
    return Array.isArray(list)
        ? list.filter(a => a && typeof a.id === 'string' && a.id)
            .map(a => ({id: a.id, label: String(a.label || 'OpenRouter')}))
        : [];
}

export function saveOpenRouterAccounts(settings, accounts) {
    settings.set_string('openrouter-accounts', JSON.stringify(accounts));
}

export function makeAccountId() {
    return `or-${makeProfileId()}`;
}

export const MINITRON_ID = 'minitron';

export function loadSources(settings, {minitronKey = false} = {}) {
    let accounts = loadOpenRouterAccounts(settings);
    if (!accounts.length && minitronKey)
        accounts = [{id: MINITRON_ID, label: 'MINITRON', shared: true}];
    return [
        ...loadProfiles(settings).map(p => ({...p, kind: 'claude'})),
        ...loadAgyAccounts(settings).map(a => ({...a, kind: 'agy'})),
        ...accounts.map(a => ({...a, kind: 'openrouter'})),
    ];
}
