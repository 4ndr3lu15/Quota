#!/usr/bin/env node
// Unit tests for the pure Antigravity (agy) / Google AI usage model.
// Runs under plain node (no GI):
//   node tools/test-agyModel.mjs
import assert from 'node:assert/strict';
import {
    parseWindowSeconds, tierLabel, decodeJwtClaims, normalizeAgy,
} from '../src/lib/agyModel.js';

let passed = 0;
const test = (name, fn) => {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
};

test('parseWindowSeconds parses duration tokens', () => {
    assert.equal(parseWindowSeconds('5h'), 5 * 3600);
    assert.equal(parseWindowSeconds('24h'), 24 * 3600);
    assert.equal(parseWindowSeconds('1d'), 86400);
    assert.equal(parseWindowSeconds('7d'), 7 * 86400);
    assert.equal(parseWindowSeconds('1w'), 7 * 86400);
    assert.equal(parseWindowSeconds('1h30m'), 5400);
    assert.equal(parseWindowSeconds('3600s'), 3600);
    assert.equal(parseWindowSeconds(''), null);
    assert.equal(parseWindowSeconds(null), null);
});

test('tierLabel formats Google AI tier IDs and display names', () => {
    assert.equal(tierLabel('g1-pro-tier'), 'Google AI Pro');
    assert.equal(tierLabel('g1-ultra-tier'), 'Google AI Ultra');
    assert.equal(tierLabel('Google AI Pro'), 'Google AI Pro');
    assert.equal(tierLabel('free-tier'), 'Free');
    assert.equal(tierLabel('standard-tier'), 'Standard');
    assert.equal(tierLabel(''), null);
    assert.equal(tierLabel(null), null);
});

test('decodeJwtClaims extracts name and email from OIDC id_token', () => {
    const header = Buffer.from(JSON.stringify({alg: 'RS256'})).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        email: 'user@example.com',
        name: 'Andre Luis',
    })).toString('base64url');
    const token = `${header}.${payload}.sig`;
    assert.deepEqual(decodeJwtClaims(token), {
        name: 'Andre Luis',
        email: 'user@example.com',
    });
    assert.equal(decodeJwtClaims('not-a-jwt'), null);
});

test('normalizeAgy handles RetrieveUserQuotaSummaryResponse + LoadCodeAssistResponse', () => {
    const quota = {
        description: 'Google AI Pro quota',
        groups: [
            {
                displayName: 'Models',
                buckets: [
                    {
                        bucketId: 'gemini-pro',
                        displayName: 'Gemini 3.1 Pro',
                        window: '5h',
                        remainingFraction: 0.75,
                        remainingAmount: 150,
                        resetTime: '2026-10-21T23:00:00Z',
                        disabled: false,
                    },
                    {
                        bucketId: 'claude-sonnet',
                        displayName: 'Claude Sonnet 4.6',
                        window: '5h',
                        remainingFraction: 0,
                        resetTime: '2026-10-21T23:00:00Z',
                        disabled: true,
                    },
                ],
            },
        ],
    };
    const assist = {
        paidTier: {
            id: 'g1-pro-tier',
            name: 'Google AI Pro',
            availableCredits: [{creditType: 'GOOGLE_ONE_AI', creditAmount: 500}],
        },
    };
    const header = Buffer.from('{}').toString('base64url');
    const claims = Buffer.from(JSON.stringify({email: 'andre@example.com'})).toString('base64url');
    const snap = normalizeAgy(quota, assist, {id_token: `${header}.${claims}.s`});

    assert.equal(snap.tier?.label, 'Google AI Pro');
    assert.equal(snap.subtitle, 'andre@example.com');
    assert.equal(snap.credits, 500);
    assert.deepEqual(snap.lines, ['Google AI credits: 500 remaining']);
    assert.equal(snap.windows.length, 2);
    assert.equal(snap.windows[0].label, 'Gemini 3.1 Pro');
    assert.equal(snap.windows[0].utilization, 25);
    assert.equal(snap.windows[0].detail, '150 left');
    assert.equal(snap.windows[0].totalSeconds, 5 * 3600);
    assert.equal(snap.windows[0].apiLevel, 'ok');
    assert.equal(snap.windows[1].label, 'Claude Sonnet 4.6');
    assert.equal(snap.windows[1].utilization, 100);
    assert.equal(snap.windows[1].apiLevel, 'crit');
});

test('normalizeAgy handles CLI /usage and /credits JSON output', () => {
    const usageJson = {
        command: {
            name: 'usage',
            data: {
                groups: [
                    {
                        name: 'Standard',
                        buckets: [
                            {
                                id: 'b1',
                                name: 'Gemini 3 Flash',
                                window: '24h',
                                remaining_fraction: 0.4,
                                reset_time: '2026-10-22T00:00:00Z',
                            },
                        ],
                    },
                ],
            },
        },
    };
    const creditsJson = {
        command: {
            name: 'credits',
            data: {
                remaining_credits: 1200,
                plan_name: 'Google AI Ultra',
            },
        },
    };
    const snap = normalizeAgy(usageJson, creditsJson);
    assert.equal(snap.tier?.label, 'Google AI Ultra');
    assert.equal(snap.credits, 1200);
    assert.deepEqual(snap.lines, ['Google AI credits: 1200 remaining']);
    assert.equal(snap.windows.length, 1);
    assert.equal(Math.round(snap.windows[0].utilization), 60);
    assert.equal(snap.windows[0].totalSeconds, 24 * 3600);
});

console.log(`\n${passed} tests passed`);
