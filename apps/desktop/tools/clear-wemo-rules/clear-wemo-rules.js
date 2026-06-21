#!/usr/bin/env node
'use strict';

/**
 * Dibby Wemo — Clear All Wemo Firmware Rules (Windows tool)
 *
 * Standalone utility that wipes every NATIVE WEMO FIRMWARE rule across every
 * device Dibby has discovered.  These are the rules stored inside each
 * Wemo's on-device SQLite database (FetchRules / StoreRules SOAP API) — they
 * are SEPARATE from DWM rules (which live in `dwm-rules.json` and are fired
 * by the Dibby scheduler).
 *
 * DWM RULES ARE LEFT UNTOUCHED.
 *
 * Why this exists: native firmware rules stopped firing autonomously after
 * Belkin shut down the cloud, so they're dead weight in the device's
 * memory — but they can still be visible in the official Wemo app and
 * cause confusion.  A clean migration to DWM benefits from wiping them.
 *
 * Where the device list comes from:
 *   C:\ProgramData\DibbyWemoManager\devices.json
 * (this is the SHARED_DATA_DIR/DEVICES_FILE path used by both the desktop
 * GUI and the headless DibbyWemoScheduler service — see
 * apps/desktop/src/main/core/paths.js)
 *
 * The script asks for explicit confirmation before deleting anything.  It
 * prints per-device progress + a final summary.  Exit code 0 = success.
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const wemo = require('./wemo-client');

const APP_NAME      = 'DibbyWemoManager';
const PROGRAM_DATA  = process.env.ProgramData || 'C:\\ProgramData';
const DEVICES_FILE  = path.join(PROGRAM_DATA, APP_NAME, 'devices.json');

// ANSI colours (most Windows 10/11 terminals support them via VT processing)
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
};

function banner() {
  console.log('');
  console.log(`${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║       Dibby Wemo — Clear All Wemo Firmware Rules                 ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╠══════════════════════════════════════════════════════════════════╣${C.reset}`);
  console.log(`${C.bold}${C.cyan}║  Wipes the on-device firmware rules from every Wemo Dibby has    ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}║  discovered.  DWM rules in dwm-rules.json are NOT touched.       ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log('');
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function loadDevices() {
  if (!fs.existsSync(DEVICES_FILE)) {
    console.error(`${C.red}❌ Device list not found at:${C.reset}\n   ${DEVICES_FILE}`);
    console.error(`${C.dim}   Open the Dibby Wemo Manager desktop app at least once and run Discover, then re-run this tool.${C.reset}`);
    process.exit(2);
  }
  let raw;
  try { raw = fs.readFileSync(DEVICES_FILE, 'utf8'); }
  catch (e) {
    console.error(`${C.red}❌ Could not read device list:${C.reset} ${e.message}`);
    process.exit(2);
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    console.error(`${C.red}❌ Device list is not valid JSON:${C.reset} ${e.message}`);
    process.exit(2);
  }

  // Accept either shape:
  //   - Bare Array (older Dibby builds wrote this)
  //   - { devices: [...] }   (current desktop service shape)
  //   - { devices: [...], dwmRules: [...], ... }  (Homebridge plugin store
  //     shape — works if someone points DEVICES_FILE at dibby-wemo.json)
  let list;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && Array.isArray(parsed.devices)) {
    list = parsed.devices;
  } else {
    console.error(`${C.red}❌ Device list has unexpected shape — expected Array or {devices: Array}.${C.reset}`);
    process.exit(2);
  }

  // Keep only entries with a host + port — the firmware-rule SOAP calls
  // need both.  Silently drop any malformed records.
  return list.filter((d) => d && d.host && d.port);
}

async function clearOneDevice(d) {
  const name = d.friendlyName || d.name || d.host;
  const tag  = `${C.bold}${name}${C.reset} ${C.dim}(${d.host}:${d.port})${C.reset}`;
  try {
    const data = await wemo.fetchRules(d.host, Number(d.port));
    const ruleIds = (data.rules || []).map((r) => r.RuleID).filter(Boolean);

    if (ruleIds.length === 0) {
      console.log(`  ${C.dim}— ${tag} — no firmware rules${C.reset}`);
      return { name, deleted: 0, failed: 0, skipped: true };
    }

    console.log(`  ${tag} — deleting ${C.yellow}${ruleIds.length}${C.reset} firmware rule(s)…`);
    let ok = 0, bad = 0;
    for (const ruleId of ruleIds) {
      try {
        await wemo.deleteRule(d.host, Number(d.port), ruleId);
        ok++;
      } catch (e) {
        bad++;
        console.log(`     ${C.red}× rule ${ruleId} failed: ${e.message}${C.reset}`);
      }
    }
    console.log(`     ${C.green}✓ ${ok} deleted${C.reset}` + (bad ? `, ${C.red}${bad} failed${C.reset}` : ''));
    return { name, deleted: ok, failed: bad, skipped: false };
  } catch (e) {
    // Dimmer V2 (WDS060) newer firmware doesn't expose FetchRules — that's
    // expected, not a bug.  Surface it clearly + don't count as a failure.
    const msg = String(e.message || e);
    if (/upnp\s*action\s*not\s*supported|Unknown Action|401|403|404/i.test(msg)) {
      console.log(`  ${C.dim}— ${tag} — FetchRules not supported on this firmware (skipped)${C.reset}`);
      return { name, deleted: 0, failed: 0, skipped: true, unsupported: true };
    }
    console.log(`  ${C.red}× ${tag} — ${msg}${C.reset}`);
    return { name, deleted: 0, failed: 1, skipped: false };
  }
}

async function main() {
  banner();

  const devices = loadDevices();
  if (devices.length === 0) {
    console.log(`${C.yellow}No devices in${C.reset} ${DEVICES_FILE}.`);
    console.log(`${C.dim}Open the Dibby Wemo Manager desktop app and run Discover first.${C.reset}`);
    process.exit(0);
  }

  console.log(`Loaded ${C.bold}${devices.length}${C.reset} device(s) from:`);
  console.log(`  ${C.dim}${DEVICES_FILE}${C.reset}`);
  console.log('');
  for (const d of devices) {
    console.log(`  • ${C.bold}${d.friendlyName || d.name || d.host}${C.reset} ${C.dim}(${d.host}:${d.port})${C.reset}`);
  }
  console.log('');
  console.log(`${C.yellow}${C.bold}This will permanently delete every native Wemo firmware rule${C.reset}`);
  console.log(`${C.yellow}${C.bold}on the devices listed above.  DWM rules will NOT be touched.${C.reset}`);
  console.log('');

  const answer = await ask(`Proceed? Type ${C.bold}yes${C.reset} to continue, anything else to cancel: `);
  if (answer.toLowerCase() !== 'yes') {
    console.log('');
    console.log(`${C.dim}Cancelled.  No changes made.${C.reset}`);
    process.exit(0);
  }

  console.log('');
  console.log(`${C.bold}Working…${C.reset}`);
  const results = [];
  for (const d of devices) {
    results.push(await clearOneDevice(d));
  }

  // Summary
  const totalDeleted   = results.reduce((s, r) => s + r.deleted, 0);
  const totalFailed    = results.reduce((s, r) => s + r.failed, 0);
  const cleared        = results.filter((r) => r.deleted > 0).length;
  const empty          = results.filter((r) => r.skipped && !r.unsupported).length;
  const unsupported    = results.filter((r) => r.unsupported).length;

  console.log('');
  console.log(`${C.bold}${C.cyan}── Summary ─────────────────────────────────────────────────────────${C.reset}`);
  console.log(`  Devices processed:           ${C.bold}${devices.length}${C.reset}`);
  console.log(`  Devices cleared:             ${C.bold}${C.green}${cleared}${C.reset}`);
  console.log(`  Devices already empty:       ${C.bold}${empty}${C.reset}`);
  console.log(`  Devices on unsupported f/w:  ${C.bold}${unsupported}${C.reset} ${C.dim}(Dimmer V2 / newer Lightswitch-3_0 firmware doesn't expose FetchRules)${C.reset}`);
  console.log(`  Total firmware rules wiped:  ${C.bold}${C.green}${totalDeleted}${C.reset}`);
  if (totalFailed) {
    console.log(`  ${C.red}Errors:                      ${totalFailed}${C.reset}`);
  }
  console.log(`${C.bold}${C.cyan}────────────────────────────────────────────────────────────────────${C.reset}`);
  console.log('');
  console.log(`${C.green}✓ Done.${C.reset}  DWM rules in ${C.dim}${path.join(PROGRAM_DATA, APP_NAME, 'dwm-rules.json')}${C.reset} are unchanged.`);
  console.log('');
}

main().catch((e) => {
  console.error('');
  console.error(`${C.red}FATAL: ${e.stack || e.message || e}${C.reset}`);
  process.exit(1);
});
