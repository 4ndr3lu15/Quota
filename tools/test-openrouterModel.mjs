#!/usr/bin/env node
// Unit tests for the pure OpenRouter model. Runs under plain node (no GI):
//   node tools/test-openrouterModel.mjs
import assert from 'node:assert/strict';
import {
    normalizeOpenRouter, selectOpenRouterPanelWindows, nextUtcReset, intervalSeconds, money,
} from '../src/lib/openrouterModel.js';
import {windowTag} from '../src/lib/usageModel.js';

let passed = 0;
const test = (name, fn) => {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
};

// A paid key with a monthly key limit and a daily workspace budget, in the
// shape documented for GET /api/v1/key.
const paidKey = {
    label: 'sk-or-v1-abc...xyz',
    limit: 20,
    limit_reset: 'monthly',
    limit_remaining: 15,
    usage: 42.5,
    usage_daily: 0.42,
    usage_weekly: 3.1,
    usage_monthly: 5,
    byok_usage_monthly: 0,
    is_free_tier: false,
    free_model_daily_requests: {used: 3, limit: 1000, remaining: 997},
    budgets: [
        {scope: 'key_limit', guardrail_id: null, budget_id: null, limit_usd: 20, spend_usd: 5,
            remaining_usd: 15, reset_interval: 'monthly', resets_at: '2026-11-01T00:00:00Z', include_byok: false},
        {scope: 'workspace', guardrail_id: null, budget_id: 'b1', limit_usd: 2, spend_usd: 1.8,
            remaining_usd: 0.2, reset_interval: 'daily', resets_at: '2026-10-12T00:00:00Z', include_byok: false},
    ],
    effective_budget: {scope: 'workspace', guardrail_id: null, budget_id: 'b1', limit_usd: 2, spend_usd: 1.8,
        remaining_usd: 0.2, reset_interval: 'daily', resets_at: '2026-10-12T00:00:00Z', include_byok: false},
};

test('budgets become windows, the effective one first and active', () => {
    const {windows} = normalizeOpenRouter(paidKey);
    assert.equal(windows.length, 2);
    assert.equal(windows[0].label, 'Workspace budget (daily)');
    assert.equal(windows[0].isActive, true);
    assert.ok(Math.abs(windows[0].utilization - 90) < 1e-9);
    assert.equal(windows[0].resetsAt, '2026-10-12T00:00:00Z');
    assert.equal(windows[0].totalSeconds, 86400);
    assert.equal(windows[0].detail, '$1.80 of $2.00');
    assert.equal(windows[1].label, 'Key limit (monthly)');
    assert.equal(windows[1].utilization, 25);
    // October has 31 days.
    assert.equal(windows[1].totalSeconds, 31 * 86400);
});

test('a paid key shows no free-request window', () => {
    const {windows} = normalizeOpenRouter(paidKey);
    assert.ok(!windows.some(w => w.role === 'free'));
});

test('without budgets[] the flat key limit is used', () => {
    const {budgets: _b, effective_budget: _e, ...flat} = paidKey;
    const {windows} = normalizeOpenRouter(flat);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].key, 'or:key-limit');
    assert.equal(windows[0].utilization, 25);
    assert.equal(windows[0].detail, '$5.00 of $20.00');
});

test('an unlimited key with no budgets has no limit window', () => {
    const {windows} = normalizeOpenRouter({...paidKey, budgets: [], effective_budget: null,
        limit: null, limit_remaining: null});
    assert.deepEqual(windows, []);
});

test('credits add a window, the balance and the panel label', () => {
    const r = normalizeOpenRouter({...paidKey, budgets: [], limit: null}, {total_credits: 100.5, total_usage: 25.75});
    const cw = r.windows.find(w => w.role === 'credits');
    assert.ok(Math.abs(cw.utilization - 25.62189) < 1e-3);
    assert.equal(cw.detail, '$74.75 left of $100.50');
    assert.equal(r.balance, 74.75);
    assert.equal(r.tier.panelLabel, '$74.75');
    assert.ok(r.lines.includes('Balance: $74.75'));
});

test('without credits the panel label is today\'s spend', () => {
    const r = normalizeOpenRouter(paidKey);
    assert.equal(r.tier.panelLabel, '$0.42 today');
    assert.equal(r.tier.label, 'Pay as you go');
    assert.equal(r.lines[0], 'Spent: $0.42 today · $3.10 this week · $5.00 this month');
});

test('a free-tier key shows its daily free requests', () => {
    const r = normalizeOpenRouter({is_free_tier: true, usage_daily: 0,
        free_model_daily_requests: {used: 40, limit: 50, remaining: 10}});
    assert.equal(r.tier.label, 'Free');
    assert.equal(r.windows.length, 1);
    assert.equal(r.windows[0].utilization, 80);
    assert.equal(r.windows[0].detail, '40 of 50 requests');
    assert.equal(windowTag(r.windows[0]), 'free');
});

test('the panel shows the blocking budget, else credits, else free requests', () => {
    const a = normalizeOpenRouter(paidKey, {total_credits: 10, total_usage: 1});
    assert.equal(selectOpenRouterPanelWindows(a.windows)[0].label, 'Workspace budget (daily)');
    const b = normalizeOpenRouter({usage_daily: 1}, {total_credits: 10, total_usage: 1});
    assert.equal(selectOpenRouterPanelWindows(b.windows)[0].key, 'or:credits');
    assert.deepEqual(selectOpenRouterPanelWindows([]), []);
});

test('a spent budget is critical by the API\'s own numbers', () => {
    const {windows} = normalizeOpenRouter({budgets: [{scope: 'api_key', limit_usd: 1, spend_usd: 1,
        remaining_usd: 0, reset_interval: null, resets_at: null}]});
    assert.equal(windows[0].apiLevel, 'crit');
    assert.equal(windows[0].resetsAt, null);
    assert.equal(windows[0].label, 'Key budget');
});

test('nextUtcReset: day, Monday-based week, month', () => {
    const now = Date.parse('2026-10-11T15:00:00Z'); // a Sunday
    assert.equal(nextUtcReset('daily', now), '2026-10-12T00:00:00.000Z');
    assert.equal(nextUtcReset('weekly', now), '2026-10-12T00:00:00.000Z');
    assert.equal(nextUtcReset('monthly', now), '2026-11-01T00:00:00.000Z');
    const monday = Date.parse('2026-10-12T01:00:00Z');
    assert.equal(nextUtcReset('weekly', monday), '2026-10-19T00:00:00.000Z');
    assert.equal(nextUtcReset(null, now), null);
});

test('intervalSeconds: monthly measured back from its reset', () => {
    assert.equal(intervalSeconds('monthly', '2026-03-01T00:00:00Z'), 28 * 86400);
    assert.equal(intervalSeconds('weekly', null), 7 * 86400);
    assert.equal(intervalSeconds(null, null), null);
});

test('money formats dollars and rejects junk', () => {
    assert.equal(money(3), '$3.00');
    assert.equal(money('0.125'), '$0.13');
    assert.equal(money(undefined), null);
});

console.log(`\n${passed} tests passed`);
