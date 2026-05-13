'use strict';

/**
 * Dibby Wemo Manager — Docker entry point
 *
 * Runs the DWM scheduler + REST/WebSocket API server without Electron.
 * Configure via environment variables:
 *   DATA_DIR  — path to persistent data directory  (default: /data)
 *   PORT      — HTTP port                          (default: 3456)
 */

const http = require('http');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const DwmStore     = require('./lib/store');
const DwmScheduler = require('./lib/scheduler');
const wemo         = require('./lib/wemo-client');

const DATA_DIR = process.env.DATA_DIR || '/data';
const PORT     = parseInt(process.env.PORT || '3456', 10);
const WEB_DIR  = path.join(__dirname, 'web');

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const store     = new DwmStore(DATA_DIR);
const scheduler = new DwmScheduler({ store, wemoClient: wemo, log: console });

let _wss = null;

function broadcast(type, data) {
  if (!_wss) return;
  const msg = JSON.stringify({ type, data });
  for (const client of _wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(msg);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function jsonErr(res, msg, status = 500) {
  json(res, { error: msg }, status);
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const body = await new Promise((resolve) => {
    if (method !== 'POST' && method !== 'PUT') return resolve({});
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });

  try {
    // ── Devices ────────────────────────────────────────────────────────────

    if (url === '/api/devices' && method === 'GET') {
      return json(res, store.getDevices());
    }

    if (url === '/api/devices/discover' && method === 'POST') {
      const saved  = store.getDevices();
      const manual = saved.map((d) => ({ host: d.host, port: d.port }));
      const devs   = await wemo.discoverDevices(8000, manual);
      store.saveDevices(devs);
      return json(res, devs);
    }

    const stateMatch = url.match(/^\/api\/devices\/([^/]+)\/(\d+)\/state$/);
    if (stateMatch) {
      const [, host, port] = stateMatch;
      if (method === 'GET') {
        const on = await wemo.getBinaryState(host, Number(port));
        return json(res, { on });
      }
      if (method === 'POST') {
        await wemo.setBinaryState(host, Number(port), !!body.on);
        return json(res, { ok: true });
      }
    }

    // ── Voice aliases (per-device training) ────────────────────────────────
    //
    // Each device may have a `voiceAliases: string[]` field listing extra
    // names the user has trained.  See voice-commands.js for how these are
    // scored against live speech transcripts.

    const voiceAliasesMatch = url.match(/^\/api\/devices\/([^/]+)\/(\d+)\/voice-aliases$/);
    if (voiceAliasesMatch) {
      const [, host, port] = voiceAliasesMatch;
      const portN = Number(port);

      if (method === 'GET') {
        const dev = store.getDevices().find((d) => d.host === host && Number(d.port) === portN);
        return json(res, dev?.voiceAliases ?? []);
      }
      if (method === 'POST') {
        const alias = String(body.alias || '').trim().toLowerCase();
        if (!alias) return jsonErr(res, 'alias is required', 400);
        const devices = store.getDevices();
        const idx = devices.findIndex((d) => d.host === host && Number(d.port) === portN);
        if (idx === -1) return jsonErr(res, 'device not found', 404);
        const aliases = Array.isArray(devices[idx].voiceAliases) ? devices[idx].voiceAliases.slice() : [];
        if (!aliases.includes(alias)) aliases.push(alias);
        devices[idx] = { ...devices[idx], voiceAliases: aliases };
        store.saveDevices(devices);
        return json(res, aliases);
      }
    }

    const voiceAliasDeleteMatch = url.match(/^\/api\/devices\/([^/]+)\/(\d+)\/voice-aliases\/(\d+)$/);
    if (voiceAliasDeleteMatch && method === 'DELETE') {
      const [, host, port, idxStr] = voiceAliasDeleteMatch;
      const portN = Number(port);
      const aliasIdx = Number(idxStr);
      const devices = store.getDevices();
      const idx = devices.findIndex((d) => d.host === host && Number(d.port) === portN);
      if (idx === -1) return jsonErr(res, 'device not found', 404);
      const aliases = Array.isArray(devices[idx].voiceAliases) ? devices[idx].voiceAliases.slice() : [];
      if (aliasIdx < 0 || aliasIdx >= aliases.length) return jsonErr(res, 'alias index out of range', 400);
      aliases.splice(aliasIdx, 1);
      devices[idx] = { ...devices[idx], voiceAliases: aliases };
      store.saveDevices(devices);
      return json(res, aliases);
    }

    // ── DWM Rules ──────────────────────────────────────────────────────────

    if (url === '/api/dwm-rules') {
      if (method === 'GET')  return json(res, store.getDwmRules());
      if (method === 'POST') {
        const rule = store.createDwmRule(body);
        scheduler.reload();
        return json(res, rule, 201);
      }
    }

    const ruleMatch = url.match(/^\/api\/dwm-rules\/(.+)$/);
    if (ruleMatch) {
      const id = ruleMatch[1];
      if (method === 'PUT') {
        const updated = store.updateDwmRule(id, body);
        scheduler.reload();
        return json(res, updated);
      }
      if (method === 'DELETE') {
        store.deleteDwmRule(id);
        scheduler.reload();
        return json(res, { ok: true });
      }
    }

    // ── Wemo Device Rules ──────────────────────────────────────────────────

    const wemoRulesMatch = url.match(/^\/api\/devices\/([^/]+)\/(\d+)\/rules$/);
    if (wemoRulesMatch && method === 'GET') {
      const [, host, port] = wemoRulesMatch;
      return json(res, await wemo.getRules(host, Number(port)));
    }

    const wemoRuleMatch = url.match(/^\/api\/devices\/([^/]+)\/(\d+)\/rules\/(\d+)$/);
    if (wemoRuleMatch && method === 'PUT') {
      const [, host, port, ruleId] = wemoRuleMatch;
      await wemo.updateRule(host, Number(port), Number(ruleId), body);
      return json(res, { ok: true });
    }

    // ── Scheduler ──────────────────────────────────────────────────────────

    if (url === '/api/scheduler/status' && method === 'GET') {
      return json(res, scheduler.getStatus());
    }

    // ── Static assets ──────────────────────────────────────────────────────

    if (url === '/icon.png' && method === 'GET') {
      const file = path.join(__dirname, 'icon.png');
      fs.readFile(file, (e, data) => {
        if (e) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(data);
      });
      return;
    }

    // Voice-command JS modules — must serve with the correct content-type so
    // the browser parses them as scripts (the index.html fallback below would
    // otherwise return them as HTML).
    if ((url === '/voice-commands.js' || url === '/voice-trainer.js') && method === 'GET') {
      const file = path.join(WEB_DIR, url.slice(1));
      fs.readFile(file, (e, data) => {
        if (e) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, {
          'Content-Type':  'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        });
        res.end(data);
      });
      return;
    }

    // Fallback → serve mobile web UI
    const file = path.join(WEB_DIR, 'index.html');
    fs.readFile(file, (e, data) => {
      if (e) { res.writeHead(404); res.end('Web UI not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });

  } catch (e) {
    jsonErr(res, e.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  // Ensure data directory exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  await scheduler.start();
  console.log(`[DWM] Scheduler started — data: ${DATA_DIR}`);

  const server = http.createServer(handleRequest);

  let WebSocketServer;
  try { WebSocketServer = require('ws').WebSocketServer || require('ws').Server; } catch {}

  if (WebSocketServer) {
    _wss = new WebSocketServer({ server });
    _wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'scheduler-status', data: scheduler.getStatus() }));
    });
    scheduler.onFire   = (event)  => broadcast('scheduler-fired',  event);
    scheduler.onStatus = (status) => broadcast('scheduler-status', status);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[DWM] Web Remote: http://${getLocalIP()}:${PORT}`);
  });

  process.on('SIGTERM', () => { server.close(); process.exit(0); });
  process.on('SIGINT',  () => { server.close(); process.exit(0); });
}

main().catch((e) => { console.error('[DWM] Fatal:', e); process.exit(1); });
