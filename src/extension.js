import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {UsageError, SignedOutError} from './lib/usageClient.js';
import {ensureProfiles} from './lib/profiles.js';
import {loadSources, ensureAgyAccounts} from './lib/sources.js';
import {lookupMinitronKey} from './lib/secrets.js';
import {ClaudeProvider} from './lib/providers/claude.js';
import {AgyProvider} from './lib/providers/agy.js';
import {OpenRouterProvider} from './lib/providers/openrouter.js';
import {
    maxLevel, judgeWindow, projectionNote, relativeReset, overallStatus,
} from './lib/status.js';
import {drawMark} from './lib/mark.js';

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

// A two-finger swipe turns the page once it has moved this far sideways (in
// Clutter's smooth-scroll steps, about 10 px of finger travel each), and
// only once per gesture: events closer together than SWIPE_GAP_MS are the
// same gesture.
const SWIPE_STEPS = 3;
const SWIPE_GAP_MS = 250;

// The platforms, in menu order, with what their section says when no
// account of that kind is set up.
const KINDS = [
    {kind: 'claude', name: 'Claude', addLabel: 'Add a Claude Account…'},
    {kind: 'agy', name: 'Antigravity', addLabel: 'Add a Google Account…'},
    {kind: 'openrouter', name: 'OpenRouter', addLabel: 'Add an OpenRouter Key…'},
];

// Style class for a window level that needs one: only warnings and critical
// levels are colored; a calm level keeps the theme's own color.
function levelClass(level) {
    return level === 'warn' || level === 'crit' ? `quota-${level}` : null;
}

function classes(...names) {
    return names.filter(Boolean).join(' ');
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

// Opens the Monolito report popup for Quota: Open("Quota", "") on the
// MINITRON Shell extension's bus name, or the minitron://report link when
// that name is not on the bus.
function openReport() {
    Gio.DBus.session.call(
        'io.github._4ndr3lu15.Monolith.Report',
        '/io/github/_4ndr3lu15/Monolith/Report',
        'io.github._4ndr3lu15.Monolith.Report',
        'Open', new GLib.Variant('(ss)', ['Quota', '']),
        null, Gio.DBusCallFlags.NONE, -1, null,
        (connection, result) => {
            try {
                connection.call_finish(result);
            } catch {
                try {
                    Gio.AppInfo.launch_default_for_uri('minitron://report?app=Quota', null);
                } catch (e) {
                    console.warn(`Quota: could not open the report popup: ${e.message}`);
                }
            }
        });
}

// Assigns an actor property only when it changes. Values are re-applied on
// every countdown tick and rarely differ, so this keeps an idle tick from
// touching the actors at all.
function setIfChanged(actor, prop, value) {
    if (actor[prop] !== value)
        actor[prop] = value;
}

// The Monolito mark (lib/mark.js), drawn in the widget's own foreground
// color the way the shell draws symbolic icons. The state class
// (stylesheet.css) sets that color: bright ones in the top bar, which is
// always dark, mid-tones in the menu. An unknown state keeps the theme's
// text color, at half strength.
const MonolitoMark = GObject.registerClass(
class QuotaMonolitoMark extends St.DrawingArea {
    _init(place) {
        super._init({y_align: Clutter.ActorAlign.CENTER});
        this._place = place;
        this._state = null;
        this.setState('unknown');
    }

    setState(state) {
        if (state === this._state)
            return;
        this._state = state;
        this.style_class = classes('quota-mark', `quota-mark-${this._place}`, `quota-${state}`);
        this.queue_repaint();
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const fg = this.get_theme_node().get_foreground_color();
        const alpha = (fg.alpha / 255) * (this._state === 'unknown' ? 0.5 : 1);
        drawMark(cr, w, h, [fg.red / 255, fg.green / 255, fg.blue / 255, alpha]);
        cr.$dispose();
    }
});

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
        this._track.connectObject('notify::allocation', () => this._resizeFill(), this);

        this._caption = wrapLabel(dimLabel({text: '', style_class: 'quota-meter-caption'}));

        this._box.add_child(this._row);
        this._box.add_child(this._track);
        this._box.add_child(this._caption);
        this.item.add_child(this._box);
    }

    // The bar tracks actual utilization; the level (projection included)
    // only changes its color.
    setValue(util, caption, level) {
        setIfChanged(this._pct, 'text', `${Math.round(util)}%`);
        setIfChanged(this._pct, 'style_class', classes('quota-meter-pct', levelClass(level)));
        this._fraction = Math.max(0, Math.min(100, util)) / 100;
        setIfChanged(this._fill, 'style_class', classes('quota-meter-fill', levelClass(level)));
        this._resizeFill();
        setIfChanged(this._caption, 'text', caption ?? '');
        this._caption.visible = !!caption;
    }

    // No share to show (credits never bought): an empty bar, the caption kept.
    setMuted(caption) {
        this._pct.text = '—';
        this._pct.style_class = 'quota-meter-pct';
        this._fill.style_class = 'quota-meter-fill';
        this._fraction = 0;
        this._resizeFill();
        this._caption.text = caption ?? '';
        this._caption.visible = !!caption;
    }

    setName(name) {
        setIfChanged(this._name, 'text', name);
    }

    // Reads the track's last allocation, never get_width(): once the fill
    // changes, the track awaits a relayout and get_width() answers with its
    // preferred width, which is the fill's own, so each update shrank the
    // bar by the fraction again (50% → 25% → 12.5%).
    _resizeFill() {
        if (!this._track?.has_allocation())
            return;
        const box = this._track.get_allocation_box();
        const w = Math.round(this._fraction * box.get_width());
        if (this._fill.width !== w)
            this._fill.set_width(w);
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

// The section title for one account. The pager already names the platform,
// so the only account of a kind has no header, and with several each is
// headed by its own name ("Work", "OpenRouter 2").
function sectionTitle(kindName, label, several) {
    if (!several)
        return null;
    return label || kindName;
}

// One account's part of the menu (a Claude profile or an OpenRouter
// account): a section header in the shell's own style, the account line, one
// meter per usage window, info lines, and an error or signed-out note. The
// provider (lib/providers/) fetches a snapshot, {subtitle, tier, windows,
// lines}, and this renders it, whatever the platform.
class SourceSection {
    constructor(source, provider, title) {
        this.source = source;
        this._provider = provider;
        // Outcome of the last refresh: null until the first one ends, then
        // 'ok' | 'error' | 'signed-out'. overallStatus() reads it.
        this.lastResult = null;
        this._snap = null;
        this._subtitle = null;
        this._tier = null;
        this._windows = [];
        // key -> {meter, w}, so meters are reused across polls and torn down
        // only when the API stops reporting that window.
        this._meters = new Map();

        this.section = new PopupMenu.PopupMenuSection();
        // No title (the only account of its kind): the pager names the page.
        this._header = title ? new PopupMenu.PopupSeparatorMenuItem(title) : null;
        if (this._header)
            this.section.addMenuItem(this._header);
        [this._infoItem, this._info] = textItem('quota-info', true);
        this.section.addMenuItem(this._infoItem);
        this._metersSection = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(this._metersSection);
        [this._linesItem, this._lines] = textItem('quota-lines', true);
        this.section.addMenuItem(this._linesItem);
        [this._errorItem, this._error] = textItem('quota-error');
        this.section.addMenuItem(this._errorItem);
    }

    get usageUrl() {
        return this._provider.usageUrl;
    }

    // What overallStatus() judges.
    statusInput() {
        return {
            kind: this.source.kind,
            label: this.source.label,
            result: this.lastResult,
            windows: this._windows,
        };
    }

    // "Account · Plan" under the header. Called on every poll, so it only
    // acts on a change.
    _setIdentity(subtitle, tier) {
        this._subtitle = subtitle ?? this._subtitle;
        this._tier = tier ?? this._tier;
        const info = [this._subtitle, this._tier?.label].filter(Boolean).join(' · ');
        setIfChanged(this._info, 'text', info);
        this._infoItem.visible = info !== '';
    }

    // The tier the provider knows without the network (Claude reads it from
    // disk), so the account line is not blank until the first fetch.
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

    // Fetches this account's snapshot; never rejects (errors are reported
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
        this.lastResult = 'ok';
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

    // Soonest reset among this account's windows, in seconds, or null.
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

    // Re-applies the last fetched usage so the reset countdowns and pace
    // colors move between polls. Nothing is fetched.
    refreshCountdowns() {
        for (const {meter, w} of this._meters.values())
            this._applyWindow(meter, w);
    }

    // The color reflects the consequence of the current pace (judgeWindow),
    // floored at the API's own severity; the caption says it in words.
    _applyWindow(meter, w) {
        const now = Date.now();
        let caption = w.resetsAt ? relativeReset(w.resetsAt, now)
            : (w.utilization > 0 || w.detail ? '' : 'Not used yet');
        // A money window says how much of what ("$1.20 of $5.00") first.
        if (w.detail)
            caption = caption ? `${w.detail} · ${caption}` : w.detail;
        if (!Number.isFinite(w.utilization)) {
            meter.setMuted(w.detail ?? '');
            return;
        }
        const note = projectionNote(w.utilization, w.resetsAt, w.totalSeconds, now);
        if (note)
            caption = caption ? `${caption} · ${note}` : note;
        meter.setValue(w.utilization, caption, judgeWindow(w, now));
    }

    _renderError(e) {
        // A cancelled request means the section is being torn down.
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        // No login for this account: a state, not a failure.
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
        this._subtitle = null;
        this._tier = null;
        this._setIdentity(null, null);
        this._linesItem.visible = false;
        this.lastResult = 'signed-out';

        this._error.text = e.message;
        this._error.style_class = 'quota-note';
        this._error.opacity = DIM_OPACITY;
        this._errorItem.visible = true;
    }

    destroy() {
        for (const {meter} of this._meters.values())
            meter.destroy();
        this._meters.clear();

        this._header?.destroy();
        this._info?.destroy();
        this._infoItem?.destroy();
        this._metersSection?.destroy();
        this._lines?.destroy();
        this._linesItem?.destroy();
        this._error?.destroy();
        this._errorItem?.destroy();
        this.section?.destroy();

        this._header = null;
        this._info = null;
        this._infoItem = null;
        this._metersSection = null;
        this._lines = null;
        this._linesItem = null;
        this._error = null;
        this._errorItem = null;
        this.section = null;
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
    if (source.kind === 'agy')
        return new AgyProvider(source, settings);
    return new ClaudeProvider(source, settings);
}

// The row under the status line that picks the platform the menu shows,
// like the calendar's month header: back and forward buttons around the
// platform's name, with one dot per page below it. Pages wrap around.
class Pager {
    constructor(names, onStep) {
        this._onStep = onStep;
        this.item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'quota-item quota-pager'});

        this._back = new St.Button({
            style_class: 'icon-button flat quota-pager-button',
            icon_name: 'pan-start-symbolic',
            accessible_name: 'Previous Platform',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._back.connectObject('clicked', () => this._onStep?.(-1), this);

        this._middle = vbox({style_class: 'quota-pager-middle', x_expand: true});
        this._title = new St.Label({style_class: 'quota-pager-title', x_align: Clutter.ActorAlign.CENTER});
        this._dotsBox = new St.BoxLayout({style_class: 'quota-pager-dots', x_align: Clutter.ActorAlign.CENTER});
        this._dots = names.map(() => {
            const dot = new St.Widget({style_class: 'quota-pager-dot', y_align: Clutter.ActorAlign.CENTER});
            this._dotsBox.add_child(dot);
            return dot;
        });
        this._middle.add_child(this._title);
        this._middle.add_child(this._dotsBox);

        this._forward = new St.Button({
            style_class: 'icon-button flat quota-pager-button',
            icon_name: 'pan-end-symbolic',
            accessible_name: 'Next Platform',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._forward.connectObject('clicked', () => this._onStep?.(1), this);

        this.item.add_child(this._back);
        this.item.add_child(this._middle);
        this.item.add_child(this._forward);
        this._names = names;
    }

    show(index) {
        setIfChanged(this._title, 'text', this._names[index]);
        this._dots.forEach((dot, i) => {
            setIfChanged(dot, 'style_class', classes('quota-pager-dot', i === index && 'quota-current'));
        });
    }

    destroy() {
        this._back?.disconnectObject(this);
        this._forward?.disconnectObject(this);
        for (const dot of this._dots ?? [])
            dot.destroy();
        this._dots = null;
        this._dotsBox?.destroy();
        this._dotsBox = null;
        this._title?.destroy();
        this._title = null;
        this._middle?.destroy();
        this._middle = null;
        this._back?.destroy();
        this._back = null;
        this._forward?.destroy();
        this._forward = null;
        this.item?.destroy();
        this.item = null;
        this._onStep = null;
    }
}

// A menu item that does its work without closing the menu, so the result
// shows up where you are looking (Refresh).
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
    // openPreferences(page) opens Settings, on its Accounts page when page
    // is 'accounts'.
    _init(settings, openPreferences) {
        super._init(0.5, 'Quota');

        this._settings = settings;
        this._openPreferences = openPreferences;
        this._busy = false;
        this._cancellable = new Gio.Cancellable();
        this._lastFetchMs = 0;
        this._sections = [];
        // Rows each kind's part of the menu adds besides its accounts (Open
        // Usage Page, or the add row when it has none).
        this._kindItems = [];
        this._countdownTimer = null;
        this._timer = null;
        this._minitronKey = false;
        // The platform the menu shows (an index into KINDS), and the
        // two-finger swipe in progress.
        const page = KINDS.findIndex(k => k.kind === this._settings.get_string('menu-page'));
        this._page = Math.max(0, page);
        this._swipe = {dx: 0, dy: 0, lastMs: 0, done: false};

        // ---- top bar: the Monolito mark, nothing else ----
        this._mark = new MonolitoMark('panel');
        this.add_child(this._mark);

        this._buildMenu();

        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (!open)
                return;
            // The captions are not ticked while the menu is closed, and the
            // refresh below may be throttled, so bring them up to date first.
            this._tick();
            this._refresh();
            // A key added in MINITRON since the last look appears as its
            // OpenRouter account.
            if (!this._minitronKey) {
                const cancellable = this._cancellable;
                this._checkMinitronKey(cancellable).then(() => {
                    if (this._minitronKey && !cancellable.is_cancelled())
                        this._reloadSources();
                });
            }
        }, this);
        // A sideways two-finger swipe (or a tilted wheel) anywhere on the
        // menu turns the page.
        this.menu.actor.connectObject('scroll-event', (_a, event) => this._onMenuScroll(event), this);

        this._settings.connectObject(
            'changed::poll-seconds', () => this._startTimer(),
            // Accounts added, removed or renamed in Settings (or a sign-in
            // made there, which rewrites profile-tokens).
            'changed::profiles', () => this._reloadSources(),
            'changed::agy-accounts', () => this._reloadSources(),
            'changed::openrouter-accounts', () => this._reloadSources(),
            'changed::profile-tokens', () => this._refresh(true),
            this);

        this._syncStatus();
        this._initSources();
    }

    _buildMenu() {
        // The state in words, beside the mark in the same color.
        this._statusItem = new PopupMenu.PopupBaseMenuItem(
            {reactive: false, can_focus: false, style_class: 'quota-item quota-status'});
        this._statusMark = new MonolitoMark('menu');
        this._statusLabel = wrapLabel(new St.Label({text: '', style_class: 'quota-status-label', y_align: Clutter.ActorAlign.CENTER}));
        this._statusItem.add_child(this._statusMark);
        this._statusItem.add_child(this._statusLabel);
        this.menu.addMenuItem(this._statusItem);

        this._pager = new Pager(KINDS.map(k => k.name), step => this._turnPage(step));
        this.menu.addMenuItem(this._pager.item);

        // One page per platform, every account in it, rebuilt when the
        // accounts change; only the current page is shown.
        this._kindSections = new Map();
        for (const {kind} of KINDS) {
            const section = new PopupMenu.PopupMenuSection();
            this._kindSections.set(kind, section);
            this.menu.addMenuItem(section);
        }
        this._showPage();

        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._separator);

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

        // Report a bug or idea through the Monolito report popup (the
        // MINITRON Shell extension); its link when that is not running.
        this._reportItem = new PopupMenu.PopupMenuItem('Report…');
        this._reportItem.connectObject('activate', () => openReport(), this);
        this.menu.addMenuItem(this._reportItem);

        this._settingsItem = new PopupMenu.PopupMenuItem('Settings');
        this._settingsItem.connectObject('activate', () => this._openPreferences?.(''), this);
        this.menu.addMenuItem(this._settingsItem);
    }

    // One-time async setup: seeds the Claude and Antigravity profile lists
    // (auto-detection) if they are empty, then shows the accounts.
    async _initSources() {
        const cancellable = this._cancellable;
        await ensureProfiles(this._settings);
        await ensureAgyAccounts(this._settings);
        await this._checkMinitronKey(cancellable);
        if (cancellable.is_cancelled())
            return;
        this._reloadSources();
    }

    // Whether MINITRON holds an OpenRouter key Quota can show (lib/sources.js).
    // A keyring that cannot be read just means no shared account.
    async _checkMinitronKey(cancellable) {
        try {
            this._minitronKey = !!await lookupMinitronKey(cancellable);
        } catch {
            this._minitronKey = false;
        }
    }

    // The accounts changed: rebuild every section (cancelling any fetch in
    // flight) and fetch them all.
    _reloadSources() {
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        this._busy = false;
        this._destroySections();

        const sources = loadSources(this._settings, {minitronKey: this._minitronKey});
        for (const {kind, name, addLabel} of KINDS) {
            const parent = this._kindSections.get(kind);
            const mine = sources.filter(s => s.kind === kind);
            if (!mine.length) {
                // Nothing set up: one quiet row that opens the Accounts page.
                const add = new PopupMenu.PopupMenuItem(addLabel);
                add.label.opacity = DIM_OPACITY;
                add.connectObject('activate', () => this._openPreferences?.('accounts'), this);
                parent.addMenuItem(add);
                this._kindItems.push(add);
                continue;
            }
            let usageUrl = null;
            for (const source of mine) {
                const provider = makeProvider(source, this._settings);
                const section = new SourceSection(source, provider,
                    sectionTitle(name, source.label, mine.length > 1));
                parent.addMenuItem(section.section);
                this._sections.push(section);
                usageUrl ??= section.usageUrl;
                section.applyQuickTier(this._cancellable);
            }
            // One usage page per platform: every account of a kind shares it.
            if (usageUrl) {
                const item = new PopupMenu.PopupMenuItem('Open Usage Page');
                item.connectObject('activate', () => Gio.AppInfo.launch_default_for_uri(usageUrl, null), this);
                parent.addMenuItem(item);
                this._kindItems.push(item);
            }
        }

        this._refreshItem.visible = this._sections.length > 0;
        this._updated.text = '';
        this._syncStatus();
        this._refresh(true);
        this._startTimer();
    }

    // Shows the current page's platform and hides the others.
    _showPage() {
        KINDS.forEach(({kind}, i) => {
            this._kindSections.get(kind).actor.visible = i === this._page;
        });
        this._pager.show(this._page);
    }

    // Moves step pages on (wrapping around) and remembers the page for the
    // next time the menu opens.
    _turnPage(step) {
        this._page = (this._page + step + KINDS.length) % KINDS.length;
        this._showPage();
        this._settings.set_string('menu-page', KINDS[this._page].kind);
    }

    // Sideways scrolling turns the page: a tilted wheel's left/right clicks
    // one page each, a touchpad swipe one page per gesture once it has gone
    // SWIPE_STEPS mostly sideways. With natural scrolling, sliding two
    // fingers to the left brings the next page, as in the app grid. Vertical
    // scrolling is left to the menu.
    _onMenuScroll(event) {
        // Clutter pairs each smooth event with an emulated discrete one (and
        // the other way round); handle each scroll once.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_PROPAGATE;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.LEFT:
            this._turnPage(-1);
            return Clutter.EVENT_STOP;
        case Clutter.ScrollDirection.RIGHT:
            this._turnPage(1);
            return Clutter.EVENT_STOP;
        case Clutter.ScrollDirection.SMOOTH:
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }

        const swipe = this._swipe;
        const time = event.get_time();
        if (time - swipe.lastMs > SWIPE_GAP_MS)
            Object.assign(swipe, {dx: 0, dy: 0, done: false});
        swipe.lastMs = time;
        const [dx, dy] = event.get_scroll_delta();
        swipe.dx += dx;
        swipe.dy += dy;
        // Fingers lifted: the next movement is a new gesture.
        const finished = event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE;
        if (!swipe.done && Math.abs(swipe.dx) >= SWIPE_STEPS && Math.abs(swipe.dx) > Math.abs(swipe.dy)) {
            swipe.done = true;
            this._turnPage(swipe.dx > 0 ? 1 : -1);
        }
        const sideways = swipe.done || Math.abs(swipe.dx) > Math.abs(swipe.dy);
        if (finished)
            Object.assign(swipe, {dx: 0, dy: 0, done: false});
        return sideways ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _destroySections() {
        if (this._countdownTimer) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
        for (const section of this._sections)
            section.destroy();
        this._sections = [];
        for (const item of this._kindItems) {
            item.disconnectObject(this);
            item.destroy();
        }
        this._kindItems = [];
    }

    // The mark's color and the status line, from every account at once.
    _syncStatus() {
        const {state, text} = overallStatus(this._sections.map(s => s.statusInput()));
        this._mark.setState(state);
        this._statusMark.setState(state);
        setIfChanged(this._statusLabel, 'text', text);
        setIfChanged(this, 'accessible_name', `Quota: ${text}`);
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
        const results = this._sections.map(s => s.lastResult);
        if (results.includes('ok'))
            this._updated.text = `Updated ${GLib.DateTime.new_now_local().format('%H:%M')}`;
        else if (results.includes('error'))
            this._updated.text = 'Update failed';
        else
            this._updated.text = '';
    }

    // Fetches every account at once. force bypasses the min-gap throttle
    // (Refresh, a sign-in, accounts changed); opening the menu and the poll
    // timer go through it.
    _refresh(force = false) {
        if (!this._sections.length)
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
        // Each account updates the status as soon as it answers.
        const fetches = this._sections.map(section => section.refresh(cancellable).then(() => {
            if (!cancellable.is_cancelled())
                this._syncStatus();
        }));
        Promise.allSettled(fetches).then(() => {
            if (cancellable.is_cancelled())
                return;
            this._busy = false;
            this._renderUpdatedAt();
            this._scheduleCountdown();
        });
    }

    // Moves the time-derived parts between polls: the meters' reset
    // countdowns (only while the menu shows them) and the status.
    _tick() {
        if (this.menu.isOpen) {
            for (const section of this._sections)
                section.refreshCountdowns();
        }
        this._syncStatus();
    }

    // Ticks the countdowns between polls: every second once a reset is under
    // 90 s away, every 30 s otherwise. Nothing is fetched here.
    _scheduleCountdown() {
        if (this._countdownTimer) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
        const resets = this._sections.map(s => s.soonestResetSeconds()).filter(s => s !== null);
        if (!resets.length)
            return;
        const interval = Math.min(...resets) < 90 ? 1 : 30;
        this._countdownTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._countdownTimer = null;
            this._tick();
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
        this.menu.actor.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;
        this._settingsItem?.disconnectObject(this);
        this._reportItem?.disconnectObject(this);

        this._destroySections();
        for (const section of this._kindSections?.values() ?? [])
            section.destroy();
        this._kindSections = null;

        this._statusMark?.destroy();
        this._statusMark = null;
        this._statusLabel?.destroy();
        this._statusLabel = null;
        this._statusItem?.destroy();
        this._statusItem = null;
        this._pager?.destroy();
        this._pager = null;
        this._updated?.destroy();
        this._updated = null;
        this._refreshItem?.destroy();
        this._refreshItem = null;
        this._settingsItem?.destroy();
        this._settingsItem = null;
        this._reportItem?.destroy();
        this._reportItem = null;
        this._separator?.destroy();
        this._separator = null;
        this._mark?.destroy();
        this._mark = null;

        super.destroy();
    }
});

export default class QuotaExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new QuotaIndicator(this._settings, page => {
            // Settings opens on the page asked for (prefs.js reads the key
            // and clears it).
            this._settings.set_string('prefs-page', page);
            this.openPreferences();
        });
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
