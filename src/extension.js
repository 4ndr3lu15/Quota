import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {UsageError, SignedOutError} from './lib/usageClient.js';
import {ensureProfiles} from './lib/profiles.js';
import {groupPanelWindows, windowTag} from './lib/usageModel.js';
import {loadSources, activeSource} from './lib/sources.js';
import {ClaudeProvider} from './lib/providers/claude.js';
import {OpenRouterProvider} from './lib/providers/openrouter.js';

// Severity levels, least to most severe.
const LEVEL_RANK = {ok: 0, warn: 1, crit: 2};

// Collapse refreshes that land closer together than this. Opening the menu
// triggers a refresh, and so does the poll timer; without a floor the two can
// fire back-to-back and the second request is rate-limited (429) by the API.
const MIN_REFRESH_MS = 60 * 1000;

// A refresh still running after this long is given up on (see _refresh).
const STALLED_FETCH_MS = 2 * 60 * 1000;

// Secondary text (account line, captions, "Updated …") is the menu's own text
// color at reduced opacity, so it reads right in both the light and the dark
// shell style without a color of its own.
const DIM_OPACITY = 170;

// Severity from a raw utilization %: how full the bucket is right now.
function utilLevel(util) {
    if (util >= 90)
        return 'crit';
    if (util >= 75)
        return 'warn';
    return 'ok';
}

// The more severe of two levels.
function maxLevel(a, b) {
    return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

// Style class for a level that needs one: only warnings and critical levels
// are colored; a calm level keeps the theme's own color.
function levelClass(level) {
    return level === 'warn' || level === 'crit' ? `quota-${level}` : null;
}

function classes(...names) {
    return names.filter(Boolean).join(' ');
}

// Projected end-of-window utilization at the current consumption rate. Returns
// the larger of actual and projected, falling back to actual when the window
// has barely started (too little signal) or reports no reset time.
function projectedUtil(util, resetsAtIso, totalSeconds) {
    const target = Date.parse(resetsAtIso ?? '');
    if (Number.isNaN(target) || !totalSeconds)
        return util;
    const remaining = (target - Date.now()) / 1000;
    if (remaining <= 0)
        return util;
    const elapsed = totalSeconds - remaining;
    if (elapsed <= 0 || elapsed / totalSeconds < 0.05)
        return util;
    return Math.max(util, (util * totalSeconds) / elapsed);
}

// Seconds from now until utilization would hit 100% at the average rate so far
// this window, but only when that exhaustion lands before the window resets
// (i.e. the current pace really does overrun the limit). Returns null
// otherwise, using the same early-window guard as projectedUtil so we don't
// extrapolate from noise.
function exhaustSeconds(util, resetsAtIso, totalSeconds) {
    const target = Date.parse(resetsAtIso ?? '');
    if (Number.isNaN(target) || !totalSeconds || util <= 0)
        return null;
    const remaining = (target - Date.now()) / 1000;
    if (remaining <= 0)
        return null;
    const elapsed = totalSeconds - remaining;
    if (elapsed <= 0 || elapsed / totalSeconds < 0.05)
        return null;
    const toExhaust = (elapsed * (100 - util)) / util;
    return toExhaust > 0 && toExhaust < remaining ? toExhaust : null;
}

// Human-friendly duration trimmed to the two largest units: "30s", "45m",
// "4h 21m", "2d 5h". sep sets what goes between the two units, e.g. '' for the
// compact top bar form ("4h21m").
function humanDuration(seconds, sep = ' ') {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60)
        return `${s}s`;
    const mins = Math.round(s / 60);
    if (mins < 60)
        return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h${sep}${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d${sep}${hrs % 24}h`;
}

// Being locked out for at least this fraction of the window makes a fast burn
// critical. A shorter lockout (running out just before the reset) only
// warrants a warning.
const LOCKOUT_CRIT_FRAC = 0.10;

// How long you'd be stuck at the limit before the window resets, in seconds, at
// the current burn rate, or null when the pace doesn't run out before reset.
function lockoutSeconds(util, resetsAtIso, totalSeconds) {
    const exhaust = exhaustSeconds(util, resetsAtIso, totalSeconds);
    if (exhaust === null)
        return null;
    const remaining = (Date.parse(resetsAtIso) - Date.now()) / 1000;
    return Math.max(0, remaining - exhaust);
}

// Severity for a usage window, based on the *consequence* of the current burn
// rather than the raw projected percentage. Critical is reserved for "out of
// headroom now, or locked out for a meaningful stretch"; a burn that only just
// overruns right before the reset stays a warning.
function windowLevel(util, resetsAtIso, totalSeconds) {
    // Floor: how full the bucket is right now, independent of timing.
    let level = utilLevel(util);

    const lockout = lockoutSeconds(util, resetsAtIso, totalSeconds);
    if (lockout !== null) {
        // Projected to run out before the reset: escalate by how long you'd be
        // locked out, as a fraction of the whole window.
        const projLevel = lockout >= totalSeconds * LOCKOUT_CRIT_FRAC ? 'crit' : 'warn';
        level = maxLevel(level, projLevel);
    } else if (projectedUtil(util, resetsAtIso, totalSeconds) >= 75) {
        // Won't run out before the reset: a rising window can warn, but never
        // go critical from projection alone.
        level = maxLevel(level, 'warn');
    }
    return level;
}

// Caption note explaining the projection, tied to the same lockout threshold as
// windowLevel so a warning never reads "running out fast".
function projectionNote(util, resetsAtIso, totalSeconds) {
    const lockout = lockoutSeconds(util, resetsAtIso, totalSeconds);
    if (lockout !== null) {
        if (lockout >= totalSeconds * LOCKOUT_CRIT_FRAC) {
            const exhaust = exhaustSeconds(util, resetsAtIso, totalSeconds);
            return `runs out in ~${humanDuration(exhaust)} at this pace`;
        }
        return 'may run out just before the reset';
    }
    const proj = projectedUtil(util, resetsAtIso, totalSeconds);
    if (proj >= 75 && Math.round(proj) > Math.round(util))
        return `on track for ~${Math.round(proj)}% by the reset`;
    return '';
}

function relativeReset(iso) {
    const target = Date.parse(iso);
    if (Number.isNaN(target))
        return '';
    const diff = target - Date.now();
    if (diff <= 0)
        return 'Resetting…';
    return `Resets in ${humanDuration(diff / 1000)}`;
}

// Compact "time until reset" for the top bar: magnitude only, no separator
// between units ("4h21m"). Empty when the timestamp is missing or unparseable
// so the label collapses instead of showing junk.
function compactReset(iso) {
    const target = Date.parse(iso);
    if (Number.isNaN(target))
        return '';
    const diff = target - Date.now();
    if (diff <= 0)
        return 'now';
    return humanDuration(diff / 1000, '');
}

// Lets a menu label wrap onto extra lines (up to its stylesheet max-width)
// instead of stretching the menu. Returns the label for chaining.
function wrapLabel(label) {
    label.x_expand = true;
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function dimLabel(params) {
    const label = new St.Label(params);
    label.opacity = DIM_OPACITY;
    return label;
}

// A vertical St.BoxLayout. GNOME 48 replaced the box's `vertical` property
// with `orientation`, and GNOME 51 removed `vertical` altogether ("No property
// vertical on StBoxLayout"), so set whichever this shell has.
function vbox(params = {}) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

// Assigns an actor property only when it changes. The top bar's values are
// re-applied on every countdown tick and rarely differ, so this keeps an idle
// tick from touching the actors at all.
function setIfChanged(actor, prop, value) {
    if (actor[prop] !== value)
        actor[prop] = value;
}

function sourceIcon(path, file) {
    return Gio.icon_new_for_string(`${path}/icons/${file}`);
}

// The top bar's gauge: a ring or a short bar, drawn in the widget's own
// foreground color, the way the shell's symbolic icons are. That color is the
// panel's text color until the window gets warm or critical, when the level
// class (stylesheet.css) changes it. The size and line width come from the
// stylesheet too (`-quota-line-width`).
const Gauge = GObject.registerClass(
class QuotaGauge extends St.DrawingArea {
    _init() {
        super._init({y_align: Clutter.ActorAlign.CENTER});
        this._shape = 'ring';
        this._util = null;
        this._level = null;
        this._syncClass();
    }

    setShape(shape) {
        if (shape === this._shape)
            return;
        this._shape = shape;
        this._syncClass();
    }

    // Both setters run on every countdown tick with values that rarely
    // change, so an unchanged value queues no repaint.
    setValue(util, level) {
        const clamped = Math.max(0, Math.min(100, util));
        if (clamped === this._util && level === this._level)
            return;
        this._util = clamped;
        this._level = level;
        this._syncClass();
        this.queue_repaint();
    }

    setUnknown() {
        if (this._util === null && this._level === null)
            return;
        this._util = null;
        this._level = null;
        this._syncClass();
        this.queue_repaint();
    }

    _syncClass() {
        setIfChanged(this, 'style_class',
            classes('quota-gauge', `quota-gauge-${this._shape}`, levelClass(this._level)));
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const node = this.get_theme_node();
        const fg = node.get_foreground_color();
        const rgb = [fg.red / 255, fg.green / 255, fg.blue / 255];
        const alpha = fg.alpha / 255;
        const line = node.get_length('-quota-line-width') || 2;
        const frac = (this._util ?? 0) / 100;

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(line);

        if (this._shape === 'bar') {
            const y = h / 2;
            const x0 = line / 2;
            const x1 = Math.max(x0, w - line / 2);
            cr.setSourceRGBA(...rgb, alpha * 0.3);
            cr.moveTo(x0, y);
            cr.lineTo(x1, y);
            cr.stroke();
            if (frac > 0) {
                cr.setSourceRGBA(...rgb, alpha);
                cr.moveTo(x0, y);
                cr.lineTo(x0 + frac * (x1 - x0), y);
                cr.stroke();
            }
        } else {
            const radius = Math.max(0, Math.min(w, h) / 2 - line / 2);
            const start = -Math.PI / 2;
            cr.setSourceRGBA(...rgb, alpha * 0.3);
            cr.arc(w / 2, h / 2, radius, 0, 2 * Math.PI);
            cr.stroke();
            if (frac > 0) {
                cr.setSourceRGBA(...rgb, alpha);
                cr.arc(w / 2, h / 2, radius, start, start + frac * 2 * Math.PI);
                cr.stroke();
            }
        }
        cr.$dispose();
    }
});

// One usage window in the top bar: an optional short tag ("5h", "7d",
// "Fable"), shown when several windows share the bar, then the gauge and the
// percentage.
class PanelGauge {
    constructor() {
        this.root = new St.BoxLayout({style_class: 'quota-panel-gauge'});
        this._tag = dimLabel({text: '', style_class: 'quota-panel-tag', y_align: Clutter.ActorAlign.CENTER});
        this._tag.visible = false;
        this._gauge = new Gauge();
        this._pct = new St.Label({text: '…', style_class: 'quota-panel-pct', y_align: Clutter.ActorAlign.CENTER});
        this.root.add_child(this._tag);
        this.root.add_child(this._gauge);
        this.root.add_child(this._pct);
    }

    setTag(text, visible) {
        this._tag.text = text ?? '';
        this._tag.visible = !!visible && this._tag.text !== '';
    }

    applySettings(settings) {
        const shape = settings.get_string('panel-gauge');
        this._gauge.visible = shape !== 'none';
        if (shape !== 'none')
            this._gauge.setShape(shape);
        this._pct.visible = settings.get_boolean('show-percentage');
    }

    setValue(util, level) {
        setIfChanged(this._pct, 'text', `${Math.round(util)}%`);
        this._setPctLevel(level);
        this._gauge.setValue(util, level);
    }

    setUnknown() {
        setIfChanged(this._pct, 'text', '—');
        this._setPctLevel(null);
        this._gauge.setUnknown();
    }

    // A failed refresh: '!' in the warning color, until the next good fetch.
    setError() {
        setIfChanged(this._pct, 'text', '!');
        this._setPctLevel('warn');
        this._gauge.setUnknown();
    }

    _setPctLevel(level) {
        setIfChanged(this._pct, 'style_class', classes('quota-panel-pct', levelClass(level)));
    }

    destroy() {
        this._tag?.destroy();
        this._gauge?.destroy();
        this._pct?.destroy();
        this.root?.destroy();
        this._tag = null;
        this._gauge = null;
        this._pct = null;
        this.root = null;
    }
}

// A run of top bar gauges that reset together (see groupPanelWindows), then
// one countdown for all of them. Most groups hold a single gauge; the 7-day
// window and the per-model 7-day windows share one.
class PanelGroup {
    constructor(keys) {
        this.root = new St.BoxLayout({style_class: 'quota-panel-group'});
        this.gauges = new Map();
        for (const key of keys) {
            const gauge = new PanelGauge();
            this.gauges.set(key, gauge);
            this.root.add_child(gauge.root);
        }
        this._reset = dimLabel({text: '', style_class: 'quota-panel-reset', y_align: Clutter.ActorAlign.CENTER});
        this._reset.visible = false;
        this.root.add_child(this._reset);
        this._showReset = false;
    }

    applySettings(settings) {
        for (const gauge of this.gauges.values())
            gauge.applySettings(settings);
        this._showReset = settings.get_boolean('show-reset');
        this._syncReset();
    }

    // The group's reset time (null: no countdown). Recomputed on every call,
    // which is how the countdown ticks between polls.
    setReset(iso) {
        setIfChanged(this._reset, 'text', iso ? compactReset(iso) : '');
        this._syncReset();
    }

    _syncReset() {
        setIfChanged(this._reset, 'visible', this._showReset && this._reset.text !== '');
    }

    destroy() {
        for (const gauge of this.gauges.values())
            gauge.destroy();
        this.gauges.clear();
        this._reset?.destroy();
        this.root?.destroy();
        this._reset = null;
        this.root = null;
    }
}

// One usage window in the menu: a non-interactive row with the window's name
// and percentage, a bar in the accent color (warning colors when it gets
// close), and a caption with the reset time and what the pace means.
class Meter {
    constructor(name) {
        this.item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'quota-item'});
        this._box = vbox({style_class: 'quota-meter', x_expand: true});

        this._row = new St.BoxLayout({style_class: 'quota-meter-row'});
        this._name = new St.Label({text: name, style_class: 'quota-meter-name', x_expand: true});
        this._pct = new St.Label({text: '—', style_class: 'quota-meter-pct'});
        this._row.add_child(this._name);
        this._row.add_child(this._pct);

        this._track = new St.Widget({style_class: 'quota-meter-track', x_expand: true});
        this._fill = new St.Widget({style_class: 'quota-meter-fill'});
        this._track.add_child(this._fill);
        // The fill is a fraction of the track's allocated width, recomputed
        // whenever the track is laid out again.
        this._fraction = 0;
        this._track.connectObject('notify::width', () => this._resizeFill(), this);

        this._caption = wrapLabel(dimLabel({text: '', style_class: 'quota-meter-caption'}));

        this._box.add_child(this._row);
        this._box.add_child(this._track);
        this._box.add_child(this._caption);
        this.item.add_child(this._box);
    }

    // The bar tracks actual utilization; the level (projection included)
    // only changes its color.
    setValue(util, caption, level) {
        this._pct.text = `${Math.round(util)}%`;
        this._pct.style_class = classes('quota-meter-pct', levelClass(level));
        this._fraction = Math.max(0, Math.min(100, util)) / 100;
        this._fill.style_class = classes('quota-meter-fill', levelClass(level));
        this._resizeFill();
        this._caption.text = caption ?? '';
        this._caption.visible = !!caption;
    }

    setMuted() {
        this._pct.text = '—';
        this._pct.style_class = 'quota-meter-pct';
        this._fraction = 0;
        this._resizeFill();
        this._caption.visible = false;
    }

    setName(name) {
        this._name.text = name;
    }

    _resizeFill() {
        const w = this._track?.get_width() ?? 0;
        this._fill.set_width(Math.round(this._fraction * w));
    }

    destroy() {
        this._track?.disconnectObject(this);
        this._name?.destroy();
        this._pct?.destroy();
        this._row?.destroy();
        this._fill?.destroy();
        this._track?.destroy();
        this._caption?.destroy();
        this._box?.destroy();
        this.item?.destroy();
        this._name = null;
        this._pct = null;
        this._row = null;
        this._fill = null;
        this._track = null;
        this._caption = null;
        this._box = null;
        this.item = null;
    }
}

// A non-interactive menu row holding one wrapping label.
function textItem(styleClass, dim = false) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'quota-item'});
    const label = wrapLabel(dim ? dimLabel({style_class: styleClass}) : new St.Label({style_class: styleClass}));
    item.add_child(label);
    item.visible = false;
    return [item, label];
}

// Everything shown for the source picked in the menu (a Claude profile or an
// OpenRouter account): its provider, its block in the top bar, and its part of
// the menu. The provider (lib/providers/) fetches a snapshot,
// {subtitle, tier, windows, lines}, and this view renders it, whatever the
// platform.
class SourceView {
    constructor(source, provider, settings, panelBox, menuSection) {
        this.source = source;
        this._provider = provider;
        this._settings = settings;
        // Outcome of the last refresh ('ok' | 'error' | 'signed-out'), read by
        // the indicator for the "Updated …" line.
        this.lastResult = null;
        this._snap = null;
        this._subtitle = null;
        this._tier = null;
        this._windows = [];
        // key -> {meter, w}, so meters are reused across polls and torn down
        // only when the API stops reporting that window.
        this._meters = new Map();

        // ---- top bar: [groups of gauges] [plan or balance] ----
        this._panelBlock = new St.BoxLayout({style_class: 'quota-panel-block'});
        this._groupsBox = new St.BoxLayout({style_class: 'quota-panel-groups'});
        this._plan = dimLabel({text: '', style_class: 'quota-panel-plan', y_align: Clutter.ActorAlign.CENTER});
        this._plan.visible = false;
        this._panelBlock.add_child(this._groupsBox);
        this._panelBlock.add_child(this._plan);
        panelBox.add_child(this._panelBlock);
        this._groups = [];
        // Signature of what the current layout was built from, so an
        // unchanged top bar is not laid out again (see renderPanel).
        this._layoutSig = null;

        // ---- menu: account line, meters, info lines, error ----
        [this._infoItem, this._info] = textItem('quota-info', true);
        menuSection.addMenuItem(this._infoItem);
        this._metersSection = new PopupMenu.PopupMenuSection();
        menuSection.addMenuItem(this._metersSection);
        [this._linesItem, this._lines] = textItem('quota-lines', true);
        menuSection.addMenuItem(this._linesItem);
        [this._errorItem, this._error] = textItem('quota-error');
        menuSection.addMenuItem(this._errorItem);

        this.renderPanel();
    }

    get icon() {
        return this._provider.icon;
    }

    get usageUrl() {
        return this._provider.usageUrl;
    }

    applySettings() {
        for (const group of this._groups)
            group.applySettings(this._settings);
        this._plan.visible = this._settings.get_boolean('show-plan') && this._plan.text !== '';
    }

    // "Account · Plan" under the source's name in the menu, and the plan (or
    // balance) in the top bar. Called on every poll, so it only acts on a
    // change.
    _setIdentity(subtitle, tier) {
        this._subtitle = subtitle ?? this._subtitle;
        this._tier = tier ?? this._tier;
        const info = [this._subtitle, this._tier?.label].filter(Boolean).join(' · ');
        setIfChanged(this._info, 'text', info);
        this._infoItem.visible = info !== '';
        setIfChanged(this._plan, 'text', this._tier?.panelLabel ?? '');
        this.applySettings();
    }

    _clearIdentity(subtitle) {
        this._subtitle = subtitle;
        this._tier = null;
        this._setIdentity(subtitle, null);
    }

    // The tier the provider knows without the network (Claude reads it from
    // disk), so the top bar is not blank until the first fetch.
    async applyQuickTier(cancellable) {
        try {
            const tier = await this._provider.quickTier();
            if (cancellable.is_cancelled() || !tier)
                return;
            this._setIdentity(null, tier);
        } catch {
            // Not signed in yet; the refresh will surface a clearer message.
        }
    }

    // Fetches this source's snapshot; never rejects (errors are reported
    // through _renderError).
    async refresh(cancellable) {
        let snap;
        try {
            snap = await this._provider.fetch(cancellable);
        } catch (e) {
            if (!cancellable.is_cancelled())
                this._renderError(e);
            return;
        }
        if (cancellable.is_cancelled())
            return;
        this._render(snap);
    }

    _render(snap) {
        this._errorItem.visible = false;
        this._snap = snap;
        this._setIdentity(snap.subtitle, snap.tier);

        // One meter per window, reused across polls by key.
        this._windows = snap.windows;
        const seen = new Set();
        for (const w of this._windows) {
            seen.add(w.key);
            let entry = this._meters.get(w.key);
            if (!entry) {
                entry = {meter: new Meter(w.label), w};
                this._metersSection.addMenuItem(entry.meter.item);
                this._meters.set(w.key, entry);
            } else {
                entry.meter.setName(w.label);
                entry.w = w;
            }
            this._applyWindow(entry.meter, w);
        }
        // Keep the on-screen order matching the window order.
        this._windows.forEach((w, i) => {
            this._metersSection.moveMenuItem(this._meters.get(w.key).meter.item, i);
        });
        // Drop meters for windows the API stopped reporting.
        for (const [key, entry] of this._meters) {
            if (!seen.has(key)) {
                entry.meter.destroy();
                this._meters.delete(key);
            }
        }

        this._renderLines(snap.lines);

        // Before renderPanel: it keeps the '!' for as long as this says 'error'.
        this.lastResult = 'ok';
        this.renderPanel();
    }

    // The provider's info lines (Claude's extra usage, OpenRouter's spend and
    // balance), colored by the most severe level among them.
    _renderLines(lines) {
        if (!lines?.length) {
            this._linesItem.visible = false;
            return;
        }
        this._lines.text = lines.map(l => l.text).join('\n');
        const level = lines.map(l => l.level).filter(Boolean)
            .reduce((a, b) => maxLevel(a, b), 'ok');
        this._lines.style_class = classes('quota-lines', levelClass(level));
        // A warning reads at full strength; plain info stays secondary.
        this._lines.opacity = levelClass(level) ? 255 : DIM_OPACITY;
        this._linesItem.visible = true;
    }

    // Soonest reset among this source's windows, in seconds, or null.
    soonestResetSeconds() {
        let soonest = null;
        for (const w of this._windows) {
            const t = Date.parse(w?.resetsAt ?? '');
            if (Number.isNaN(t))
                continue;
            const rem = (t - Date.now()) / 1000;
            if (rem > 0 && (soonest === null || rem < soonest))
                soonest = rem;
        }
        return soonest;
    }

    // Re-applies the last fetched usage so the time-derived parts move between
    // polls: the reset countdowns and the pace colors. Nothing is fetched. The
    // menu's meters only need it while the menu is open (the indicator also
    // calls this the moment it opens).
    refreshCountdowns(menuOpen) {
        if (!this._snap)
            return;
        if (menuOpen) {
            for (const {meter, w} of this._meters.values())
                this._applyWindow(meter, w);
        }
        this.renderPanel();
    }

    // The color reflects the consequence of the current pace (see
    // windowLevel), floored at the API's own severity, so a window the API
    // flags never reads calmer than the API says. The caption explains it.
    _applyWindow(meter, w) {
        if (!w || !Number.isFinite(w.utilization)) {
            meter.setMuted();
            return;
        }
        const util = w.utilization;
        let caption = w.resetsAt ? relativeReset(w.resetsAt)
            : (util > 0 || w.detail ? '' : 'Not used yet');
        // A money window says how much of what ("$1.20 of $5.00") first.
        if (w.detail)
            caption = caption ? `${w.detail} · ${caption}` : w.detail;
        const note = projectionNote(util, w.resetsAt, w.totalSeconds);
        if (note)
            caption = caption ? `${caption} · ${note}` : note;
        meter.setValue(util, caption, this._windowLevel(w));
    }

    _windowLevel(w) {
        return maxLevel(windowLevel(w.utilization, w.resetsAt, w.totalSeconds), w.apiLevel);
    }

    // Which windows the top bar shows. Claude follows the panel-windows
    // setting; other providers pick their own. 'worst' ranks by the computed
    // severity, then utilization.
    _panelWindows() {
        return this._provider.panelWindows(this._windows, this._settings.get_strv('panel-windows'),
            w => LEVEL_RANK[this._windowLevel(w)] * 1000 + (Number(w.utilization) || 0));
    }

    // Syncs the top bar with the selected windows. Runs after every poll, on
    // setting changes, and on the countdown tick. The layout (which gauges,
    // how they group, their tags) is only rebuilt when its signature changes;
    // the values are then re-applied, which is cheap.
    renderPanel() {
        const sel = this._panelWindows();
        // With nothing to show (no data yet, or signed out) one group holds a
        // single placeholder gauge, keyed ''.
        const groups = sel.length ? groupPanelWindows(sel) : [{windows: [], resetsAt: null}];
        const keys = groups.map(g => (g.windows.length ? g.windows.map(w => w.key) : ['']));
        const tagged = sel.length > 1;
        const sig = JSON.stringify([tagged, groups.map(g => g.windows.map(w => [w.key, windowTag(w)]))]);
        if (sig !== this._layoutSig) {
            for (const group of this._groups)
                group.destroy();
            this._groups = keys.map(k => new PanelGroup(k));
            this._groups.forEach((group, i) => {
                this._groupsBox.add_child(group.root);
                group.applySettings(this._settings);
                for (const w of groups[i].windows)
                    group.gauges.get(w.key).setTag(windowTag(w), tagged);
            });
            this._layoutSig = sig;
        }
        this._updatePanel(groups);
    }

    // Values, colors and countdowns. After a failed refresh every gauge reads
    // '!' until a fetch succeeds again.
    _updatePanel(groups) {
        const failed = this.lastResult === 'error';
        groups.forEach((g, i) => {
            const group = this._groups[i];
            group.setReset(failed ? null : g.resetsAt);
            if (!g.windows.length) {
                // The placeholder keeps its '…' until the first result is in.
                const gauge = group.gauges.get('');
                if (failed)
                    gauge.setError();
                else if (this.lastResult !== null)
                    gauge.setUnknown();
                return;
            }
            for (const w of g.windows) {
                const gauge = group.gauges.get(w.key);
                if (failed)
                    gauge.setError();
                else if (Number.isFinite(w.utilization))
                    gauge.setValue(w.utilization, this._windowLevel(w));
                else
                    gauge.setUnknown();
            }
        });
    }

    _renderError(e) {
        // A cancelled request means the view is being torn down; nothing to
        // show.
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        // No login for this source: a state, not a failure.
        if (e instanceof SignedOutError) {
            this._renderSignedOut(e);
            return;
        }
        // A 429 is transient (we polled a touch too soon). With usage already
        // on screen, keep showing it instead of flashing an error.
        if (e instanceof UsageError && e.status === 429 && this._snap) {
            logError(e, `Quota: rate limited for "${this.source.label}", keeping last data`);
            return;
        }
        this.lastResult = 'error';
        this.renderPanel();
        this._error.text = this._provider.describeError(e);
        this._error.style_class = 'quota-error';
        this._error.opacity = 255;
        this._errorItem.visible = true;
        logError(e, `Quota: refresh failed for "${this.source.label}"`);
    }

    // Clears any stale usage and shows a quiet "signed out" note.
    _renderSignedOut(e) {
        for (const {meter} of this._meters.values())
            meter.destroy();
        this._meters.clear();
        this._windows = [];
        this._snap = null;
        this._clearIdentity('Signed out');
        this._linesItem.visible = false;

        this.lastResult = 'signed-out';
        this.renderPanel();

        this._error.text = e.message;
        this._error.style_class = 'quota-note';
        this._error.opacity = DIM_OPACITY;
        this._errorItem.visible = true;
    }

    destroy() {
        for (const {meter} of this._meters.values())
            meter.destroy();
        this._meters.clear();
        for (const group of this._groups)
            group.destroy();
        this._groups = [];

        this._groupsBox?.destroy();
        this._plan?.destroy();
        this._panelBlock?.destroy();
        this._info?.destroy();
        this._infoItem?.destroy();
        this._metersSection?.destroy();
        this._lines?.destroy();
        this._linesItem?.destroy();
        this._error?.destroy();
        this._errorItem?.destroy();

        this._groupsBox = null;
        this._plan = null;
        this._panelBlock = null;
        this._info = null;
        this._infoItem = null;
        this._metersSection = null;
        this._lines = null;
        this._linesItem = null;
        this._error = null;
        this._errorItem = null;
        this._windows = [];
        this._snap = null;
        this._provider?.destroy();
        this._provider = null;
    }
}

// The provider for a source (see lib/sources.js).
function makeProvider(source, settings) {
    if (source.kind === 'openrouter')
        return new OpenRouterProvider(source);
    return new ClaudeProvider(source, settings);
}

// A menu item that does its work without closing the menu, so the result
// shows up where you are looking (Refresh, picking a source).
const StayOpenItem = GObject.registerClass(
class QuotaStayOpenItem extends PopupMenu.PopupMenuItem {
    _init(text, onActivate) {
        super._init(text);
        this._onActivate = onActivate;
    }

    activate(_event) {
        this._onActivate?.();
    }

    destroy() {
        this._onActivate = null;
        super.destroy();
    }
});

const QuotaIndicator = GObject.registerClass(
class QuotaIndicator extends PanelMenu.Button {
    _init(path, settings, openPreferences) {
        super._init(0.5, 'Quota');

        this._path = path;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._busy = false;
        this._cancellable = new Gio.Cancellable();
        this._lastFetchMs = 0;
        this._sources = [];
        this._active = null;
        this._view = null;
        this._sourceItems = [];
        this._countdownTimer = null;
        this._timer = null;

        // ---- top bar: [source icon] [view block] ----
        this._panelBox = new St.BoxLayout({style_class: 'quota-panel'});
        this._icon = new St.Icon({
            gicon: sourceIcon(path, 'quota-symbolic.svg'),
            style_class: 'system-status-icon quota-panel-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._icon);
        this.add_child(this._panelBox);

        this._buildMenu();

        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (!open)
                return;
            // The captions are not ticked while the menu is closed, and the
            // refresh below may be throttled, so bring them up to date first.
            this._view?.refreshCountdowns(true);
            this._refresh();
        }, this);

        // Live-apply setting changes without a shell reload.
        this._settings.connectObject(
            'changed::show-icon', () => this._applySettings(),
            'changed::panel-gauge', () => this._applySettings(),
            'changed::show-percentage', () => this._applySettings(),
            'changed::show-plan', () => this._applySettings(),
            'changed::show-reset', () => this._applySettings(),
            'changed::panel-windows', () => this._view?.renderPanel(),
            'changed::poll-seconds', () => this._startTimer(),
            // Sources added, removed or renamed in prefs (or a sign-in made
            // there, which rewrites profile-tokens), or another one picked.
            'changed::profiles', () => this._reloadSources(),
            'changed::openrouter-accounts', () => this._reloadSources(),
            'changed::profile-tokens', () => this._refresh(true),
            'changed::active-source', () => this._showActive(),
            this);

        this._initSources();
    }

    _buildMenu() {
        // The source: a submenu to switch between sources when there are
        // several, else a plain heading.
        this._sourcesItem = new PopupMenu.PopupSubMenuMenuItem('', true);
        this.menu.addMenuItem(this._sourcesItem);
        this._headerItem = new PopupMenu.PopupImageMenuItem('', null,
            {reactive: false, can_focus: false, style_class: 'quota-item'});
        this.menu.addMenuItem(this._headerItem);

        // The shown source's account line, meters and notes, rebuilt when
        // another source is picked.
        this._viewSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._viewSection);

        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._separator);

        this._usageItem = new PopupMenu.PopupMenuItem('Open Usage Page');
        this._usageItem.connectObject('activate', () => {
            const url = this._view?.usageUrl;
            if (url)
                Gio.AppInfo.launch_default_for_uri(url, null);
        }, this);
        this.menu.addMenuItem(this._usageItem);

        this._refreshItem = new StayOpenItem('Refresh', () => this._refresh(true));
        this._updated = dimLabel({
            text: '',
            style_class: 'quota-updated',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._refreshItem.add_child(this._updated);
        this.menu.addMenuItem(this._refreshItem);

        this._settingsItem = new PopupMenu.PopupMenuItem('Settings');
        this._settingsItem.connectObject('activate', () => this._openPreferences?.(), this);
        this.menu.addMenuItem(this._settingsItem);
    }

    // One-time async setup: seeds the Claude profile list (auto-detection)
    // if it is empty, then shows the sources.
    async _initSources() {
        const cancellable = this._cancellable;
        await ensureProfiles(this._settings);
        if (cancellable.is_cancelled())
            return;
        this._reloadSources();
    }

    // The list of sources changed: rebuild the switcher, then show the
    // active one.
    _reloadSources() {
        this._destroySourceItems();
        this._sources = loadSources(this._settings);
        for (const source of this._sources) {
            const item = new StayOpenItem(source.label, () => {
                this._settings.set_string('active-source', source.id);
                this._sourcesItem.menu.close(true);
            });
            item.setOrnament(PopupMenu.Ornament.NONE);
            this._sourcesItem.menu.addMenuItem(item);
            this._sourceItems.push({item, source});
        }
        this._showActive();
    }

    // Shows the source picked in the menu (the first one when none is): its
    // name and icon, a check mark in the switcher, and a fresh view.
    _showActive() {
        // A fetch still running for the previous source is dropped, so the
        // new one is fetched right away instead of waiting for it.
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        this._busy = false;
        this._destroyView();

        const active = activeSource(this._settings, this._sources);
        this._active = active;
        for (const {item, source} of this._sourceItems)
            item.setOrnament(source === active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);

        const several = this._sources.length > 1;
        this._sourcesItem.visible = several;
        this._headerItem.visible = !several;
        if (active) {
            const provider = makeProvider(active, this._settings);
            const gicon = sourceIcon(this._path, provider.icon);
            this._sourcesItem.label.text = active.label;
            this._sourcesItem.icon.gicon = gicon;
            this._headerItem.label.text = active.label;
            this._headerItem.setIcon(gicon);
            this._icon.gicon = gicon;
            this._view = new SourceView(active, provider, this._settings, this._panelBox, this._viewSection);
            this._updated.text = '';
        } else {
            this._headerItem.label.text = 'No Accounts';
            this._headerItem.setIcon(sourceIcon(this._path, 'quota-symbolic.svg'));
            this._icon.gicon = sourceIcon(this._path, 'quota-symbolic.svg');
            this._updated.text = '';
        }
        this._usageItem.visible = !!active;
        this._refreshItem.visible = !!active;
        this._settingsItem.label.text = active ? 'Settings' : 'Add an Account…';
        this._applySettings();
        this._view?.applyQuickTier(this._cancellable);
        this._refresh(true);
        this._startTimer();
    }

    _applySettings() {
        // With nothing else in the top bar the icon is all there is to click.
        this._icon.visible = !this._view || this._settings.get_boolean('show-icon')
            || (this._settings.get_string('panel-gauge') === 'none'
                && !this._settings.get_boolean('show-percentage'));
        this._view?.applySettings();
    }

    _destroySourceItems() {
        for (const {item} of this._sourceItems)
            item.destroy();
        this._sourceItems = [];
    }

    _destroyView() {
        if (this._countdownTimer) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
        this._view?.destroy();
        this._view = null;
    }

    _startTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        const seconds = this._settings.get_int('poll-seconds');
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _renderUpdatedAt() {
        const result = this._view?.lastResult;
        if (result === 'ok')
            this._updated.text = `Updated ${GLib.DateTime.new_now_local().format('%H:%M')}`;
        else if (result === 'error')
            this._updated.text = 'Update failed';
        else
            this._updated.text = '';
    }

    // force bypasses the min-gap throttle (explicit actions like Refresh, a
    // sign-in or switching sources); opening the menu and the poll timer go
    // through it.
    _refresh(force = false) {
        if (!this._view)
            return;
        // A fetch that never settles (a keyring that does not answer) must
        // not block every later one: past the stall limit it is dropped.
        if (this._busy) {
            if (Date.now() - this._lastFetchMs < STALLED_FETCH_MS)
                return;
            this._cancellable.cancel();
            this._cancellable = new Gio.Cancellable();
        } else if (!force && Date.now() - this._lastFetchMs < MIN_REFRESH_MS) {
            return;
        }
        this._busy = true;
        this._lastFetchMs = Date.now();
        this._updated.text = 'Updating…';

        const cancellable = this._cancellable;
        this._view.refresh(cancellable).finally(() => {
            if (cancellable.is_cancelled())
                return;
            this._busy = false;
            this._renderUpdatedAt();
            this._scheduleCountdown();
        });
    }

    // Ticks the countdowns between polls: every second once a reset is under
    // 90s away, every 30s otherwise. Nothing is fetched here.
    _scheduleCountdown() {
        if (this._countdownTimer) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
        const soonest = this._view?.soonestResetSeconds() ?? null;
        if (soonest === null)
            return;
        const interval = soonest < 90 ? 1 : 30;
        this._countdownTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._countdownTimer = null;
            this._view?.refreshCountdowns(this.menu.isOpen);
            this._scheduleCountdown();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        // Abort any in-flight fetch so its callback drops out (it checks the
        // cancellable) instead of touching torn-down actors.
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        this.menu.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;
        this._usageItem?.disconnectObject(this);
        this._settingsItem?.disconnectObject(this);

        this._destroyView();
        this._destroySourceItems();

        this._updated?.destroy();
        this._updated = null;
        this._refreshItem?.destroy();
        this._refreshItem = null;
        this._usageItem?.destroy();
        this._usageItem = null;
        this._settingsItem?.destroy();
        this._settingsItem = null;
        this._separator?.destroy();
        this._separator = null;
        this._viewSection?.destroy();
        this._viewSection = null;
        this._headerItem?.destroy();
        this._headerItem = null;
        this._sourcesItem?.destroy();
        this._sourcesItem = null;
        this._icon?.destroy();
        this._icon = null;
        this._panelBox?.destroy();
        this._panelBox = null;

        super.destroy();
    }
});

export default class QuotaExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new QuotaIndicator(
            this.path, this._settings, () => this.openPreferences());
        // Watch both placement keys so a move applies at once.
        this._settings.connectObject(
            'changed::panel-position', () => this._place(),
            'changed::panel-index', () => this._place(),
            this);
        this._place();

        // Optional shortcut that opens the menu, bound the way the shell binds
        // its own panel menus. Unbound by default.
        Main.wm.addKeybinding(
            'quota-toggle-menu',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            // POPUP matters: while the menu is open the shell is in popup
            // mode, and a binding without it could open the menu but never
            // close it again.
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._indicator?.menu.toggle());
    }

    // Puts the indicator in the configured top bar section. addToStatusArea
    // refuses a role that is already registered, so the registration is
    // cleared first; the indicator itself is reused, so moving it costs no
    // refetch.
    _place() {
        if (Main.panel.statusArea[this.uuid])
            Main.panel.statusArea[this.uuid] = null;
        Main.panel.addToStatusArea(
            this.uuid, this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-position'));
    }

    disable() {
        Main.wm.removeKeybinding('quota-toggle-menu');
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
