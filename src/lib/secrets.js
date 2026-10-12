// API keys for the key-based providers (OpenRouter), kept in the user's keyring
// through libsecret rather than in GSettings, where any process could read them
// from dconf. One secret per (account id, kind); kind is 'api' for the regular
// key and 'management' for OpenRouter's optional management key. No shell
// imports, so both the shell and prefs use it.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

const SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.quota.ApiKey',
    Secret.SchemaFlags.NONE,
    {account: Secret.SchemaAttributeType.STRING, kind: Secret.SchemaAttributeType.STRING});

function attrs(account, kind) {
    return {account: String(account), kind: String(kind)};
}

// A keyring that does not answer (none running, or stuck) is given up on
// after this long, rather than leaving the caller waiting forever.
const LOOKUP_TIMEOUT_S = 10;

export class KeyringError extends Error {}

// The stored key, or null when there is none. Rejects with a KeyringError when
// the keyring cannot be reached or does not answer in time.
export function lookupSecret(account, kind, cancellable = null) {
    return new Promise((resolve, reject) => {
        // Our own cancellable, so the timeout can stop the lookup; it follows
        // the caller's.
        const own = new Gio.Cancellable();
        let timedOut = false;
        let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LOOKUP_TIMEOUT_S, () => {
            timer = 0;
            timedOut = true;
            own.cancel();
            return GLib.SOURCE_REMOVE;
        });
        // Cancelling (the extension disabled mid-lookup) drops the timeout
        // right away, not when the lookup answers.
        const linked = cancellable?.connect(() => {
            if (timer)
                GLib.source_remove(timer);
            timer = 0;
            own.cancel();
        }) ?? 0;
        Secret.password_lookup(SCHEMA, attrs(account, kind), own, (_s, res) => {
            if (timer)
                GLib.source_remove(timer);
            if (linked)
                cancellable.disconnect(linked);
            try {
                resolve(Secret.password_lookup_finish(res) || null);
            } catch (e) {
                reject(timedOut
                    ? new KeyringError('The keyring did not answer. Is it running and unlocked?')
                    : e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ? e
                        : new KeyringError(`Could not read the keyring: ${e.message}`));
            }
        });
    });
}

export function storeSecret(account, kind, label, value) {
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, attrs(account, kind), Secret.COLLECTION_DEFAULT,
            label, value, null, (_s, res) => {
                try {
                    resolve(Secret.password_store_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export function clearSecret(account, kind) {
    return new Promise(resolve => {
        Secret.password_clear(SCHEMA, attrs(account, kind), null, (_s, res) => {
            try {
                resolve(Secret.password_clear_finish(res));
            } catch {
                resolve(false);
            }
        });
    });
}
