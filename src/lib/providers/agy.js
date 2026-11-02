// The Google Antigravity (agy) source: reads the Google AI / Antigravity
// OAuth credentials from ~/.gemini/antigravity-cli/antigravity-oauth-token,
// ~/.gemini/jetski-standalone-oauth-token, or the system keyring (go-keyring
// service="gemini"), refreshes the Google OAuth token when needed, and fetches
// subscription tier, Google One AI credits, and quota buckets from the Cloud
// Code internal API (or via `agy -p /usage --output-format json` fallback).
// No shell imports.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {UsageError, SignedOutError} from '../usageClient.js';
import {getToken, setToken} from '../tokenStore.js';
import {lookupAgyToken} from '../secrets.js';
import {normalizeAgy, tierLabel} from '../agyModel.js';

export const AGY_CLIENT_ID = '';
export const AGY_CLIENT_SECRET = '';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const AGY_SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
    'openid',
].join(' ');

const ENDPOINTS = [
    'https://daily-cloudcode-pa.googleapis.com',
    'https://cloudcode-pa.googleapis.com',
];

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function defaultAgyConfigDir() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.gemini', 'antigravity-cli']);
}

function tokenCandidatePaths(configDir = defaultAgyConfigDir()) {
    const home = GLib.get_home_dir();
    const paths = [
        GLib.build_filenamev([configDir, 'antigravity-oauth-token']),
        GLib.build_filenamev([home, '.gemini', 'jetski-standalone-oauth-token']),
    ];
    return [...new Set(paths)];
}

async function readJsonFile(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const bytes = await new Promise((resolve, reject) => {
            file.load_contents_async(null, (f, res) => {
                try {
                    const [ok, data] = f.load_contents_finish(res);
                    resolve(ok ? data : null);
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (!bytes)
            return null;
        return JSON.parse(decoder.decode(bytes));
    } catch {
        return null;
    }
}

async function writeJsonFile(path, obj) {
    const file = Gio.File.new_for_path(path);
    const data = encoder.encode(JSON.stringify(obj, null, 2));
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(
            new GLib.Bytes(data), null, false,
            Gio.FileCreateFlags.PRIVATE, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function parseStoredToken(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const tok = raw.token && typeof raw.token === 'object' ? raw.token : raw;
    const accessToken = tok.access_token || tok.accessToken || null;
    const refreshToken = tok.refresh_token || tok.refreshToken || null;
    if (!accessToken && !refreshToken)
        return null;
    let expiresAt = 0;
    if (tok.expiry) {
        const t = Date.parse(tok.expiry);
        if (!Number.isNaN(t))
            expiresAt = t;
    } else if (tok.expiresAt) {
        expiresAt = Number(tok.expiresAt) || 0;
    }
    return {
        raw,
        accessToken,
        refreshToken,
        expiresAt,
        projectId: raw.project_id || null,
        userTier: raw.user_tier || null,
        tierDisplayName: raw.tier_display_name || null,
        idToken: raw.id_token || null,
    };
}

export async function readAgyStoredToken(configDir = defaultAgyConfigDir(), cancellable = null) {
    const candidates = tokenCandidatePaths(configDir);
    for (const path of candidates) {
        const parsed = parseStoredToken(await readJsonFile(path));
        if (parsed)
            return {...parsed, path};
    }
    try {
        const secret = await lookupAgyToken(cancellable);
        if (secret) {
            const raw = JSON.parse(secret);
            const parsed = parseStoredToken(raw);
            if (parsed) {
                const cachePath = candidates[0];
                try {
                    await writeJsonFile(cachePath, raw);
                } catch {
                    // Best-effort cache to disk.
                }
                return {...parsed, path: cachePath};
            }
        }
    } catch {
        // Keyring unavailable or locked; fall through.
    }
    return null;
}

function findAgyBinary() {
    const inPath = GLib.find_program_in_path('agy');
    if (inPath)
        return inPath;
    const localBin = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'agy']);
    if (GLib.file_test(localBin, GLib.FileTest.IS_EXECUTABLE))
        return localBin;
    return null;
}

export async function agyCredentialsAvailable(configDir = defaultAgyConfigDir()) {
    const tok = await readAgyStoredToken(configDir);
    if (tok && (tok.accessToken || tok.refreshToken))
        return true;
    return Boolean(findAgyBinary());
}

export class AgyProvider {
    constructor(source, settings = null) {
        this.source = source;
        this.kind = 'agy';
        this.usageUrl = 'https://one.google.com/ai';
        this._configDir = source.configDir || defaultAgyConfigDir();
        this._settings = settings;
        this._session = new Soup.Session();
        this._session.timeout = 15;
    }

    async quickTier() {
        const stored = await readAgyStoredToken(this._configDir);
        const label = tierLabel(stored?.tierDisplayName || stored?.userTier);
        return label ? {label} : null;
    }

    _request(method, url, {token, jsonBody, cancellable = null} = {}) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new(method, url);
            const headers = msg.get_request_headers();
            headers.append('Accept', 'application/json');
            if (token)
                headers.append('Authorization', `Bearer ${token}`);
            if (jsonBody !== undefined) {
                const raw = encoder.encode(JSON.stringify(jsonBody));
                msg.set_request_body_from_bytes('application/json', new GLib.Bytes(raw));
            }
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
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

    async _refreshGoogleToken(refreshToken, cancellable) {
        const data = await this._request('POST', GOOGLE_TOKEN_URL, {
            cancellable,
            jsonBody: {
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: AGY_CLIENT_ID,
                client_secret: AGY_CLIENT_SECRET,
            },
        });
        if (!data.access_token)
            throw new UsageError('Google token refresh missing access_token');
        return data;
    }

    async _resolveToken(cancellable) {
        const stored = await readAgyStoredToken(this._configDir, cancellable);
        if (stored) {
            if (stored.accessToken && (!stored.expiresAt || stored.expiresAt - Date.now() > REFRESH_SKEW_MS))
                return stored;
            if (stored.refreshToken) {
                const refreshed = await this._refreshGoogleToken(stored.refreshToken, cancellable);
                stored.accessToken = refreshed.access_token;
                if (refreshed.id_token)
                    stored.idToken = refreshed.id_token;
                if (refreshed.expires_in) {
                    const expiryIso = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
                    if (stored.raw.token && typeof stored.raw.token === 'object') {
                        stored.raw.token.access_token = refreshed.access_token;
                        stored.raw.token.expiry = expiryIso;
                    } else {
                        stored.raw.access_token = refreshed.access_token;
                        stored.raw.expiry = expiryIso;
                    }
                }
                if (stored.path) {
                    try {
                        await writeJsonFile(stored.path, stored.raw);
                    } catch {
                        // Best-effort persistence.
                    }
                }
                return stored;
            }
        }

        const inApp = this._settings ? getToken(this._settings, this.source.id) : null;
        if (inApp) {
            if (inApp.expiresAt && inApp.expiresAt - Date.now() <= REFRESH_SKEW_MS && inApp.refreshToken) {
                const refreshed = await this._refreshGoogleToken(inApp.refreshToken, cancellable);
                const expiresAt = Date.now() + (refreshed.expires_in ?? 3600) * 1000;
                setToken(this._settings, this.source.id, {
                    accessToken: refreshed.access_token,
                    refreshToken: refreshed.refresh_token || inApp.refreshToken,
                    expiresAt,
                });
                return {accessToken: refreshed.access_token, raw: {}};
            }
            return {accessToken: inApp.accessToken, raw: {}};
        }

        return null;
    }

    async _postInternal(path, token, body, cancellable) {
        let lastErr = null;
        for (const base of ENDPOINTS) {
            try {
                return await this._request('POST', `${base}${path}`, {
                    token,
                    jsonBody: body,
                    cancellable,
                });
            } catch (e) {
                lastErr = e;
                if (e instanceof UsageError && (e.status === 401 || e.status === 403))
                    break;
            }
        }
        throw lastErr;
    }

    _runCliCommand(slashCmd, cancellable) {
        const bin = findAgyBinary();
        if (!bin)
            return Promise.resolve(null);
        return new Promise(resolve => {
            try {
                const launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                if (this._configDir)
                    launcher.setenv('AGY_APP_DATA_DIR', this._configDir, true);
                const proc = launcher.spawnv([bin, '-p', slashCmd, '--output-format', 'json']);
                proc.communicate_utf8_async(null, cancellable, (p, res) => {
                    try {
                        const [ok, stdout] = p.communicate_utf8_finish(res);
                        if (!ok || !stdout) {
                            resolve(null);
                            return;
                        }
                        resolve(JSON.parse(stdout.trim()));
                    } catch {
                        resolve(null);
                    }
                });
            } catch {
                resolve(null);
            }
        });
    }

    async fetch(cancellable) {
        let stored = null;
        try {
            stored = await this._resolveToken(cancellable);
        } catch (e) {
            logError(e, `Quota: token resolution failed for "${this.source.label}", trying CLI fallback`);
        }

        if (stored?.accessToken) {
            try {
                const assist = await this._postInternal(
                    '/v1internal:loadCodeAssist',
                    stored.accessToken,
                    {metadata: {ideType: 'ANTIGRAVITY', pluginType: 'GEMINI'}},
                    cancellable
                ).catch(() => null);

                const rawProj = assist?.cloudaicompanionProject;
                const projectId = (typeof rawProj === 'string' ? rawProj : rawProj?.id) || stored.projectId || '';
                const quota = await this._postInternal(
                    '/v1internal:retrieveUserQuotaSummary',
                    stored.accessToken,
                    projectId ? {project: projectId} : {},
                    cancellable
                );

                const model = normalizeAgy(quota, assist, stored.raw);
                return {
                    subtitle: model.subtitle,
                    tier: model.tier,
                    windows: model.windows,
                    lines: model.lines.map(text => ({text, level: null})),
                };
            } catch (e) {
                // Fall back to CLI printmode if available before surfacing an error.
                const cliSnap = await this._fetchViaCli(stored.raw, cancellable);
                if (cliSnap)
                    return cliSnap;
                throw e;
            }
        }

        const cliSnap = await this._fetchViaCli(null, cancellable);
        if (cliSnap)
            return cliSnap;

        throw new SignedOutError('Not signed in. Run `agy auth login` in a terminal to connect your Google subscription.');
    }

    async _fetchViaCli(rawToken, cancellable) {
        const [usageJson, creditsJson] = await Promise.all([
            this._runCliCommand('/usage', cancellable),
            this._runCliCommand('/credits', cancellable),
        ]);
        if (!usageJson?.command?.data && !creditsJson?.command?.data)
            return null;
        const model = normalizeAgy(usageJson ?? {}, creditsJson ?? {}, rawToken);
        if (!model.windows.length && !model.tier && !model.lines.length)
            return null;
        return {
            subtitle: model.subtitle,
            tier: model.tier,
            windows: model.windows,
            lines: model.lines.map(text => ({text, level: null})),
        };
    }

    describeError(e) {
        if (e instanceof UsageError && e.status === 401)
            return 'Google session expired. Sign in again with `agy auth login`.';
        if (e instanceof UsageError && e.status === 403)
            return e.apiMessage() || 'No active Google AI / Antigravity quota for this account.';
        if (e instanceof UsageError && e.status === 429)
            return 'Google is rate limiting quota checks. Trying again shortly.';
        return e.message || 'Could not reach Google Antigravity';
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }
}
