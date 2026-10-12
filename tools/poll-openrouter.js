// Standalone check of the OpenRouter source against the live API: prints the
// raw key payload and what the extension makes of it. Run from the repo root:
//   OPENROUTER_API_KEY=sk-or-... gjs -m tools/poll-openrouter.js
//   OPENROUTER_API_KEY=... OPENROUTER_MANAGEMENT_KEY=... gjs -m tools/poll-openrouter.js
// or, for an account already set up in prefs (keys from the keyring):
//   gjs -m tools/poll-openrouter.js <account id>
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import {lookupSecret} from '../src/lib/secrets.js';
import {normalizeOpenRouter, selectOpenRouterPanelWindows} from '../src/lib/openrouterModel.js';

const session = new Soup.Session();
const get = (url, token) => new Promise((resolve, reject) => {
    const msg = Soup.Message.new('GET', url);
    msg.get_request_headers().append('Authorization', `Bearer ${token}`);
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
        try {
            const text = new TextDecoder().decode(s.send_and_read_finish(res).get_data());
            if (msg.status_code !== 200)
                reject(new Error(`HTTP ${msg.status_code}: ${text}`));
            else
                resolve(JSON.parse(text));
        } catch (e) {
            reject(e);
        }
    });
});

async function main() {
    const account = ARGV[0];
    const apiKey = account ? await lookupSecret(account, 'api') : GLib.getenv('OPENROUTER_API_KEY');
    const mgmtKey = account ? await lookupSecret(account, 'management') : GLib.getenv('OPENROUTER_MANAGEMENT_KEY');
    if (!apiKey && !mgmtKey) {
        print('No key: set OPENROUTER_API_KEY, or pass an account id from prefs.');
        return;
    }
    const key = await get('https://openrouter.ai/api/v1/key', apiKey ?? mgmtKey);
    print('--- /api/v1/key ---');
    print(JSON.stringify(key, null, 2));
    let credits = null;
    if (mgmtKey) {
        try {
            credits = (await get('https://openrouter.ai/api/v1/credits', mgmtKey)).data;
            print('--- /api/v1/credits ---');
            print(JSON.stringify(credits, null, 2));
        } catch (e) {
            print(`credits failed: ${e.message}`);
        }
    }
    const model = normalizeOpenRouter(key.data, credits);
    print('--- normalised ---');
    print(JSON.stringify(model, null, 2));
    print('--- panel shows ---');
    print(JSON.stringify(selectOpenRouterPanelWindows(model.windows).map(w => w.label)));
}

const loop = GLib.MainLoop.new(null, false);
main().catch(e => print(`error: ${e.message}`)).finally(() => loop.quit());
loop.run();
