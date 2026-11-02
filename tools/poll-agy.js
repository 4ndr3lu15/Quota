#!/usr/bin/env -S gjs -m
// Standalone check: validates the Antigravity (agy) provider against the live
// Google AI / Cloud Code quota endpoint or CLI fallback.
//   gjs -m tools/poll-agy.js
import GLib from 'gi://GLib';
import {AgyProvider, defaultAgyConfigDir} from '../src/lib/providers/agy.js';

const loop = GLib.MainLoop.new(null, false);

const configDir = typeof ARGV !== 'undefined' && ARGV[0] ? ARGV[0] : defaultAgyConfigDir();

async function run() {
    const provider = new AgyProvider({id: 'agy', label: 'Google AI', configDir});
    print('config dir:', configDir);
    print('tier (from disk):', JSON.stringify(await provider.quickTier()));

    const snap = await provider.fetch(null);
    print('\nsubtitle:', snap.subtitle);
    print('tier:', JSON.stringify(snap.tier));
    print('\nusage windows:');
    for (const w of snap.windows)
        print(`  ${w.label}: ${Math.round(w.utilization)}%  resets ${w.resetsAt ?? '(n/a)'}  [${w.apiLevel}]`);
    if (snap.lines?.length) {
        print('\nlines:');
        for (const l of snap.lines)
            print(`  ${l.text}`);
    }
}

run()
    .catch(e => {
        printerr('ERROR:', e.message);
        if (e.body)
            printerr('BODY:', e.body);
        imports.system.exit(1);
    })
    .finally(() => loop.quit());

loop.run();
