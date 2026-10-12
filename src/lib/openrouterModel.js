// Pure data-shaping for OpenRouter: turns the GET /api/v1/key payload (and,
// with a management key, GET /api/v1/credits) into the same normalised windows
// the Claude model produces, so the panel gauges and popup meters render them
// unchanged. No GI or shell imports, so it runs under plain `node`
// (tools/test-openrouterModel.mjs).
//
// A window here is {key, label, tag, role, utilization, resetsAt, totalSeconds,
// apiLevel, isActive, order, detail}: `tag` is the short panel tag, `detail` a
// money caption for the popup meter ("$1.20 of $5.00").

const DAY = 24 * 3600;
const INTERVAL_SECONDS = {daily: DAY, weekly: 7 * DAY};

const SCOPE_LABEL = {
    key_limit: 'Key limit',
    api_key: 'Key budget',
    member: 'Member budget',
    workspace: 'Workspace budget',
    workspace_default_member: 'Default member budget',
    workspace_default_key: 'Default key budget',
};

const INTERVAL_TAG = {daily: '1d', weekly: '7d', monthly: '1mo'};
const INTERVAL_WORD = {daily: 'daily', weekly: 'weekly', monthly: 'monthly'};

export function money(v) {
    const n = Number(v);
    if (!Number.isFinite(n))
        return null;
    return `$${n.toFixed(2)}`;
}

function pct(used, limit) {
    const u = Number(used);
    const l = Number(limit);
    if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0)
        return null;
    return Math.max(0, (u / l) * 100);
}

// Start of the next UTC period after `now` (ms), as ISO, for a reset interval.
// Weekly periods start on Monday, as OpenRouter's usage_weekly does.
export function nextUtcReset(interval, now = Date.now()) {
    const d = new Date(now);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const day = d.getUTCDate();
    switch (interval) {
    case 'daily':
        return new Date(Date.UTC(y, m, day + 1)).toISOString();
    case 'weekly': {
        const sinceMonday = (d.getUTCDay() + 6) % 7;
        return new Date(Date.UTC(y, m, day - sinceMonday + 7)).toISOString();
    }
    case 'monthly':
        return new Date(Date.UTC(y, m + 1, 1)).toISOString();
    default:
        return null;
    }
}

// Length of the window ending at `resetsAt` for an interval, in seconds. A
// month is measured back from its reset, since months differ in length.
export function intervalSeconds(interval, resetsAt) {
    if (INTERVAL_SECONDS[interval])
        return INTERVAL_SECONDS[interval];
    if (interval === 'monthly') {
        const end = Date.parse(resetsAt ?? '');
        if (Number.isNaN(end))
            return 30 * DAY;
        const e = new Date(end);
        const start = Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - 1, e.getUTCDate(),
            e.getUTCHours(), e.getUTCMinutes(), e.getUTCSeconds());
        return (end - start) / 1000;
    }
    return null;
}

function budgetWindow(b, i, effective) {
    const interval = b.reset_interval ?? null;
    const resetsAt = b.resets_at ?? (interval ? nextUtcReset(interval) : null);
    const base = SCOPE_LABEL[b.scope] ?? 'Budget';
    const label = interval ? `${base} (${INTERVAL_WORD[interval] ?? interval})` : base;
    return {
        key: `or:budget:${b.scope}:${b.budget_id ?? b.guardrail_id ?? i}:${interval ?? 'none'}`,
        label,
        tag: INTERVAL_TAG[interval] ?? 'lim',
        role: 'budget',
        utilization: pct(b.spend_usd, b.limit_usd),
        resetsAt,
        totalSeconds: intervalSeconds(interval, resetsAt),
        apiLevel: Number(b.remaining_usd) <= 0 ? 'crit' : 'ok',
        isActive: effective,
        order: effective ? 0 : 1,
        detail: `${money(b.spend_usd)} of ${money(b.limit_usd)}`,
    };
}

// The key's own credit limit, from the flat fields, for responses that carry
// no budgets[] array.
function keyLimitWindow(key) {
    const limit = Number(key.limit);
    const remaining = Number(key.limit_remaining);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining))
        return null;
    const interval = key.limit_reset ?? null;
    const resetsAt = interval ? nextUtcReset(interval) : null;
    const used = limit - remaining;
    return {
        key: 'or:key-limit',
        label: interval ? `Key limit (${INTERVAL_WORD[interval] ?? interval})` : 'Key limit',
        tag: INTERVAL_TAG[interval] ?? 'lim',
        role: 'budget',
        utilization: pct(used, limit),
        resetsAt,
        totalSeconds: intervalSeconds(interval, resetsAt),
        apiLevel: remaining <= 0 ? 'crit' : 'ok',
        isActive: true,
        order: 0,
        detail: `${money(used)} of ${money(limit)}`,
    };
}

function creditsWindow(credits) {
    const total = Number(credits?.total_credits);
    const used = Number(credits?.total_usage);
    if (!Number.isFinite(total) || !Number.isFinite(used))
        return null;
    return {
        key: 'or:credits',
        label: 'Credits used',
        tag: '$',
        role: 'credits',
        // Nothing bought yet: no share to show, so the meter reads muted.
        utilization: total > 0 ? Math.min(100, (used / total) * 100) : NaN,
        resetsAt: null,
        totalSeconds: null,
        apiLevel: total - used <= 0 ? 'crit' : 'ok',
        isActive: true,
        order: 2,
        detail: `${money(Math.max(0, total - used))} left of ${money(total)}`,
    };
}

function freeRequestsWindow(free) {
    const limit = Number(free?.limit);
    const used = Number(free?.used);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used))
        return null;
    return {
        key: 'or:free-requests',
        label: 'Free model requests (daily)',
        tag: 'free',
        role: 'free',
        utilization: pct(used, limit),
        resetsAt: nextUtcReset('daily'),
        totalSeconds: DAY,
        apiLevel: Number(free.remaining) <= 0 ? 'crit' : 'ok',
        isActive: true,
        order: 3,
        detail: `${used} of ${limit} requests`,
    };
}

// Everything the view shows for one OpenRouter account. `key` is the `data`
// of GET /api/v1/key, `credits` the `data` of GET /api/v1/credits or null
// (no management key, or it was refused).
//   {windows, tier: {label, panelLabel}, lines: [string], balance}
export function normalizeOpenRouter(key, credits = null) {
    const windows = [];
    const budgets = Array.isArray(key?.budgets) ? key.budgets : [];
    const effective = key?.effective_budget ?? null;
    const sameBudget = (a, b) => !!a && !!b && a.scope === b.scope &&
        (a.budget_id ?? a.guardrail_id) === (b.budget_id ?? b.guardrail_id) &&
        a.reset_interval === b.reset_interval;
    budgets.forEach((b, i) => {
        const w = budgetWindow(b, i, sameBudget(b, effective));
        if (Number.isFinite(w.utilization))
            windows.push(w);
    });
    if (!windows.length) {
        const w = keyLimitWindow(key ?? {});
        if (w)
            windows.push(w);
    }
    const cw = creditsWindow(credits);
    if (cw)
        windows.push(cw);
    // Free-model requests only constrain an account that has never paid.
    if (key?.is_free_tier) {
        const fw = freeRequestsWindow(key.free_model_daily_requests);
        if (fw)
            windows.push(fw);
    }
    windows.sort((a, b) => a.order - b.order);

    const balance = cw ? Number(credits.total_credits) - Number(credits.total_usage) : null;
    const spent = ['usage_daily', 'usage_weekly', 'usage_monthly']
        .map((k, i) => [['today', 'this week', 'this month'][i], money(key?.[k])])
        .filter(([, v]) => v !== null)
        .map(([when, v]) => `${v} ${when}`);
    const lines = [];
    if (spent.length)
        lines.push(`Spent: ${spent.join(' · ')}`);
    if (Number(key?.byok_usage_monthly) > 0)
        lines.push(`BYOK this month: ${money(key.byok_usage_monthly)}`);
    if (balance !== null)
        lines.push(`Balance: ${money(balance)}`);

    return {
        windows,
        tier: {
            label: key?.is_free_tier ? 'Free' : 'Pay as you go',
            // The panel's text slot carries money, the number people watch:
            // the balance when a management key reveals it, else today's spend.
            panelLabel: balance !== null ? money(balance)
                : money(key?.usage_daily) !== null ? `${money(key.usage_daily)} today` : '',
        },
        lines,
        balance,
    };
}

// Which windows the panel shows for OpenRouter: the budget that blocks first
// (or the key limit), else the credits, else the free requests. Several would
// only repeat the same money; the popup lists them all.
export function selectOpenRouterPanelWindows(windows) {
    const pick = windows.find(w => w.role === 'budget' && w.isActive)
        ?? windows.find(w => w.role === 'budget')
        ?? windows.find(w => w.role === 'credits' && Number.isFinite(w.utilization))
        ?? windows.find(w => w.role === 'free');
    return pick ? [pick] : [];
}
