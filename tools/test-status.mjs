#!/usr/bin/env node
// Unit tests for the pace judgement and the overall status (the Monolito
// mark's color and the menu's status line). Runs under plain node (no GI):
//   node tools/test-status.mjs
import assert from 'node:assert/strict';
import {
    windowLevel, judgeWindow, projectionNote, humanDuration, relativeReset, clockTime,
    claudeAccountStatus, openRouterExhausted, overallStatus,
} from '../src/lib/status.js';
import {normalizeOpenRouter} from '../src/lib/openrouterModel.js';

let passed = 0;
const test = (name, fn) => {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
};

const H = 3600;
const FIVE = 5 * H;
const WEEK = 7 * 24 * H;
// A fixed local "now", so clock times are predictable in any time zone.
const NOW = new Date(2026, 9, 17, 17, 20, 0).getTime();
const at = s => new Date(NOW + s * 1000).toISOString();

// A Claude window: `left` seconds until its reset.
const session = (util, left, extra = {}) => ({
    key: 's', label: '5-Hour Session', role: 'session', utilization: util,
    resetsAt: at(left), totalSeconds: FIVE, apiLevel: 'ok', ...extra,
});
const weekly = (util, left, extra = {}) => ({
    key: 'w', label: 'Weekly', role: 'weekly', utilization: util,
    resetsAt: at(left), totalSeconds: WEEK, apiLevel: 'ok', ...extra,
});
const fable = (util, left) => ({
    key: 'f', label: 'Weekly · Fable', role: 'scoped', utilization: util,
    resetsAt: at(left), totalSeconds: WEEK, apiLevel: util >= 100 ? 'crit' : 'ok',
});
const claude = (windows, result = 'ok') => ({kind: 'claude', label: 'Claude', result, windows});
const agy = (windows, result = 'ok') => ({kind: 'agy', label: 'Google AI', result, windows});
const router = (windows, result = 'ok', label = 'OpenRouter') => ({kind: 'openrouter', label, result, windows});

// --- durations and times ---
test('humanDuration: two largest units, spelled out', () => {
    assert.equal(humanDuration(30), '30 s');
    assert.equal(humanDuration(45 * 60), '45 min');
    assert.equal(humanDuration(80 * 60), '1 h 20 min');
    assert.equal(humanDuration(2 * H), '2 h');
    assert.equal(humanDuration(53 * H), '2 d 5 h');
    assert.equal(humanDuration(48 * H), '2 d');
    assert.equal(humanDuration(-5), '0 s');
});

test('relativeReset and clockTime', () => {
    assert.equal(relativeReset(at(80 * 60), NOW), 'Resets in 1 h 20 min');
    assert.equal(relativeReset(at(-1), NOW), 'Resetting…');
    assert.equal(relativeReset(null, NOW), '');
    assert.equal(clockTime(NOW + 80 * 60 * 1000, NOW), '18:40');
    // More than most of a day away: the weekday too (17 Oct 2026 is a Saturday).
    assert.equal(clockTime(NOW + 2 * 24 * H * 1000, NOW), 'Mon 17:20');
});

// --- window levels ---
test('windowLevel: calm, full, and projected', () => {
    // 4 h into the 5-hour window at 20%: calm.
    assert.equal(windowLevel(20, at(H), FIVE, NOW), 'ok');
    // 92% right now: critical whatever the pace.
    assert.equal(windowLevel(92, at(4 * H), FIVE, NOW), 'crit');
    // 1 h in at 40%: runs out after 2.5 h, locked out 1.5 h (30%): critical.
    assert.equal(windowLevel(40, at(4 * H), FIVE, NOW), 'crit');
    // 4 h in at 85%: runs out ~42 min in, 18 min before the reset (6%): warn.
    assert.equal(windowLevel(85, at(H), FIVE, NOW), 'warn');
    // 4 h in at 64%: on track for 80% by the reset: warn, never critical.
    assert.equal(windowLevel(64, at(H), FIVE, NOW), 'warn');
    // Too early in the window to extrapolate.
    assert.equal(windowLevel(10, at(FIVE - 60), FIVE, NOW), 'ok');
});

test('judgeWindow floors at the API severity', () => {
    assert.equal(judgeWindow(session(10, H, {apiLevel: 'crit'}), NOW), 'crit');
    assert.equal(judgeWindow(session(10, H), NOW), 'ok');
});

test('projectionNote says the pace in words', () => {
    assert.equal(projectionNote(40, at(4 * H), FIVE, NOW), 'runs out in 1 h 30 min at this pace');
    assert.equal(projectionNote(85, at(H), FIVE, NOW), 'may run out just before the reset');
    assert.equal(projectionNote(64, at(H), FIVE, NOW), 'on track for 80% by the reset');
    assert.equal(projectionNote(20, at(H), FIVE, NOW), '');
    assert.equal(projectionNote(100, at(14 * 24 * H), 31 * 24 * H, NOW), '');
});

// --- one Claude account ---
test('claudeAccountStatus: worst of the 5-hour and weekly windows', () => {
    assert.equal(claudeAccountStatus([session(20, H), weekly(30, 3 * 24 * H)], NOW).state, 'good');
    const tight = claudeAccountStatus([session(85, H), weekly(30, 3 * 24 * H)], NOW);
    assert.equal(tight.state, 'tight');
    assert.equal(tight.window.key, 's');
    assert.equal(claudeAccountStatus([session(20, H), weekly(93, 3 * 24 * H)], NOW).state, 'critical');
    assert.equal(claudeAccountStatus([session(100, H), weekly(30, 3 * 24 * H)], NOW).state, 'out');
    assert.equal(claudeAccountStatus([], NOW), null);
});

test('claudeAccountStatus: a per-model window does not color the mark', () => {
    const st = claudeAccountStatus([session(8, H), weekly(60, 24 * H), fable(100, 24 * H)], NOW);
    assert.equal(st.state, 'good');
    // Unless it is all there is.
    assert.equal(claudeAccountStatus([fable(100, 6 * 24 * H)], NOW).state, 'out');
});

test('claudeAccountStatus: out until the last full limit resets', () => {
    const st = claudeAccountStatus([session(100, H), weekly(100, 2 * H)], NOW);
    assert.equal(st.state, 'out');
    assert.equal(st.resetsAt, NOW + 2 * H * 1000);
});

// --- OpenRouter ---
test('openRouterExhausted: a spent budget, limit or balance; never credits never bought', () => {
    const spent = normalizeOpenRouter({budgets: [{scope: 'api_key', limit_usd: 1, spend_usd: 1,
        remaining_usd: 0, reset_interval: 'daily'}]});
    assert.equal(openRouterExhausted(spent.windows), true);
    const empty = normalizeOpenRouter({}, {total_credits: 10, total_usage: 10});
    assert.equal(openRouterExhausted(empty.windows), true);
    const fine = normalizeOpenRouter({}, {total_credits: 10, total_usage: 2});
    assert.equal(openRouterExhausted(fine.windows), false);
    const neverBought = normalizeOpenRouter({}, {total_credits: 0, total_usage: 0});
    assert.equal(openRouterExhausted(neverBought.windows), false);
    assert.equal(openRouterExhausted([]), false);
});

// --- the overall status ---
test('overallStatus: the four colors, in words', () => {
    assert.deepEqual(overallStatus([claude([session(20, H), weekly(30, 3 * 24 * H)])], NOW),
        {state: 'good', text: 'Ready to work', percent: 30});
    assert.deepEqual(overallStatus([claude([session(64, 80 * 60), weekly(30, 3 * 24 * H)])], NOW),
        {state: 'tight', text: 'Pace is tight: 5-hour limit resets in 1 h 20 min', percent: 64});
    assert.deepEqual(overallStatus([claude([session(20, H), weekly(93, 53 * H)])], NOW),
        {state: 'critical', text: 'Nearly out: weekly limit at 93%, resets in 2 d 5 h', percent: 93});
    assert.deepEqual(overallStatus([claude([session(40, 4 * H), weekly(30, 3 * 24 * H)])], NOW),
        {state: 'critical', text: 'Burning fast: 5-hour limit runs out in 1 h 30 min', percent: 40});
    assert.deepEqual(overallStatus([claude([session(100, 80 * 60), weekly(30, 3 * 24 * H)])], NOW),
        {state: 'out', text: 'Out of tokens until 18:40', percent: 100});
});

test('overallStatus: dim while unknown', () => {
    assert.equal(overallStatus([], NOW).state, 'unknown');
    assert.equal(overallStatus([claude([], null)], NOW).text, 'Checking usage…');
    assert.equal(overallStatus([claude([], 'signed-out')], NOW).text, 'Not signed in to Claude');
    assert.equal(overallStatus([claude([], 'error')], NOW).text, 'Usage unavailable right now');
    for (const r of [null, 'signed-out', 'error'])
        assert.equal(overallStatus([claude([], r)], NOW).state, 'unknown');
});

test('overallStatus: OpenRouter only ever turns it red', () => {
    const ok = [session(20, H)];
    const tightOR = normalizeOpenRouter({budgets: [{scope: 'api_key', limit_usd: 1, spend_usd: 0.95,
        remaining_usd: 0.05, reset_interval: 'daily'}]});
    assert.equal(overallStatus([claude(ok), router(tightOR.windows)], NOW).state, 'good');
    const empty = normalizeOpenRouter({}, {total_credits: 10, total_usage: 10});
    assert.deepEqual(overallStatus([claude(ok), router(empty.windows)], NOW),
        {state: 'out', text: 'OpenRouter is out of credit', percent: 20});
    // A signed-out or failing OpenRouter account changes nothing.
    assert.equal(overallStatus([claude(ok), router([], 'signed-out'), router([], 'error')], NOW).state, 'good');
    // Claude being out says so first.
    assert.equal(overallStatus([claude([session(100, 80 * 60)]), router(empty.windows)], NOW).text,
        'Out of tokens until 18:40');
    // OpenRouter alone, and fine: ready.
    assert.equal(overallStatus([router(tightOR.windows)], NOW).state, 'good');
    // OpenRouter fine, Claude still loading: unknown, not green.
    assert.equal(overallStatus([claude([], null), router(tightOR.windows)], NOW).state, 'unknown');
});

test('overallStatus: the account with the most room decides', () => {
    const out = claude([session(100, H)]);
    const fine = {...claude([session(10, H)]), label: 'Work'};
    assert.equal(overallStatus([out, fine], NOW).state, 'good');
    // One account failing does not hide the other's usage.
    assert.equal(overallStatus([claude([], 'error'), claude([session(85, H)])], NOW).state, 'tight');
});

test('overallStatus: Antigravity (agy) subscription limits participate alongside Claude', () => {
    const agyWin = {
        key: 'agy:pro', label: 'Gemini 3.1 Pro', role: 'quota',
        utilization: 94, resetsAt: at(2 * H), totalSeconds: FIVE, apiLevel: 'ok',
    };
    assert.deepEqual(overallStatus([agy([agyWin])], NOW), {
        state: 'critical',
        text: 'Nearly out: Gemini 3.1 Pro limit at 94%, resets in 2 h',
        percent: 94,
    });
    const geminiOk = {
        key: 'agy:Gemini Models:gemini-5h', label: 'Gemini Models · 5-hour limit', role: 'session',
        utilization: 8, resetsAt: at(2 * H), totalSeconds: FIVE, apiLevel: 'ok',
    };
    const thirdPartyOut = {
        key: 'agy:Claude and GPT models:3p-5h', label: 'Claude and GPT models · 5-hour limit', role: 'quota',
        utilization: 100, resetsAt: at(80 * 60), totalSeconds: FIVE, apiLevel: 'crit',
    };
    assert.deepEqual(overallStatus([agy([geminiOk, thirdPartyOut])], NOW), {
        state: 'out',
        text: 'Out of tokens until 18:40',
        percent: 100,
    });
    assert.equal(overallStatus([agy([], 'signed-out')], NOW).text, 'Not signed in to Antigravity');
});

console.log(`\n${passed} tests passed`);
