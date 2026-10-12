// The Claude source: one Claude Code profile (a config directory), read through
// UsageClient and shaped by usageModel.js into the provider snapshot the view
// renders. No shell imports.
import {UsageClient, UsageError} from '../usageClient.js';
import {normalizeWindows, normalizeSpend, selectPanelWindows} from '../usageModel.js';

// Plan label: the API's raw token (`subscriptionType` from disk or
// `organization_type` from the profile), prefix-stripped and cased — nothing
// mapped by name, so new plans show through ("max" → "Max"). "Claude" only if
// the API said nothing. A multiplier in the rate-limit tier ("…_20x") is
// appended.
function tierLabel(plan, rateLimitTier) {
    const base = String(plan ?? '')
        .replace(/^claude[_-]/i, '')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/\b\w/g, c => c.toUpperCase()) || 'Claude';
    const m = /(\d+)x/.exec(rateLimitTier ?? '');
    return m ? `${base} ${m[1]}x` : base;
}

// {label, panelLabel}: the popup shows the whole label ("Max 20x"), the top
// bar only its first word.
function tier(plan, rateLimitTier) {
    const label = tierLabel(plan, rateLimitTier);
    return {label, panelLabel: label.split(' ')[0]};
}

export class ClaudeProvider {
    constructor(source, settings) {
        this.source = source;
        this.kind = 'claude';
        this.icon = 'claude-symbolic.svg';
        this.usageUrl = 'https://claude.ai/settings/usage';
        this._client = new UsageClient({configDir: source.configDir, settings, profileId: source.id});
    }

    // The tier from disk, with no network round-trip, or null.
    async quickTier() {
        const {subscriptionType, rateLimitTier} = await this._client.tierFromDisk();
        // No credentials on disk: leave the tier blank rather than flash a
        // generic "Claude"; the refresh fills in the real state shortly.
        if (!subscriptionType && !rateLimitTier)
            return null;
        return tier(subscriptionType, rateLimitTier);
    }

    // Usage + profile for this account. Rejects when usage fails; a failed
    // profile fetch only costs the subtitle and tier.
    async fetch(cancellable) {
        const [usageRes, profileRes] = await Promise.allSettled([
            this._client.fetchUsage(cancellable),
            this._client.fetchProfile(cancellable),
        ]);
        if (usageRes.status === 'rejected')
            throw usageRes.reason;
        if (profileRes.status === 'rejected')
            logError(profileRes.reason, `Quota: profile fetch failed for "${this.source.label}" (non-fatal)`);
        const usage = usageRes.value;
        const profile = profileRes.status === 'fulfilled' ? profileRes.value : null;

        const snap = {subtitle: null, tier: null, windows: normalizeWindows(usage), lines: []};
        if (profile?.account) {
            snap.subtitle = profile.account.display_name || profile.account.full_name
                || profile.account.email_address || null;
            // Org plan is authoritative and always present; the has_claude_*
            // booleans are only a fallback (both false for team/enterprise seats).
            const plan = profile.organization?.organization_type
                ?? (profile.account.has_claude_max ? 'max'
                    : profile.account.has_claude_pro ? 'pro' : null);
            snap.tier = tier(plan, profile.organization?.rate_limit_tier);
        }

        const spend = normalizeSpend(usage);
        if (spend) {
            const parts = [spend.used, spend.limit].filter(Boolean);
            let text = `Extra usage: ${parts.join(' of ')}`;
            if (spend.percent !== null)
                text += ` (${spend.percent}%)`;
            snap.lines.push({text, level: spend.level});
        }
        return snap;
    }

    panelWindows(windows, selectors, worstScore) {
        return selectPanelWindows(windows, selectors, worstScore);
    }

    describeError(e) {
        if (e instanceof UsageError && e.status === 401)
            return 'Session expired. Sign in again with Claude Code, or in Settings.';
        // The API refuses to serve usage for this account: typically no
        // active subscription. Prefer the API's own wording.
        if (e instanceof UsageError && e.status === 403)
            return e.apiMessage() || 'No active Claude subscription for this account.';
        if (e instanceof UsageError && e.status === 429)
            return 'Claude is rate limiting requests. Trying again shortly.';
        return e.message || 'Could not reach Claude';
    }

    destroy() {
        this._client = null;
    }
}
