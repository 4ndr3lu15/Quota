// Pure data-shaping for Google Antigravity (agy) and Google AI subscriptions:
// turns RetrieveUserQuotaSummaryResponse / LoadCodeAssistResponse (or the JSON
// from `agy -p /usage --output-format json` and `agy -p /credits --output-format json`)
// into the same normalised windows and info lines the popup and app render.
// No GI or shell imports, so it runs under plain `node` (tools/test-agyModel.mjs).

const HOUR = 3600;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const UNIT_SECONDS = {
    w: WEEK,
    d: DAY,
    h: HOUR,
    m: 60,
    s: 1,
};

const KNOWN_TIERS = {
    'g1-pro-tier': 'Google AI Pro',
    'g1-ultra-tier': 'Google AI Ultra',
    'free-tier': 'Free',
    'standard-tier': 'Standard',
};

// Parses a window duration string such as "5h", "24h", "1d", "7d", "1w",
// "1h30m", or "3600s" into seconds, or null when missing/unrecognised.
export function parseWindowSeconds(windowStr) {
    if (typeof windowStr !== 'string' || !windowStr.trim())
        return null;
    const str = windowStr.trim().toLowerCase();
    const re = /(\d+(?:\.\d+)?)\s*([wdhms])/g;
    let total = 0;
    let matched = false;
    let m;
    while ((m = re.exec(str)) !== null) {
        matched = true;
        total += Number(m[1]) * UNIT_SECONDS[m[2]];
    }
    return matched && total > 0 ? Math.round(total) : null;
}

// Human-friendly subscription plan label for a tier ID or display name.
export function tierLabel(raw) {
    if (!raw || typeof raw !== 'string')
        return null;
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    const lower = trimmed.toLowerCase();
    if (KNOWN_TIERS[lower])
        return KNOWN_TIERS[lower];
    if (/^g1-([a-z0-9]+)-tier$/.test(lower)) {
        const part = /^g1-([a-z0-9]+)-tier$/.exec(lower)[1];
        return `Google AI ${part.charAt(0).toUpperCase() + part.slice(1)}`;
    }
    if (trimmed !== lower)
        return trimmed;
    return trimmed
        .replace(/[_-]+tier$/i, '')
        .split(/[_-\s]+/)
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ') || null;
}

function decodeBase64Url(segment) {
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    if (typeof globalThis.atob === 'function') {
        const bin = globalThis.atob(b64 + pad);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++)
            bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }
    if (typeof globalThis.Buffer !== 'undefined')
        return globalThis.Buffer.from(b64 + pad, 'base64').toString('utf8');
    return null;
}

// Extracts {name, email} from an OIDC JWT id_token without GI dependencies.
export function decodeJwtClaims(idToken) {
    if (typeof idToken !== 'string')
        return null;
    const parts = idToken.split('.');
    if (parts.length < 2)
        return null;
    try {
        const json = decodeBase64Url(parts[1]);
        if (!json)
            return null;
        const payload = JSON.parse(json);
        if (!payload || typeof payload !== 'object')
            return null;
        return {
            name: typeof payload.name === 'string' && payload.name ? payload.name : null,
            email: typeof payload.email === 'string' && payload.email ? payload.email : null,
        };
    } catch {
        return null;
    }
}

function unwrapCommandData(payload, expectedName) {
    if (!payload || typeof payload !== 'object')
        return {};
    if (payload.command && typeof payload.command === 'object') {
        if (!expectedName || payload.command.name === expectedName)
            return payload.command.data ?? {};
    }
    return payload;
}

function cleanBucketName(rawName, groupName) {
    let name = String(rawName ?? '').trim();
    if (groupName && name.toLowerCase().startsWith(groupName.toLowerCase() + ' '))
        name = name.slice(groupName.length).trim();
    name = name.replace(/\s+remaining$/i, '').trim();
    if (/^five\s+hour\s+limit$/i.test(name))
        return '5-hour limit';
    if (/^weekly\s+limit$/i.test(name))
        return 'Weekly limit';
    return name || String(rawName ?? 'Quota');
}

function bucketRole(id, cleanName, groupName, totalSeconds) {
    const bid = String(id ?? '').toLowerCase();
    if (bid === 'gemini-5h')
        return 'session';
    if (bid === 'gemini-weekly')
        return 'weekly';
    const lower = String(cleanName ?? '').toLowerCase();
    const isPrimaryGroup = !groupName || /^gemini(\s+models)?$/i.test(groupName);
    if (isPrimaryGroup && (lower === '5-hour session' || lower === '5-hour limit' || lower === 'session') && totalSeconds === 5 * HOUR)
        return 'session';
    if (isPrimaryGroup && (lower === 'weekly' || lower === 'weekly limit') && totalSeconds === WEEK)
        return 'weekly';
    return 'quota';
}

function normalizeBucket(b, groupName, multiGroup, index) {
    if (!b || typeof b !== 'object')
        return null;
    const remFrac = b.remainingFraction ?? b.remaining_fraction;
    const disabled = Boolean(b.disabled);
    let utilization = null;
    if (remFrac !== undefined && remFrac !== null && Number.isFinite(Number(remFrac)))
        utilization = Math.max(0, Math.min(100, (1 - Number(remFrac)) * 100));
    else if (disabled)
        utilization = 100;
    if (utilization === null)
        return null;

    const rawName = b.displayName ?? b.name ?? groupName ?? 'Quota';
    const cleanName = cleanBucketName(rawName, groupName);
    const label = multiGroup && groupName && groupName.toLowerCase() !== cleanName.toLowerCase()
        ? `${groupName} · ${cleanName}`
        : String(cleanName);
    const id = b.bucketId ?? b.id ?? rawName ?? String(index);
    const key = groupName ? `agy:${groupName}:${id}` : `agy:${id}`;
    const totalSeconds = parseWindowSeconds(b.window);
    const resetsAt = b.resetTime ?? b.reset_time ?? null;
    const remAmt = b.remainingAmount ?? b.remaining_amount;
    const detail = remAmt !== undefined && remAmt !== null && Number.isFinite(Number(remAmt))
        ? `${Number(remAmt)} left`
        : null;
    const role = bucketRole(id, cleanName, groupName, totalSeconds);

    return {
        key,
        label,
        role,
        utilization,
        resetsAt,
        totalSeconds,
        apiLevel: disabled || utilization >= 100 ? 'crit' : 'ok',
        isActive: !disabled,
        order: index,
        ...(detail ? {detail} : {}),
    };
}

function extractCredits(assist, token) {
    const data = unwrapCommandData(assist, 'credits');
    const direct = data.remaining_credits ?? data.remainingCredits;
    if (direct !== undefined && direct !== null && Number.isFinite(Number(direct)))
        return Number(direct);

    const creditsList = data.paidTier?.availableCredits ?? data.currentTier?.availableCredits;
    if (Array.isArray(creditsList) && creditsList.length) {
        let sum = 0;
        let found = false;
        for (const c of creditsList) {
            const amt = Number(c?.creditAmount ?? c?.credit_amount);
            if (Number.isFinite(amt)) {
                sum += amt;
                found = true;
            }
        }
        if (found)
            return sum;
    }
    return null;
}

function extractTierLabel(assist, token) {
    const data = unwrapCommandData(assist, 'credits');
    const candidates = [
        data.paidTier?.name,
        data.currentTier?.name,
        data.plan_name,
        data.planName,
        token?.tier_display_name,
        data.paidTier?.id,
        data.currentTier?.id,
        data.g1Tier,
        token?.user_tier,
    ];
    for (const c of candidates) {
        const label = tierLabel(c);
        if (label)
            return label;
    }
    return null;
}

// Normalises one Antigravity / Google AI account snapshot:
//   {windows, tier: {label} | null, lines: [string], credits, subtitle}
export function normalizeAgy(quotaPayload, assistOrCreditsPayload = null, storedToken = null) {
    const quota = unwrapCommandData(quotaPayload, 'usage');
    const windows = [];
    const groups = Array.isArray(quota?.groups) ? quota.groups : [];
    const multiGroup = groups.length > 1;
    let idx = 0;

    for (const g of groups) {
        const groupName = g?.displayName ?? g?.name ?? null;
        const buckets = Array.isArray(g?.buckets) ? g.buckets : [];
        for (const b of buckets) {
            const w = normalizeBucket(b, groupName, multiGroup, idx++);
            if (w)
                windows.push(w);
        }
    }

    if (!windows.length && Array.isArray(quota?.buckets)) {
        for (const b of quota.buckets) {
            const w = normalizeBucket(b, null, false, idx++);
            if (w)
                windows.push(w);
        }
    }

    const plan = extractTierLabel(assistOrCreditsPayload, storedToken);
    const credits = extractCredits(assistOrCreditsPayload, storedToken);
    const lines = [];
    if (credits !== null)
        lines.push(`Google AI credits: ${credits} remaining`);

    const claims = decodeJwtClaims(storedToken?.id_token);
    const subtitle = claims?.name || claims?.email || null;

    return {
        windows,
        tier: plan ? {label: plan} : null,
        lines,
        credits,
        subtitle,
    };
}
