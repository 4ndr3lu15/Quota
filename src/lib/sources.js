// The sources the dropdown's picker offers: every Claude profile (profiles.js)
// followed by every OpenRouter account. A source is {id, kind, label, ...}; a
// Claude source also carries its configDir. OpenRouter accounts are stored as a
// JSON array of {id, label} in the `openrouter-accounts` key, and their API
// keys live in the keyring under the same id (secrets.js). The source shown is
// the `active-source` key's id, or the first source when that id is gone.
// No shell imports, so prefs uses it too.
import {loadProfiles, makeProfileId} from './profiles.js';

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

export function loadSources(settings) {
    return [
        ...loadProfiles(settings).map(p => ({...p, kind: 'claude'})),
        ...loadOpenRouterAccounts(settings).map(a => ({...a, kind: 'openrouter'})),
    ];
}

export function activeSource(settings, sources = loadSources(settings)) {
    const id = settings.get_string('active-source');
    return sources.find(s => s.id === id) ?? sources[0] ?? null;
}
