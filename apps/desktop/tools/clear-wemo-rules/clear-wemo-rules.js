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

// How many devices to work on simultaneously.  Wemo radios are slow (up to
// 30 s per SOAP round-trip when sleepy) — serial processing of a 30-device
// home takes forever.  A small pool keeps LAN load negligible while cutting
// wall-clock time roughly by the pool factor.  Each device is wiped in a
// SINGLE StoreRules round-trip (see clearAllRules), so there's no per-rule
// reboot storm even at higher concurrency.
const CONCURRENCY = Math.max(1, parseInt(process.env.DWM_CLEAR_CONCURRENCY || '6', 10) || 6);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clearOneDevice(d) {
  const name  = d.friendlyName || d.name || d.host;
  const tag   = `${C.bold}${name}${C.reset} ${C.dim}(${d.host}:${d.port})${C.reset}`;
  const lines = [];   // buffered so pooled devices don't interleave output

  // One retry: a device that StoreRules briefly bounced (or was mid-reboot
  // from an earlier op) refuses the connection for a few seconds.  Wait and
  // try once more before giving up.
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Single-shot: one FetchRules + one StoreRules wipes the whole table,
      // instead of one StoreRules per rule (which caused the reboot storm).
      const removed = await wemo.clearAllRules(d.host, Number(d.port));
      if (removed === 0) {
        lines.push(`  ${C.dim}— ${tag} — no firmware rules${C.reset}`);
        return { name, deleted: 0, failed: 0, skipped: true, lines };
      }
      lines.push(`  ${C.green}✓ ${tag} — wiped ${removed} firmware rule(s)${C.reset}`);
      return { name, deleted: removed, failed: 0, skipped: false, lines };
    } catch (e) {
      const msg = String(e.message || e);

      // Firmware that doesn't expose FetchRules (Dimmer V2 / newer
      // Lightswitch-3_0) — expected, not a failure.
      if (/upnp\s*action\s*not\s*supported|Unknown Action|401|403|404/i.test(msg)) {
        lines.push(`  ${C.dim}— ${tag} — FetchRules not supported on this firmware (skipped)${C.reset}`);
        return { name, deleted: 0, failed: 0, skipped: true, unsupported: true, lines };
      }

      // An empty ruleDbPath means the device has never stored a rules DB —
      // nothing to wipe.  Count it as "already empty", not an error.
      if (/no ruleDbPath/i.test(msg)) {
        lines.push(`  ${C.dim}— ${tag} — no rules database on device (already empty)${C.reset}`);
        return { name, deleted: 0, failed: 0, skipped: true, lines };
      }

      // Connection-level errors → the device is likely mid-reboot.  Retry once.
      const isConn = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|aborted|socket hang up/i.test(msg);
      if (isConn && attempt < MAX_ATTEMPTS) {
        lines.push(`  ${C.dim}… ${tag} — ${msg}; retrying in 5s…${C.reset}`);
        await sleep(5000);
        continue;
      }

      lines.push(`  ${C.red}× ${tag} — ${msg}${C.reset}`);
      return { name, deleted: 0, failed: 1, skipped: false, lines };
    }
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight.  Results print
 * in completion order (each device's buffered lines flush atomically), and
 * return in input order for the summary.
 */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      const r = await worker(items[i]);
      results[i] = r;
      for (const line of r.lines || []) console.log(line);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
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
  console.log(`${C.bold}Working…${C.reset} ${C.dim}(${CONCURRENCY} devices at a time)${C.reset}`);
  const results = await runPool(devices, CONCURRENCY, clearOneDevice);

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
