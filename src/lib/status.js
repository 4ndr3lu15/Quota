// Pure judgement of usage: how serious each window is at the current pace,
// and the one overall state the top bar's Monolito mark and the menu's status
// line show. No GI or shell imports, so it runs under plain `node`
// (tools/test-status.mjs). Every function that depends on the clock takes
// `now` (epoch ms) so the tests can pin it.

// Severity of one window, least to most severe.
export const LEVEL_RANK = {ok: 0, warn: 1, crit: 2};

// The overall states, least to most severe; 'unknown' (loading, signed out,
// an error, no accounts) sits apart and is drawn dim.
export const STATE_RANK = {good: 0, tight: 1, critical: 2, out: 3};

// Being locked out for at least this fraction of the window makes a fast burn
// critical. A shorter lockout (running out just before the reset) only
// warrants a warning.
const LOCKOUT_CRIT_FRAC = 0.10;

export function maxLevel(a, b) {
    return (LEVEL_RANK[a] ?? 0) >= (LEVEL_RANK[b] ?? 0) ? a : b;
}

// Severity from a raw utilization %: how full the bucket is right now.
export function utilLevel(util) {
    if (util >= 90)
        return 'crit';
    if (util >= 75)
        return 'warn';
    return 'ok';
}

// Seconds until a reset timestamp, or null when it is missing or past.
function remainingSeconds(resetsAtIso, now) {
    const target = Date.parse(resetsAtIso ?? '');
    if (Number.isNaN(target))
        return null;
    const remaining = (target - now) / 1000;
    return remaining > 0 ? remaining : null;
}

// Projected end-of-window utilization at the current consumption rate: the
// larger of actual and projected, or actual when the window has barely
// started (too little signal) or reports no reset time.
export function projectedUtil(util, resetsAtIso, totalSeconds, now = Date.now()) {
    const remaining = remainingSeconds(resetsAtIso, now);
    if (remaining === null || !totalSeconds)
        return util;
    const elapsed = totalSeconds - remaining;
    if (elapsed <= 0 || elapsed / totalSeconds < 0.05)
        return util;
    return Math.max(util, (util * totalSeconds) / elapsed);
}

// Seconds from now until utilization would hit 100% at the average rate so
// far this window, but only when that lands before the window resets (the
// pace really does overrun the limit); null otherwise. Same early-window
// guard as projectedUtil, so noise is not extrapolated.
export function exhaustSeconds(util, resetsAtIso, totalSeconds, now = Date.now()) {
    const remaining = remainingSeconds(resetsAtIso, now);
    if (remaining === null || !totalSeconds || !(util > 0))
        return null;
    const elapsed = totalSeconds - remaining;
    if (elapsed <= 0 || elapsed / totalSeconds < 0.05)
        return null;
    const toExhaust = (elapsed * (100 - util)) / util;
    return toExhaust > 0 && toExhaust < remaining ? toExhaust : null;
}

// How long you would be stuck at the limit before the window resets, in
// seconds, at the current pace, or null when the pace does not run out.
export function lockoutSeconds(util, resetsAtIso, totalSeconds, now = Date.now()) {
    const exhaust = exhaustSeconds(util, resetsAtIso, totalSeconds, now);
    if (exhaust === null)
        return null;
    return Math.max(0, remainingSeconds(resetsAtIso, now) - exhaust);
}

// Severity for a usage window, by the *consequence* of the current pace
// rather than the raw projected percentage: critical means out of headroom
// now, or locked out for a meaningful stretch; a pace that only just overruns
// right before the reset stays a warning.
export function windowLevel(util, resetsAtIso, totalSeconds, now = Date.now()) {
    let level = utilLevel(util);
    const lockout = lockoutSeconds(util, resetsAtIso, totalSeconds, now);
    if (lockout !== null)
        level = maxLevel(level, lockout >= totalSeconds * LOCKOUT_CRIT_FRAC ? 'crit' : 'warn');
    else if (projectedUtil(util, resetsAtIso, totalSeconds, now) >= 75)
        level = maxLevel(level, 'warn');
    return level;
}

// A normalised window's level, floored at the API's own severity, so a
// window the API flags never reads calmer than the API says.
export function judgeWindow(w, now = Date.now()) {
    return maxLevel(windowLevel(w.utilization, w.resetsAt, w.totalSeconds, now), w.apiLevel ?? 'ok');
}

// "45 s", "12 min", "1 h 20 min", "2 d 5 h": the two largest units.
export function humanDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60)
        return `${s} s`;
    const mins = Math.round(s / 60);
    if (mins < 60)
        return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return mins % 60 ? `${hrs} h ${mins % 60} min` : `${hrs} h`;
    const days = Math.floor(hrs / 24);
    return hrs % 24 ? `${days} d ${hrs % 24} h` : `${days} d`;
}

export function relativeReset(iso, now = Date.now()) {
    const target = Date.parse(iso ?? '');
    if (Number.isNaN(target))
        return '';
    const diff = target - now;
    if (diff <= 0)
        return 'Resetting…';
    return `Resets in ${humanDuration(diff / 1000)}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');

// A local clock time for a moment ahead: "18:40" within a day, else with
// the weekday ("Mon 18:40").
export function clockTime(ms, now = Date.now()) {
    const d = new Date(ms);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return ms - now < 20 * 3600 * 1000 ? hm : `${WEEKDAYS[d.getDay()]} ${hm}`;
}

// What the pace means, for a meter's caption; tied to the same lockout
// threshold as windowLevel so a warning never reads "runs out".
export function projectionNote(util, resetsAtIso, totalSeconds, now = Date.now()) {
    // Used up already: nothing left to project.
    if (util >= 100)
        return '';
    const lockout = lockoutSeconds(util, resetsAtIso, totalSeconds, now);
    if (lockout !== null) {
        if (lockout >= totalSeconds * LOCKOUT_CRIT_FRAC)
            return `runs out in ${humanDuration(exhaustSeconds(util, resetsAtIso, totalSeconds, now))} at this pace`;
        return 'may run out just before the reset';
    }
    const proj = projectedUtil(util, resetsAtIso, totalSeconds, now);
    if (proj >= 75 && Math.round(proj) > Math.round(util))
        return `on track for ${Math.round(proj)}% by the reset`;
    return '';
}

// The window's name inside a sentence: "5-hour limit", "weekly limit",
// "Weekly · Fable limit".
function windowName(w) {
    if (w.role === 'session')
        return '5-hour limit';
    if (w.role === 'weekly')
        return 'weekly limit';
    return `${w.label} limit`;
}

const usable = w => w && Number.isFinite(w.utilization);

// One Claude account's state: the worst of its 5-hour and weekly windows
// (per-model windows only block that model, so they color their own meter
// but not the mark; an account that reports nothing else falls back to all
// of its windows).
//   {state, window, level, resetsAt}
export function claudeAccountStatus(windows, now = Date.now()) {
    const all = (windows ?? []).filter(usable);
    const main = all.filter(w => w.role === 'session' || w.role === 'weekly');
    const pool = main.length ? main : all;
    if (!pool.length)
        return null;

    // Out: a limit is used up. It frees up when the last full one resets.
    const full = pool.filter(w => w.utilization >= 100);
    if (full.length) {
        const resets = full.map(w => Date.parse(w.resetsAt ?? '')).filter(t => !Number.isNaN(t));
        const window = full[0];
        return {state: 'out', window, level: 'crit', resetsAt: resets.length ? Math.max(...resets) : null};
    }

    // Else the most severe window, the fuller one on a tie.
    let worst = null;
    let worstLevel = 'ok';
    for (const w of pool) {
        const level = judgeWindow(w, now);
        if (!worst || LEVEL_RANK[level] > LEVEL_RANK[worstLevel] ||
            (level === worstLevel && w.utilization > worst.utilization)) {
            worst = w;
            worstLevel = level;
        }
    }
    const state = worstLevel === 'crit' ? 'critical' : worstLevel === 'warn' ? 'tight' : 'good';
    return {state, window: worst, level: worstLevel, resetsAt: Date.parse(worst.resetsAt ?? '') || null};
}

// An OpenRouter account is out when a budget, the key's limit, the free
// requests or the bought credits are used up. Credits never bought (no
// share to measure) do not count.
export function openRouterExhausted(windows) {
    return (windows ?? []).some(w => usable(w) && (w.utilization >= 100 || w.apiLevel === 'crit'));
}

// The sentence for a judged Claude account.
function claudeText(st, now) {
    const w = st.window;
    const left = st.resetsAt ? humanDuration((st.resetsAt - now) / 1000) : null;
    switch (st.state) {
    case 'out':
        return st.resetsAt ? `Out of tokens until ${clockTime(st.resetsAt, now)}` : 'Out of tokens';
    case 'critical': {
        const exhaust = exhaustSeconds(w.utilization, w.resetsAt, w.totalSeconds, now);
        if (w.utilization < 90 && exhaust !== null)
            return `Burning fast: ${windowName(w)} runs out in ${humanDuration(exhaust)}`;
        return `Nearly out: ${windowName(w)} at ${Math.round(w.utilization)}%` +
            (left ? `, resets in ${left}` : '');
    }
    case 'tight':
        return left ? `Pace is tight: ${windowName(w)} resets in ${left}`
            : `Pace is tight: ${windowName(w)} at ${Math.round(w.utilization)}%`;
    default:
        return 'Ready to work';
    }
}

// The one state for everything Quota watches, and its sentence for the menu.
// `sources` is one entry per account:
//   {kind: 'claude' | 'agy' | 'openrouter', label, result, windows}
// where `result` is null while the first fetch runs, else 'ok', 'error' or
// 'signed-out'.
//
// Subscription accounts (Claude and Antigravity) decide the color: each
// account is judged by the worst of its limits, and the state is the best
// account's, since any account with room is one you can work with. OpenRouter
// only turns it red, when an account's balance or budget is used up. With no
// subscription usage to judge, the state is 'unknown' (drawn dim), unless
// OpenRouter alone says you are fine or out.
//   {state: 'unknown' | 'good' | 'tight' | 'critical' | 'out', text}
export function overallStatus(sources, now = Date.now()) {
    const list = sources ?? [];
    if (!list.length)
        return {state: 'unknown', text: 'No accounts yet'};

    const subs = list.filter(s => s.kind === 'claude' || s.kind === 'agy');
    const router = list.filter(s => s.kind === 'openrouter');

    let best = null;
    for (const s of subs) {
        if (s.result !== 'ok')
            continue;
        const st = claudeAccountStatus(s.windows, now);
        if (st && (!best || STATE_RANK[st.state] < STATE_RANK[best.state]))
            best = st;
    }

    const emptyRouter = router.find(s => s.result === 'ok' && openRouterExhausted(s.windows));
    const routerOk = router.some(s => s.result === 'ok');

    // The deciding subscription window's use, which the top bar shows by the mark.
    const percent = best ? Math.round(best.window.utilization) : null;
    if (best?.state === 'out')
        return {state: 'out', text: claudeText(best, now), percent};
    if (emptyRouter) {
        const name = router.length > 1 ? `OpenRouter (${emptyRouter.label})` : 'OpenRouter';
        return {state: 'out', text: `${name} is out of credit`, percent};
    }
    if (best)
        return {state: best.state, text: claudeText(best, now), percent};

    // No subscription usage to judge.
    if (!subs.length && routerOk)
        return {state: 'good', text: 'Ready to work'};
    if (list.some(s => s.result === null))
        return {state: 'unknown', text: 'Checking usage…'};
    if (subs.length && subs.every(s => s.result === 'signed-out')) {
        if (subs.every(s => s.kind === 'claude'))
            return {state: 'unknown', text: 'Not signed in to Claude'};
        if (subs.every(s => s.kind === 'agy'))
            return {state: 'unknown', text: 'Not signed in to Antigravity'};
        return {state: 'unknown', text: 'Not signed in'};
    }
    return {state: 'unknown', text: 'Usage unavailable right now'};
}
