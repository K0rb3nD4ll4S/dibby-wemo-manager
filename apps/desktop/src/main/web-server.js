'use strict';

const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

const WEB_PORT_BASE = 3456;

let _server     = null;
let _wss        = null;
let _scheduler  = null;
let _activePort = WEB_PORT_BASE;
let _ready      = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function err(res, msg, status = 500) {
  json(res, { error: msg }, status);
}

function broadcast(type, data) {
  if (!_wss) return;
  const msg = JSON.stringify({ type, data });
  for (const client of _wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(msg);
  }
}

// ── Static file serving ───────────────────────────────────────────────────────

function getWebDir() {
  try {
    const { app } = require('electron');
    return app.isPackaged
      ? path.join(process.resourcesPath, 'web')
      : path.join(__dirname, '..', '..', 'resources', 'web');
  } catch {
    return path.join(__dirname, '..', '..', 'resources', 'web');
  }
}

function getResourcesDir() {
  try {
    const { app } = require('electron');
    return app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, '..', '..', 'resources');
  } catch {
    return path.join(__dirname, '..', '..', 'resources');
  }
}

function serveResourceFile(res, filename) {
  const file = path.join(getResourcesDir(), filename);
  fs.readFile(file, (readErr, data) => {
    if (readErr) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
}

function serveStatic(req, res) {
  const webDir = getWebDir();
  const file   = path.join(webDir, 'index.html');
  fs.readFile(file, (readErr, data) => {
    if (readErr) {
      res.writeHead(404); res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    }
  });
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleRequest(req, res, store, wemo) {
  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Parse JSON body for POST/PUT
  const body = await new Promise((resolve) => {
    if (method !== 'POST' && method !== 'PUT') return resolve({});
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });

  try {
    // ── Devices ────────────────────────────────────────────────────────────

    if (url === '/api/devices' && method === 'GET') {
      return json(res, store.getDevices());
    }

    if (url === '/api/devices/discover' && method === 'POST') {
      const saved   = store.getDevices();
      const manual  = saved.map((d) => ({ host: d.host, port: d.port }));
      const devices = await wemo.discoverDevices(8000, manual);
      store.saveDevices(devices);
      return json(res, devices);
    }

    // GET /api/devices/:host/:port/state
    const stateMatch = url.match(/^\/api\/devices\/([^/]+)\/(\d+)\/state$/);
    if (stateMatch) {
      const [, host, port] = stateMatch;
      if (method === 'GET') {
        const on = await wemo.getBinaryState(host, Number(port));
        return json(res, { on });
      }
      if (method === 'POST') {
        const { on } = body;
        await wemo.setBinaryState(host, Number(port), !!on);
        return json(res, { ok: true });
      }
    }

    // ── DWM Rules ──────────────────────────────────────────────────────────

    if (url === '/api/dwm-rules') {
      if (method === 'GET')  return json(res, store.getDwmRules());
      if (method === 'POST') {
        const rule = store.createDwmRule(body);
        _scheduler?.reload?.();
        return json(res, rule, 201);
      }
    }

    // PUT /api/dwm-rules/:id   DELETE /api/dwm-rules/:id
    const ruleMatch = url.match(/^\/api\/dwm-rules\/(.+)$/);
    if (ruleMatch) {
      const id = ruleMatch[1];
      if (method === 'PUT') {
        const updated = store.updateDwmRule(id, body);
        _scheduler?.reload?.();
        return json(res, updated);
      }
      if (method === 'DELETE') {
        store.deleteDwmRule(id);
        _scheduler?.reload?.();
        return json(res, { ok: true });
      }
    }

    // ── Wemo Device Rules ──────────────────────────────────────────────────

    // GET /api/devices/:host/:port/rules
    const wemoRulesMatch = url.match(/^\/api\/devices\/([^/]+)\/(\d+)\/rules$/);
    if (wemoRulesMatch && method === 'GET') {
      const [, host, port] = wemoRulesMatch;
      const rules = await wemo.getRules(host, Number(port));
      return json(res, rules);
    }

    // PUT /api/devices/:host/:port/rules/:ruleId
    const wemoRuleMatch = url.match(/^\/api\/devices\/([^/]+)\/(\d+)\/rules\/(\d+)$/);
    if (wemoRuleMatch && method === 'PUT') {
      const [, host, port, ruleId] = wemoRuleMatch;
      await wemo.updateRule(host, Number(port), Number(ruleId), body);
      return json(res, { ok: true });
    }

    // ── Scheduler ──────────────────────────────────────────────────────────

    if (url === '/api/scheduler/status' && method === 'GET') {
      const status = _scheduler?.getStatus?.() ?? { running: false, entries: [] };
      return json(res, status);
    }

    // ── QR code page ───────────────────────────────────────────────────────

    if (url === '/qr' && method === 'GET') {
      let qrcode;
      try { qrcode = require('qrcode'); } catch { return err(res, 'qrcode package not installed', 503); }
      const remoteURL = getURL();
      const svgStr = await qrcode.toString(remoteURL, { type: 'svg', margin: 1, width: 260 });
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DWM Web Remote — QR Code</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:#0d1b27;color:#e2eaf2;display:flex;flex-direction:column;
       align-items:center;justify-content:center;min-height:100vh;padding:24px;gap:16px;margin:0}
  .qr-wrap{background:#fff;border-radius:16px;padding:16px;display:inline-block}
  .qr-wrap svg{display:block}
  h2{font-size:18px;font-weight:700;margin:0;text-align:center}
  .url{font-size:13px;color:#7fa8c8;word-break:break-all;text-align:center;max-width:280px}
  .hint{font-size:12px;color:#546878;text-align:center}
</style></head><body>
<h2>📱 DWM Web Remote</h2>
<div class="qr-wrap">${svgStr}</div>
<div class="url">${remoteURL}</div>
<div class="hint">Scan with your phone camera to open the remote control</div>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    // ── Help & About pages ─────────────────────────────────────────────────

    if (url === '/help'     && method === 'GET') return serveResourceFile(res, 'help.html');
    if (url === '/about'    && method === 'GET') return serveResourceFile(res, 'about.html');
    if (url === '/icon.png' && method === 'GET') {
      const file = path.join(getResourcesDir(), 'icon.png');
      fs.readFile(file, (readErr, data) => {
        if (readErr) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(data);
      });
      return;
    }

    // ── Fallback → serve web UI ────────────────────────────────────────────

    serveStatic(req, res);

  } catch (e) {
    err(res, e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function start(scheduler, store, wemo) {
  if (_server) return getLocalIP();

  _scheduler = scheduler;

  // HTTP server
  _server = http.createServer((req, res) => handleRequest(req, res, store, wemo));

  // WebSocket — attach to same HTTP server
  let WebSocketServer;
  try {
    WebSocketServer = require('ws').WebSocketServer || require('ws').Server;
  } catch {
    WebSocketServer = null;
  }

  if (WebSocketServer) {
    _wss = new WebSocketServer({ server: _server });
    _wss.on('connection', (ws) => {
      const status = _scheduler?.getStatus?.() ?? { running: false };
      ws.send(JSON.stringify({ type: 'scheduler-status', data: status }));
    });
  }

  // Wire scheduler events → WebSocket broadcast
  if (scheduler) {
    scheduler.onFire   = (event)  => broadcast('scheduler-fired',  event);
    scheduler.onStatus = (status) => broadcast('scheduler-status', status);
  }

  // Try ports WEB_PORT_BASE … WEB_PORT_BASE+9, skip any that are in use
  _server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && _activePort < WEB_PORT_BASE + 9) {
      _activePort++;
      _server.listen(_activePort, '0.0.0.0');
    } else {
      console.error(`[DWM Web Remote] Could not bind to any port (last tried ${_activePort}):`, e.message);
      _server = null;
      _wss    = null;
    }
  });

  _ready = false;
  _activePort = WEB_PORT_BASE;
  _server.listen(_activePort, '0.0.0.0', () => {
    _ready = true;
    console.log(`[DWM Web Remote] http://${getLocalIP()}:${_activePort}`);
  });

  return getLocalIP();
}

function stop() {
  _wss?.close?.();
  _server?.close?.();
  _server = null;
  _wss    = null;
}

function getURL() {
  return _ready ? `http://${getLocalIP()}:${_activePort}` : `http://${getLocalIP()}:${WEB_PORT_BASE}`;
}

function isReady() { return _ready; }

module.exports = { start, stop, getURL, isReady, WEB_PORT: WEB_PORT_BASE };
