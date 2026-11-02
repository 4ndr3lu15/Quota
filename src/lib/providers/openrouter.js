// The OpenRouter source: one account, identified by its API key in the keyring
// (lib/secrets.js). GET /api/v1/key gives the key's spend, limit, budgets and
// free-model requests; with an optional management key, GET /api/v1/credits
// adds the account balance. No shell imports.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {UsageError, SignedOutError} from '../usageClient.js';
import {lookupSecret, lookupMinitronKey} from '../secrets.js';
import {normalizeOpenRouter} from '../openrouterModel.js';

const KEY_URL = 'https://openrouter.ai/api/v1/key';
const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

const decoder = new TextDecoder();

export class OpenRouterProvider {
    constructor(source) {
        this.source = source;
        this.kind = 'openrouter';
        this.usageUrl = 'https://openrouter.ai/activity';
        this._session = new Soup.Session();
        this._session.timeout = 15;
    }

    _get(url, token, cancellable) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', url);
            const headers = msg.get_request_headers();
            headers.append('Accept', 'application/json');
            headers.append('Authorization', `Bearer ${token}`);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    // The raw integer, as in UsageClient: the Soup.Status enum
                    // lacks some codes (429) and would throw.
                    const status = msg.status_code;
                    const text = bytes ? decoder.decode(bytes.get_data()) : '';
                    if (status < 200 || status >= 300) {
                        reject(new UsageError(`HTTP ${status} from ${url}`, {status, body: text}));
                        return;
                    }
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async quickTier() {
        return null;
    }

    async fetch(cancellable) {
        // MINITRON's shared key is read fresh each time, so a key changed or
        // removed in MINITRON shows up here on the next poll.
        // An account of Quota's own with no key yet falls back to it too.
        let [apiKey, mgmtKey] = this.source.shared
            ? [null, null]
            : await Promise.all([
                lookupSecret(this.source.id, 'api', cancellable),
                lookupSecret(this.source.id, 'management', cancellable),
            ]);
        this._fromMinitron = false;
        if (!apiKey && !mgmtKey) {
            apiKey = await lookupMinitronKey(cancellable);
            this._fromMinitron = !!apiKey;
        }
        if (!apiKey && !mgmtKey) {
            throw new SignedOutError(this.source.shared
                ? 'MINITRON has no OpenRouter key anymore. Add one in MINITRON’s Preferences.'
                : 'No API key yet. Add one in Settings → Accounts, or in MINITRON’s Preferences.');
        }

        // The key endpoint describes whichever key calls it, so without a
        // regular key the management key stands in (it reports on itself).
        const [keyRes, creditsRes] = await Promise.allSettled([
            this._get(KEY_URL, apiKey ?? mgmtKey, cancellable),
            mgmtKey ? this._get(CREDITS_URL, mgmtKey, cancellable) : Promise.resolve(null),
        ]);
        if (keyRes.status === 'rejected')
            throw keyRes.reason;

        const model = normalizeOpenRouter(keyRes.value?.data ?? {},
            creditsRes.status === 'fulfilled' ? creditsRes.value?.data ?? null : null);
        const lines = model.lines.map(text => ({text, level: null}));
        if (creditsRes.status === 'rejected') {
            const e = creditsRes.reason;
            lines.push({
                text: e instanceof UsageError && (e.status === 401 || e.status === 403)
                    ? 'Balance unavailable: that key is not a management key.'
                    : 'Balance unavailable right now.',
                level: 'warn',
            });
            logError(e, `Quota: credits fetch failed for "${this.source.label}" (non-fatal)`);
        }
        const label = keyRes.value?.data?.label;
        return {
            subtitle: this._fromMinitron ? 'Key shared from MINITRON'
                : label ? `Key “${label}”` : null,
            tier: model.tier,
            windows: model.windows,
            lines,
        };
    }

    describeError(e) {
        if (e instanceof UsageError && e.status === 401)
            return this.source.shared || this._fromMinitron
                ? 'OpenRouter rejected MINITRON’s key. Check it in MINITRON’s Preferences.'
                : 'OpenRouter rejected the API key. Check it in Settings → Accounts.';
        if (e instanceof UsageError && e.status === 429)
            return 'OpenRouter is rate limiting requests. Trying again shortly.';
        if (e instanceof UsageError && e.apiMessage())
            return e.apiMessage();
        return e.message || 'Could not reach OpenRouter';
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }
}
