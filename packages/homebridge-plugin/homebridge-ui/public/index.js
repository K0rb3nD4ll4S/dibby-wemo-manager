/* Dibby Wemo Manager — Homebridge custom UI */
/* global homebridge */
'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _devices        = [];
let _dwmRules       = [];
let _wemoRules      = null;       // { rules, ruleDevices, targets } for selected device
let _editingDwmId   = null;       // null = create, string = update
let _selectedDwmDays = new Set();
let _pendingLocation = null;      // { lat, lng, label }
let _todaySunTimes  = null;       // { sunrise, sunset } seconds from midnight

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Display seconds as 12-hour time: "8:30 AM" / "11:00 PM"
function secsToHHMM(secs) {
  if (secs == null || secs < 0) return '';
  const totalMins = Math.floor(secs / 60);
  let h = Math.floor(totalMins / 60) % 24;
  const m = totalMins % 60;
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;          // 0 → 12, 13 → 1, etc.
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Accept "8:30 AM", "8:30AM", "08:30 am", "8:30" (24-hr fallback), "8 AM"
function hhmmToSecs(str) {
  if (!str) return -1;
  str = str.trim().toUpperCase();
  const match = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!match) return -1;
  let h = parseInt(match[1], 10);
  const m = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3];
  if (isNaN(h) || isNaN(m) || m > 59) return -1;
  if (period) {
    // 12-hour mode
    if (h < 1 || h > 12) return -1;
    if (period === 'AM') h = h === 12 ? 0 : h;
    else                 h = h === 12 ? 12 : h + 12;
  } else {
    // 24-hour fallback
    if (h > 23) return -1;
  }
  return h * 3600 + m * 60;
}

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Belkin firmware DayID encoding (from the official WeMo Android app):
//   0=Daily, 1=Sun, 2=Mon, 3=Tue, 4=Wed, 5=Thu, 6=Fri, 7=Sat,
//   8=Weekdays (one row covers Mon-Fri), 9=Weekends (one row covers Sat-Sun).
// Translate to Dibby internal day numbers (1=Mon..7=Sun) so display + DWM copy
// match the user's expectation regardless of which app created the rule.
const BELKIN_TO_DIBBY = {
  0: [1, 2, 3, 4, 5, 6, 7],
  1: [7], 2: [1], 3: [2], 4: [3], 5: [4], 6: [5], 7: [6],
  8: [1, 2, 3, 4, 5],
  9: [6, 7],
};
function deviceDaysToDibby(rawDayId) {
  return BELKIN_TO_DIBBY[Number(rawDayId)] || [];
}

function dayLabel(dayIds) {
  if (!dayIds?.length) return '—';
  if (dayIds.length === 7) return 'Every day';
  return dayIds.map((d) => DAY_NAMES[d] ?? d).join(', ');
}

function showStatus(containerId, msg, type = 'info') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = msg
    ? `<div class="alert alert-${type}">${msg}</div>`
    : '';
}

function spinner() { return '<span class="spin"></span>'; }

// ---------------------------------------------------------------------------
// Devices tab
// ---------------------------------------------------------------------------

async function loadDevices() {
  showStatus('devices-status', spinner() + ' Loading…', 'info');
  try {
    _devices = await homebridge.request('/devices/list');
    renderDevices();
    showStatus('devices-status', '');
  } catch (e) {
    showStatus('devices-status', 'Failed to load devices: ' + e.message, 'error');
  }
}

async function discoverDevices() {
  const btn      = document.getElementById('btn-discover');
  const timeoutEl = document.getElementById('discover-timeout');
  // Honour the user-selected timeout from the dropdown (10 / 20 / 30 / 45 / 60 s)
  // — falls back to 30 s if the element is missing for any reason.
  const timeoutMs = Math.max(3000, Math.min(60000, parseInt(timeoutEl?.value, 10) || 30000));
  btn.disabled = true;
  if (timeoutEl) timeoutEl.disabled = true;
  showStatus('devices-status', spinner() + ` Scanning for devices (up to ${Math.round(timeoutMs / 1000)} s)…`, 'info');
  try {
    _devices = await homebridge.request('/devices/discover', { timeout: timeoutMs });
    renderDevices();
    showStatus('devices-status', `Found ${_devices.length} device(s)`, 'success');
    refreshWemoDeviceSelect();
  } catch (e) {
    showStatus('devices-status', 'Discovery failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    if (timeoutEl) timeoutEl.disabled = false;
  }
}

// Manual add — accepts a single IP[:port], probes /setup.xml on the server
// side, and merges the result into the cached device list.  Useful when SSDP
// can't reach the target (VLAN isolation, Docker bridge, hostile router).
async function addManualDevice() {
  const ipEl   = document.getElementById('manual-ip');
  const portEl = document.getElementById('manual-port');
  const btn    = document.getElementById('btn-add-manual');

  const host = (ipEl?.value || '').trim();
  const port = parseInt(portEl?.value, 10) || 49153;

  // Crude but adequate IPv4 sanity check; the server probe will reject any
  // address that isn't actually a Wemo, so we just guard against the empty
  // / clearly-malformed cases here.
  if (!/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(host)) {
    showStatus('devices-status', 'Enter a valid IPv4 address (e.g. 192.168.1.42).', 'error');
    return;
  }

  btn.disabled = true;
  showStatus('devices-status', spinner() + ` Probing ${host}:${port}…`, 'info');
  try {
    const result = await homebridge.request('/devices/addManual', { host, port });
    _devices = result.devices;
    renderDevices();
    refreshWemoDeviceSelect();
    if (result.added) {
      showStatus('devices-status', `Added ${esc(result.added.friendlyName || host)} (${esc(result.added.productModel || 'Wemo')}).`, 'success');
      if (ipEl) ipEl.value = '';
    } else {
      showStatus('devices-status', `Already known: ${esc(result.existing?.friendlyName || host)}`, 'info');
    }
  } catch (e) {
    showStatus('devices-status', `Could not add ${host}:${port} — ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderDevices() {
  const el = document.getElementById('devices-list');
  if (!_devices.length) {
    el.innerHTML = '<div class="empty">No devices found. Click Discover to scan your network.</div>';
    return;
  }
  el.innerHTML = _devices.map((d, i) => `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${esc(d.friendlyName ?? d.host)}</div>
          <div class="card-subtitle">${esc(d.host)}:${d.port} — ${esc(d.productModel ?? 'Wemo Device')}</div>
        </div>
        <div class="toggle-wrap">
          <span id="dev-state-label-${i}" style="font-size:0.82rem;color:var(--muted)">…</span>
          <label class="toggle">
            <input type="checkbox" id="dev-toggle-${i}" onchange="setDeviceState(${i},this.checked)" />
            <span class="slider"></span>
          </label>
        </div>
      </div>
    </div>
  `).join('');

  // Fetch state for each device
  _devices.forEach((d, i) => fetchDeviceState(i, d));
}

async function fetchDeviceState(idx, device) {
  try {
    const on = await homebridge.request('/devices/state', { host: device.host, port: device.port });
    const toggle = document.getElementById(`dev-toggle-${idx}`);
    const label  = document.getElementById(`dev-state-label-${idx}`);
    if (toggle) toggle.checked = !!on;
    if (label)  label.textContent = on ? 'ON' : 'OFF';
  } catch { /* device unreachable */ }
}

async function setDeviceState(idx, on) {
  const d = _devices[idx];
  if (!d) return;
  const label = document.getElementById(`dev-state-label-${idx}`);
  if (label) label.textContent = on ? 'ON' : 'OFF';
  try {
    await homebridge.request('/devices/setState', { host: d.host, port: d.port, on });
  } catch (e) {
    showStatus('devices-status', `Failed to set ${d.friendlyName}: ${e.message}`, 'error');
    // Revert toggle
    const toggle = document.getElementById(`dev-toggle-${idx}`);
    if (toggle) toggle.checked = !on;
    if (label)  label.textContent = !on ? 'ON' : 'OFF';
  }
}

document.getElementById('btn-discover').addEventListener('click', discoverDevices);
document.getElementById('btn-add-manual')?.addEventListener('click', addManualDevice);
document.getElementById('manual-ip')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addManualDevice(); }
});

// ---------------------------------------------------------------------------
// DWM Rules tab
// ---------------------------------------------------------------------------

async function loadDwmRules() {
  try {
    _dwmRules = await homebridge.request('/rules/list');
    renderDwmRules();
  } catch (e) {
    showStatus('dwm-rules-status', 'Failed to load rules: ' + e.message, 'error');
  }
}

function dwmRuleSummary(r) {
  if (r.type === 'AlwaysOn') {
    const devs = (r.targetDevices ?? []).map((td) => esc(td.name ?? td.host)).join(', ') || 'no targets';
    return `🔒 Enforced ON every 10 s · ${devs}`;
  }
  if (r.type === 'Trigger') {
    const src    = esc(r.triggerDevice?.name ?? r.triggerDevice?.host ?? '?');
    const when   = r.triggerEvent === 'on' ? 'ON' : r.triggerEvent === 'off' ? 'OFF' : 'ON/OFF';
    const action = r.action === 'mirror' ? 'mirror' : r.action === 'opposite' ? 'opposite' : (r.action ?? 'on').toUpperCase();
    const targets = (r.actionDevices ?? []).map((td) => esc(td.name ?? td.host)).join(', ') || '—';
    return `⚡ If ${src} → ${when}, then ${action} (${targets})`;
  }
  if (r.type === 'Countdown') {
    const mins = r.countdownTime ? Math.round(r.countdownTime / 60) : null;
    const cond = r.countdownAction === 'off_to_on' ? 'OFF→ON' : 'ON→OFF';
    const win  = (r.windowStart >= 0 && r.windowEnd >= 0)
      ? ` · ${secsToHHMM(r.windowStart)}–${secsToHHMM(r.windowEnd)}`
      : (r.windowStart >= 0 ? ` · from ${secsToHHMM(r.windowStart)}` : '');
    return mins ? `⏱ ${mins} min · ${cond}${win}` : '—';
  }
  const days = dayLabel(r.days);
  const devs = (r.targetDevices ?? []).map((td) => esc(td.name ?? td.host)).join(', ') || 'no targets';
  const start = secsToHHMM(r.startTime) || '—';
  const end   = r.endTime > 0 ? ' – ' + secsToHHMM(r.endTime) : '';
  return `${days} · ${start}${end} · ${devs}`;
}

function renderDwmRules() {
  const el = document.getElementById('dwm-rules-list');
  if (!_dwmRules.length) {
    el.innerHTML = '<div class="empty">No DWM rules yet. Click "+ Add Rule" to create one.</div>';
    return;
  }
  const typeIcon = { Schedule: '📅', Away: '🏠', Countdown: '⏱', AlwaysOn: '🔒', Trigger: '⚡' };
  el.innerHTML = _dwmRules.map((r) => `
    <div class="card" data-rule-id="${r.id}">
      <div class="card-header">
        <div>
          <div class="card-title">
            ${typeIcon[r.type] || '📅'} ${esc(r.name)}
            <span class="chip ${r.enabled ? 'chip-on' : 'chip-dis'}">${r.enabled ? 'enabled' : 'disabled'}</span>
            <span class="chip chip-off">${esc(r.type)}</span>
          </div>
          <div class="card-subtitle">${dwmRuleSummary(r)}</div>
        </div>
        <div class="flex-row">
          <label class="toggle" title="${r.enabled ? 'Disable' : 'Enable'} rule">
            <input type="checkbox" class="dwm-toggle" data-id="${r.id}" ${r.enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
          <button class="btn btn-ghost btn-sm dwm-edit-btn" data-id="${r.id}">Edit</button>
          <button class="btn btn-danger btn-sm dwm-delete-btn" data-id="${r.id}">Delete</button>
        </div>
      </div>
    </div>
  `).join('');

  el.querySelectorAll('.dwm-toggle').forEach((cb) => {
    cb.addEventListener('change', function () { toggleDwmRule(this.dataset.id, this.checked); });
  });
  el.querySelectorAll('.dwm-edit-btn').forEach((btn) => {
    btn.addEventListener('click', function () { openDwmEdit(this.dataset.id); });
  });
  el.querySelectorAll('.dwm-delete-btn').forEach((btn) => {
    btn.addEventListener('click', function () { deleteDwmRule(this.dataset.id); });
  });
}

async function toggleDwmRule(id, enabled) {
  try {
    await homebridge.request('/rules/update', { id, updates: { enabled } });
    await loadDwmRules();
  } catch (e) {
    showStatus('dwm-rules-status', 'Toggle failed: ' + e.message, 'error');
    await loadDwmRules();
  }
}

function deleteDwmRule(id) {
  // confirm() is blocked in cross-origin iframes — use inline confirm row instead
  const card = document.querySelector(`[data-rule-id="${id}"]`);
  if (!card) return;

  // If already showing confirm, execute delete
  const existing = card.querySelector('.delete-confirm-row');
  if (existing) {
    existing.remove();
    homebridge.request('/rules/delete', { id })
      .then(() => loadDwmRules())
      .catch((e) => showStatus('dwm-rules-status', 'Delete failed: ' + e.message, 'error'));
    return;
  }

  // Show inline confirm bar (no inline onclick — use addEventListener)
  const row = document.createElement('div');
  row.className = 'delete-confirm-row';
  row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 10px;background:rgba(239,68,68,.12);border-radius:6px;font-size:0.8rem';

  const msg = document.createElement('span');
  msg.style.cssText = 'color:#fca5a5;flex:1';
  msg.textContent = 'Delete this rule?';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-danger btn-sm';
  confirmBtn.textContent = 'Yes, delete';
  confirmBtn.addEventListener('click', () => deleteDwmRule(id));

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost btn-sm';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => row.remove());

  row.appendChild(msg);
  row.appendChild(confirmBtn);
  row.appendChild(cancelBtn);
  card.appendChild(row);

  // Auto-dismiss after 5 seconds
  setTimeout(() => { if (row.isConnected) row.remove(); }, 5000);
}

// ── Export ────────────────────────────────────────────────────────────────────

document.getElementById('btn-export-dwm').addEventListener('click', async () => {
  try {
    const rules = await homebridge.request('/rules/export');
    if (!rules || !rules.length) { showStatus('dwm-rules-status', 'No rules to export.', 'warn'); return; }
    const blob = new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href     = url;
    a.download = `dwm-rules-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus('dwm-rules-status', `Exported ${rules.length} rule${rules.length !== 1 ? 's' : ''}.`, 'success');
  } catch (e) {
    showStatus('dwm-rules-status', 'Export failed: ' + e.message, 'error');
  }
});

// ── Import ────────────────────────────────────────────────────────────────────

let _importRules = [];   // parsed rules waiting for confirmation

document.getElementById('btn-import-dwm').addEventListener('click', () => {
  document.getElementById('dwm-import-file').value = '';   // reset so same file can be re-selected
  document.getElementById('dwm-import-file').click();
});

document.getElementById('dwm-import-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      const rules  = Array.isArray(parsed) ? parsed : parsed.rules ?? [];
      if (!rules.length) throw new Error('No rules found in file');

      _importRules = rules;
      document.getElementById('dwm-import-title').textContent =
        `Import ${rules.length} rule${rules.length !== 1 ? 's' : ''} from "${file.name}"`;

      // Build preview list
      const listEl = document.getElementById('dwm-import-list');
      listEl.innerHTML = rules.map((r) =>
        `<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.06)">` +
        `<span style="color:#e2e8f0">${esc(r.name ?? '(unnamed)')}</span> ` +
        `<span style="color:#6b7280;font-size:0.75rem">${esc(r.type ?? '')}</span></div>`
      ).join('');

      document.getElementById('dwm-import-status').textContent = '';
      document.getElementById('dwm-import-panel').style.display = '';
      document.getElementById('btn-import-confirm').disabled = false;
    } catch (err) {
      showStatus('dwm-rules-status', 'Import failed: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
});

document.getElementById('btn-import-cancel').addEventListener('click', () => {
  document.getElementById('dwm-import-panel').style.display = 'none';
  _importRules = [];
});

document.getElementById('btn-import-confirm').addEventListener('click', async () => {
  if (!_importRules.length) return;
  const mode    = document.querySelector('input[name="dwm-import-mode"]:checked')?.value ?? 'merge';
  const statusEl = document.getElementById('dwm-import-status');
  const btn      = document.getElementById('btn-import-confirm');
  btn.disabled   = true;
  statusEl.style.color = '#9ca3af';
  statusEl.textContent = 'Importing…';
  try {
    const res = await homebridge.request('/rules/import', { rules: _importRules, mode });
    document.getElementById('dwm-import-panel').style.display = 'none';
    _importRules = [];
    await loadDwmRules();
    const msg = mode === 'replace'
      ? `Replaced all rules — imported ${res.imported}.`
      : `Imported ${res.imported} rule${res.imported !== 1 ? 's' : ''}${res.skipped ? `, skipped ${res.skipped} (name already exists)` : ''}.`;
    showStatus('dwm-rules-status', msg, 'success');
  } catch (e) {
    btn.disabled = false;
    statusEl.style.color = '#fca5a5';
    statusEl.textContent = 'Import failed: ' + e.message;
  }
});

// ── Sun-time helpers ─────────────────────────────────────────────────────────

function secsToAmPm(secs) {
  if (secs == null || secs < 0) return '—';
  const h24 = Math.floor(secs / 3600) % 24;
  const m   = Math.floor((secs % 3600) / 60);
  const ap  = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

function updateSunTypeVisibility() {
  for (const side of ['start', 'end']) {
    const type    = document.getElementById(`dwm-${side}-type`)?.value ?? 'fixed';
    const isSun   = type === 'sunrise' || type === 'sunset';
    document.getElementById(`dwm-${side}-fixed`).style.display = isSun ? 'none' : '';
    document.getElementById(`dwm-${side}-sun`).style.display   = isSun ? ''     : 'none';
    updateSunPreview(side);
  }
}

function updateSunPreview(side) {
  const previewEl = document.getElementById(`dwm-${side}-preview`);
  if (!previewEl) return;
  const type   = document.getElementById(`dwm-${side}-type`)?.value;
  const offset = parseInt(document.getElementById(`dwm-${side}-offset`)?.value ?? '0', 10) || 0;
  if (!_todaySunTimes || (type !== 'sunrise' && type !== 'sunset')) { previewEl.textContent = ''; return; }
  const baseSecs = type === 'sunrise' ? _todaySunTimes.sunrise : _todaySunTimes.sunset;
  if (baseSecs == null) { previewEl.textContent = 'No sun data for location'; return; }
  const fireSecs = baseSecs + offset * 60;
  const baseStr  = secsToAmPm(baseSecs);
  const fireStr  = secsToAmPm(fireSecs);
  const offStr   = offset !== 0 ? ` (${offset > 0 ? '+' : ''}${offset} min)` : '';
  previewEl.textContent = `Today's ${type}: ${baseStr} → fires ${fireStr}${offStr}`;
}

// Wire up type dropdowns and offset inputs for live preview
['start', 'end'].forEach((side) => {
  document.getElementById(`dwm-${side}-type`)?.addEventListener('change', updateSunTypeVisibility);
  document.getElementById(`dwm-${side}-offset`)?.addEventListener('input', () => updateSunPreview(side));
});

document.getElementById('btn-add-dwm').addEventListener('click', () => openDwmEdit(null));

document.getElementById('btn-dwm-delete-all').addEventListener('click', () => {
  if (!_dwmRules.length) return;
  const row = document.getElementById('dwm-delete-all-confirm');
  row.style.display = row.style.display === 'none' ? '' : 'none';
});

document.getElementById('dwm-delete-all-yes').addEventListener('click', async () => {
  document.getElementById('dwm-delete-all-confirm').style.display = 'none';
  try {
    await homebridge.request('/rules/delete-all');
    await loadDwmRules();
    showStatus('dwm-rules-status', 'All DWM rules deleted.', 'success');
  } catch (e) {
    showStatus('dwm-rules-status', 'Delete all failed: ' + e.message, 'error');
  }
});

document.getElementById('dwm-delete-all-no').addEventListener('click', () => {
  document.getElementById('dwm-delete-all-confirm').style.display = 'none';
});

// ── DWM Inline Form ───────────────────────────────────────────────────────────

function openDwmEdit(id) {
  _editingDwmId    = id;
  _selectedDwmDays = new Set();
  document.getElementById('dwm-form-error').style.display = 'none';
  document.getElementById('dwm-form-title').textContent = id ? 'Edit DWM Rule' : 'Add DWM Rule';

  const devOptions = _devices.map((d) =>
    `<option value="${esc(d.host)}:${d.port}">${esc(d.friendlyName ?? d.host)}</option>`
  ).join('');

  // Populate all device selects
  document.getElementById('dwm-target-devices').innerHTML  = devOptions;
  document.getElementById('dwm-trigger-src').innerHTML     = '<option value="">— select device —</option>' + devOptions;
  document.getElementById('dwm-trigger-targets').innerHTML = devOptions;

  if (id) {
    const r = _dwmRules.find((x) => x.id === id);
    if (!r) return;
    document.getElementById('dwm-name').value       = r.name ?? '';
    document.getElementById('dwm-type').value       = r.type ?? 'Schedule';
    document.getElementById('dwm-enabled').checked  = r.enabled !== false;
    document.getElementById('dwm-start-type').value   = r.startType   || 'fixed';
    document.getElementById('dwm-start-offset').value = String(r.startOffset ?? 0);
    document.getElementById('dwm-start-time').value   = (r.startType === 'fixed' && r.startTime >= 0) ? secsToHHMM(r.startTime) : '';
    document.getElementById('dwm-end-type').value     = r.endType     || 'fixed';
    document.getElementById('dwm-end-offset').value   = String(r.endOffset   ?? 0);
    document.getElementById('dwm-end-time').value     = (r.endType === 'fixed' && r.endTime > 0) ? secsToHHMM(r.endTime) : '';
    document.getElementById('dwm-start-action').value = String(r.startAction ?? 1);
    document.getElementById('dwm-end-action').value   = String(r.endAction   ?? -1);
    document.getElementById('dwm-countdown-mins').value =
      r.countdownTime ? String(Math.round(r.countdownTime / 60)) : '';
    document.getElementById('dwm-countdown-action').value       = r.countdownAction ?? 'on_to_off';
    document.getElementById('dwm-countdown-window-start').value = r.windowStart >= 0 ? secsToHHMM(r.windowStart) : '';
    document.getElementById('dwm-countdown-window-end').value   = r.windowEnd   >= 0 ? secsToHHMM(r.windowEnd)   : '';

    _selectedDwmDays = new Set((r.days ?? []).map(Number));

    // Select target devices
    const targets = (r.targetDevices ?? []).map((td) => `${td.host}:${td.port}`);
    Array.from(document.getElementById('dwm-target-devices').options).forEach((opt) => {
      opt.selected = targets.includes(opt.value);
    });

    // Trigger-specific
    if (r.type === 'Trigger') {
      const srcKey = r.triggerDevice ? `${r.triggerDevice.host}:${r.triggerDevice.port}` : '';
      document.getElementById('dwm-trigger-src').value    = srcKey;
      document.getElementById('dwm-trigger-event').value  = r.triggerEvent  ?? 'any';
      document.getElementById('dwm-trigger-action').value = r.action         ?? 'on';
      const actKeys = (r.actionDevices ?? []).map((td) => `${td.host}:${td.port}`);
      Array.from(document.getElementById('dwm-trigger-targets').options).forEach((opt) => {
        opt.selected = actKeys.includes(opt.value);
      });
    }
  } else {
    document.getElementById('dwm-name').value         = '';
    document.getElementById('dwm-type').value         = 'Schedule';
    document.getElementById('dwm-enabled').checked    = true;
    document.getElementById('dwm-start-type').value   = 'fixed';
    document.getElementById('dwm-start-offset').value = '0';
    document.getElementById('dwm-start-time').value   = '';
    document.getElementById('dwm-end-type').value     = 'fixed';
    document.getElementById('dwm-end-offset').value   = '0';
    document.getElementById('dwm-end-time').value     = '';
    document.getElementById('dwm-start-action').value = '1';
    document.getElementById('dwm-end-action').value   = '-1';
    document.getElementById('dwm-countdown-mins').value          = '';
    document.getElementById('dwm-countdown-action').value        = 'on_to_off';
    document.getElementById('dwm-countdown-window-start').value  = '';
    document.getElementById('dwm-countdown-window-end').value    = '';
    document.getElementById('dwm-trigger-src').value       = '';
    document.getElementById('dwm-trigger-event').value  = 'any';
    document.getElementById('dwm-trigger-action').value = 'on';
    Array.from(document.getElementById('dwm-target-devices').options).forEach((opt) => { opt.selected = false; });
    Array.from(document.getElementById('dwm-trigger-targets').options).forEach((opt) => { opt.selected = false; });
  }

  updateDwmDayButtons();
  updateDwmTypeFields();
  updateSunTypeVisibility();
  document.getElementById('dwm-list-view').style.display  = 'none';
  document.getElementById('dwm-form-panel').style.display = '';
  window.scrollTo(0, 0);
}

function updateDwmDayButtons() {
  document.querySelectorAll('#dwm-days .day-btn').forEach((btn) => {
    const d = Number(btn.dataset.day);
    btn.classList.toggle('selected', _selectedDwmDays.has(d));
  });
}

function updateDwmTypeFields() {
  const type        = document.getElementById('dwm-type').value;
  const isSchedule  = type === 'Schedule' || type === 'Away';
  const isCountdown = type === 'Countdown';
  const isAlwaysOn  = type === 'AlwaysOn';
  const isTrigger   = type === 'Trigger';
  const isTimeBased = isSchedule || isCountdown;

  document.getElementById('dwm-target-group').style.display     = isTrigger ? 'none' : '';
  document.getElementById('dwm-days-group').style.display        = isTrigger || isAlwaysOn ? 'none' : '';
  document.getElementById('dwm-schedule-fields').style.display   = isCountdown || isTrigger || isAlwaysOn ? 'none' : '';
  document.getElementById('dwm-countdown-fields').style.display  = isCountdown ? '' : 'none';
  document.getElementById('dwm-trigger-fields').style.display    = isTrigger ? '' : 'none';
  document.getElementById('dwm-alwayson-info').style.display     = isAlwaysOn ? '' : 'none';
}

document.querySelectorAll('#dwm-days .day-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const d = Number(btn.dataset.day);
    if (_selectedDwmDays.has(d)) _selectedDwmDays.delete(d);
    else _selectedDwmDays.add(d);
    updateDwmDayButtons();
  });
});

document.getElementById('dwm-type').addEventListener('change', updateDwmTypeFields);

function closeDwmModal() {
  document.getElementById('dwm-form-panel').style.display = 'none';
  document.getElementById('dwm-list-view').style.display  = '';
}

document.getElementById('btn-dwm-form-cancel').addEventListener('click', closeDwmModal);
document.getElementById('dwm-form-cancel-btn').addEventListener('click', closeDwmModal);

document.getElementById('dwm-form-save-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('dwm-form-error');
  errEl.style.display = 'none';

  const name   = document.getElementById('dwm-name').value.trim();
  const type   = document.getElementById('dwm-type').value;
  const enabled = document.getElementById('dwm-enabled').checked;

  if (!name) { showModalError('Rule name is required'); return; }

  const devFromKey = (key) => {
    const [host, port] = key.split(':');
    const dev = _devices.find((d) => d.host === host && String(d.port) === port);
    return { host, port: Number(port), name: dev?.friendlyName ?? host, udn: dev?.udn };
  };

  // ── AlwaysOn ──────────────────────────────────────────────────────────────
  if (type === 'AlwaysOn') {
    const selEl = document.getElementById('dwm-target-devices');
    const selectedDevs = Array.from(selEl.selectedOptions).map((opt) => devFromKey(opt.value));
    if (!selectedDevs.length) { showModalError('Select at least one device to keep on'); return; }
    const rule = { name, type, enabled, targetDevices: selectedDevs };
    try {
      if (_editingDwmId) await homebridge.request('/rules/update', { id: _editingDwmId, updates: rule });
      else               await homebridge.request('/rules/create', rule);
      closeDwmModal();
      await loadDwmRules();
    } catch (e) { showModalError('Save failed: ' + e.message); }
    return;
  }

  // ── Trigger ───────────────────────────────────────────────────────────────
  if (type === 'Trigger') {
    const srcKey = document.getElementById('dwm-trigger-src').value;
    if (!srcKey) { showModalError('Select a trigger (source) device'); return; }
    const actTargets = Array.from(document.getElementById('dwm-trigger-targets').selectedOptions)
      .map((opt) => devFromKey(opt.value));
    if (!actTargets.length) { showModalError('Select at least one action device'); return; }
    const rule = {
      name, type, enabled,
      triggerDevice: devFromKey(srcKey),
      triggerEvent:  document.getElementById('dwm-trigger-event').value,
      action:        document.getElementById('dwm-trigger-action').value,
      actionDevices: actTargets,
    };
    try {
      if (_editingDwmId) await homebridge.request('/rules/update', { id: _editingDwmId, updates: rule });
      else               await homebridge.request('/rules/create', rule);
      closeDwmModal();
      await loadDwmRules();
    } catch (e) { showModalError('Save failed: ' + e.message); }
    return;
  }

  // ── Schedule / Countdown / Away ───────────────────────────────────────────
  if (_selectedDwmDays.size === 0 && type !== 'Countdown') {
    showModalError('Select at least one day'); return;
  }

  const selEl = document.getElementById('dwm-target-devices');
  const selectedDevs = Array.from(selEl.selectedOptions).map((opt) => devFromKey(opt.value));
  if (!selectedDevs.length) { showModalError('Select at least one target device'); return; }

  const rule = {
    name, type, enabled,
    days:          Array.from(_selectedDwmDays).sort(),
    targetDevices: selectedDevs,
  };

  if (type === 'Countdown') {
    const mins = Number(document.getElementById('dwm-countdown-mins').value);
    if (!mins || mins < 1) { showModalError('Enter countdown duration in minutes'); return; }
    rule.countdownTime    = mins * 60;
    rule.countdownAction  = document.getElementById('dwm-countdown-action').value;
    const winStart = hhmmToSecs(document.getElementById('dwm-countdown-window-start').value);
    const winEnd   = hhmmToSecs(document.getElementById('dwm-countdown-window-end').value);
    rule.windowStart = winStart >= 0 ? winStart : -1;
    rule.windowEnd   = winEnd   >= 0 ? winEnd   : -1;
  } else {
    const startType   = document.getElementById('dwm-start-type').value;
    const startOffset = parseInt(document.getElementById('dwm-start-offset').value ?? '0', 10) || 0;
    const endType     = document.getElementById('dwm-end-type').value;
    const endOffset   = parseInt(document.getElementById('dwm-end-offset').value   ?? '0', 10) || 0;

    let startSecs;
    if (startType === 'sunrise') { startSecs = -2; }
    else if (startType === 'sunset') { startSecs = -3; }
    else {
      startSecs = hhmmToSecs(document.getElementById('dwm-start-time').value);
      if (startSecs < 0) { showModalError('Enter a valid start time (e.g. 8:30 PM)'); return; }
    }

    let endSecs;
    if (endType === 'sunrise') { endSecs = -2; }
    else if (endType === 'sunset') { endSecs = -3; }
    else { endSecs = hhmmToSecs(document.getElementById('dwm-end-time').value); }

    rule.startTime    = startSecs;
    rule.startType    = startType;
    rule.startOffset  = startOffset;
    rule.endTime      = endSecs;
    rule.endType      = endType;
    rule.endOffset    = endOffset;
    rule.startAction  = Number(document.getElementById('dwm-start-action').value);
    rule.endAction    = Number(document.getElementById('dwm-end-action').value);
  }

  try {
    if (_editingDwmId) {
      await homebridge.request('/rules/update', { id: _editingDwmId, updates: rule });
    } else {
      await homebridge.request('/rules/create', rule);
    }
    closeDwmModal();
    await loadDwmRules();
  } catch (e) {
    showModalError('Save failed: ' + e.message);
  }
});

function showModalError(msg) {
  const el = document.getElementById('dwm-form-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ---------------------------------------------------------------------------
// Wemo Device Rules tab
// ---------------------------------------------------------------------------

function refreshWemoDeviceSelect() {
  const sel = document.getElementById('wemo-rules-device-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— choose device —</option>' +
    _devices.map((d) =>
      `<option value="${esc(d.host)}:${d.port}">${esc(d.friendlyName ?? d.host)} (${esc(d.host)})</option>`
    ).join('');
  if (cur) sel.value = cur;
}

document.getElementById('wemo-rules-device-select').addEventListener('change', async function () {
  const val = this.value;
  if (!val) {
    document.getElementById('wemo-rules-list').innerHTML = '';
    document.getElementById('btn-wemo-delete-all').style.display = 'none';
    document.getElementById('btn-wemo-copy-to-dwm').style.display = 'none';
    document.getElementById('wemo-delete-all-confirm').style.display = 'none';
    return;
  }
  const [host, portStr] = val.split(':');
  const port = Number(portStr);

  showStatus('wemo-rules-status', spinner() + ' Fetching rules from device…', 'info');
  document.getElementById('wemo-rules-list').innerHTML = '';

  try {
    _wemoRules = await homebridge.request('/rules/wemo/list', { host, port });
    showStatus('wemo-rules-status', '');
    renderWemoRules(host, port);
  } catch (e) {
    document.getElementById('btn-wemo-delete-all').style.display = 'none';
    document.getElementById('btn-wemo-copy-to-dwm').style.display = 'none';
    if (String(e.message).includes('FetchRules') || String(e.message).includes('rules1')) {
      showStatus('wemo-rules-status',
        '⚠️ This device does not support the Wemo Rules service (e.g. Dimmer V2 with newer firmware).', 'info');
    } else {
      showStatus('wemo-rules-status', 'Failed: ' + e.message, 'error');
    }
  }
});

document.getElementById('btn-wemo-delete-all').addEventListener('click', () => {
  const row = document.getElementById('wemo-delete-all-confirm');
  row.style.display = row.style.display === 'none' ? '' : 'none';
});

document.getElementById('wemo-delete-all-yes').addEventListener('click', async () => {
  document.getElementById('wemo-delete-all-confirm').style.display = 'none';
  const val = document.getElementById('wemo-rules-device-select').value;
  if (!val) return;
  const [host, portStr] = val.split(':');
  const port = Number(portStr);
  await deleteAllWemoRules(host, port);
});

document.getElementById('wemo-delete-all-no').addEventListener('click', () => {
  document.getElementById('wemo-delete-all-confirm').style.display = 'none';
});

document.getElementById('btn-wemo-copy-to-dwm').addEventListener('click', async () => {
  const val = document.getElementById('wemo-rules-device-select').value;
  if (!val) return;
  const [host, portStr] = val.split(':');
  const port = Number(portStr);
  await copyWemoRulesToDwm(host, port);
});

function renderWemoRules(host, port) {
  const el = document.getElementById('wemo-rules-list');

  const hasRules = _wemoRules?.rules?.length;
  document.getElementById('btn-wemo-delete-all').style.display = hasRules ? '' : 'none';
  document.getElementById('btn-wemo-copy-to-dwm').style.display = hasRules ? '' : 'none';

  if (!hasRules) {
    el.innerHTML = '<div class="empty">No on-device rules found.</div>';
    return;
  }

  el.innerHTML = _wemoRules.rules.map((r) => {
    const devices = (_wemoRules.ruleDevices ?? []).filter((rd) => String(rd.RuleID) === String(r.RuleID));
    const enabled = String(r.State) === '1';
    const dibbyDays = [...new Set(devices.flatMap((d) => deviceDaysToDibby(d.DayID)))].sort((a, b) => a - b);
    const dayList   = dibbyDays.length ? dibbyDays.map((d) => DAY_NAMES[d]).join(', ') : '—';
    const startTime = devices[0]?.StartTime >= 0 ? secsToHHMM(devices[0].StartTime) : '—';

    return `<div class="card" data-wemo-rule-id="${r.RuleID}">
      <div class="card-header">
        <div>
          <div class="card-title">
            ${esc(r.Name)}
            <span class="chip ${enabled ? 'chip-on' : 'chip-dis'}">${enabled ? 'enabled' : 'disabled'}</span>
            <span class="chip chip-off">${esc(r.Type)}</span>
          </div>
          <div class="card-subtitle">${dayList} · ${startTime}</div>
        </div>
        <div class="flex-row">
          <label class="toggle" title="${enabled ? 'Disable' : 'Enable'} on device">
            <input type="checkbox" class="wemo-toggle" data-rule-id="${r.RuleID}" ${enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
          <button class="btn btn-danger btn-sm wemo-delete-btn" data-rule-id="${r.RuleID}">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.wemo-toggle').forEach((cb) => {
    cb.addEventListener('change', function () {
      toggleWemoRule(host, port, this.dataset.ruleId, this.checked);
    });
  });
  el.querySelectorAll('.wemo-delete-btn').forEach((btn) => {
    btn.addEventListener('click', function () {
      deleteWemoRule(host, port, this.dataset.ruleId);
    });
  });
}

async function toggleWemoRule(host, port, ruleId, enabled) {
  showStatus('wemo-rules-status', spinner() + ' Updating device…', 'info');
  try {
    await homebridge.request('/rules/wemo/toggle', { host, port, ruleId, enabled });
    showStatus('wemo-rules-status', 'Rule updated ✓', 'success');
    _wemoRules = await homebridge.request('/rules/wemo/list', { host, port });
    renderWemoRules(host, port);
    setTimeout(() => showStatus('wemo-rules-status', ''), 2500);
  } catch (e) {
    showStatus('wemo-rules-status', 'Toggle failed: ' + e.message, 'error');
    _wemoRules = await homebridge.request('/rules/wemo/list', { host, port });
    renderWemoRules(host, port);
  }
}

function deleteWemoRule(host, port, ruleId) {
  // confirm() is blocked in cross-origin iframes — use inline confirm row
  const card = document.querySelector(`[data-wemo-rule-id="${ruleId}"]`);
  if (!card) return;

  const existing = card.querySelector('.delete-confirm-row');
  if (existing) {
    existing.remove();
    showStatus('wemo-rules-status', spinner() + ' Deleting…', 'info');
    homebridge.request('/rules/wemo/delete', { host, port, ruleId })
      .then(async () => {
        showStatus('wemo-rules-status', 'Rule deleted ✓', 'success');
        _wemoRules = await homebridge.request('/rules/wemo/list', { host, port });
        renderWemoRules(host, port);
        setTimeout(() => showStatus('wemo-rules-status', ''), 2500);
      })
      .catch((e) => showStatus('wemo-rules-status', 'Delete failed: ' + e.message, 'error'));
    return;
  }

  const row = document.createElement('div');
  row.className = 'delete-confirm-row';
  row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 10px;background:rgba(239,68,68,.12);border-radius:6px;font-size:0.8rem';

  const msg = document.createElement('span');
  msg.style.cssText = 'color:#fca5a5;flex:1';
  msg.textContent = 'Delete this on-device rule?';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-danger btn-sm';
  confirmBtn.textContent = 'Yes, delete';
  confirmBtn.addEventListener('click', () => deleteWemoRule(host, port, ruleId));

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost btn-sm';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => row.remove());

  row.appendChild(msg);
  row.appendChild(confirmBtn);
  row.appendChild(cancelBtn);
  card.appendChild(row);

  setTimeout(() => { if (row.isConnected) row.remove(); }, 5000);
}

async function deleteAllWemoRules(host, port) {
  if (!_wemoRules?.rules?.length) return;
  showStatus('wemo-rules-status', spinner() + ' Deleting all on-device rules…', 'info');
  try {
    await homebridge.request('/rules/wemo/delete-all', { host, port });
    showStatus('wemo-rules-status', 'All on-device rules deleted ✓', 'success');
    _wemoRules = await homebridge.request('/rules/wemo/list', { host, port });
    renderWemoRules(host, port);
    setTimeout(() => showStatus('wemo-rules-status', ''), 2500);
  } catch (e) {
    showStatus('wemo-rules-status', 'Delete all failed: ' + e.message, 'error');
  }
}

async function copyWemoRulesToDwm(host, port) {
  if (!_wemoRules?.rules?.length) {
    showStatus('wemo-rules-status', 'No Wemo rules to copy.', 'warn');
    return;
  }
  const device = _devices.find((d) => d.host === host && String(d.port) === String(port));
  const targetDevice = { host, port: Number(port), name: device?.friendlyName ?? host, udn: device?.udn };

  let copied = 0, failed = 0;
  for (const r of _wemoRules.rules) {
    const ruleDevs = (_wemoRules.ruleDevices ?? []).filter((rd) => String(rd.RuleID) === String(r.RuleID));
    if (!ruleDevs.length) continue;
    // Translate Belkin device DayID → Dibby internal day numbers so the copied
    // DWM rule matches the user's intent (Belkin-Friday=6 → Dibby-Friday=5, etc).
    const days = [...new Set(ruleDevs.flatMap((d) => deviceDaysToDibby(d.DayID)))].sort((a, b) => a - b);
    const rd0 = ruleDevs[0];
    const startTime = rd0.StartTime ?? 0;
    const endTime   = rd0.RuleDuration > 0 ? startTime + rd0.RuleDuration : -1;
    const rule = {
      name: r.Name, type: 'Schedule', enabled: String(r.State) === '1',
      days, startTime, endTime,
      startAction: Number(rd0.StartAction ?? 1), endAction: Number(rd0.EndAction ?? -1),
      startType: 'fixed', endType: 'fixed', startOffset: 0, endOffset: 0,
      targetDevices: [targetDevice],
    };
    try { await homebridge.request('/rules/create', rule); copied++; }
    catch { failed++; }
  }
  if (copied > 0) await loadDwmRules();
  const msg = `Copied ${copied} rule${copied !== 1 ? 's' : ''} to DWM${failed ? `, ${failed} failed` : ''}.`;
  showStatus('wemo-rules-status', msg, copied > 0 ? 'success' : 'error');
}

// ---------------------------------------------------------------------------
// Settings — Location
// ---------------------------------------------------------------------------

async function loadLocation() {
  try {
    const loc = await homebridge.request('/location/get');
    updateLocationDisplay(loc);
  } catch { /* ignore */ }
}

function updateLocationDisplay(loc) {
  const el = document.getElementById('location-current');
  if (loc?.lat != null) {
    el.textContent = `📍 ${loc.label ?? `${loc.lat}, ${loc.lng}`}`;
  } else {
    el.textContent = 'Not set';
  }
}

let _locSearchTimer = null;
document.getElementById('location-search-input').addEventListener('input', function () {
  clearTimeout(_locSearchTimer);
  const q = this.value.trim();
  if (q.length < 2) { hideAutocomplete(); return; }
  _locSearchTimer = setTimeout(() => searchLocation(q), 400);
});

async function searchLocation(query) {
  try {
    const results = await homebridge.request('/location/search', { query });
    showAutocomplete(results);
  } catch { hideAutocomplete(); }
}

function showAutocomplete(results) {
  const el = document.getElementById('location-autocomplete');
  if (!results.length) { hideAutocomplete(); return; }
  el.innerHTML = results.map((r, i) =>
    `<div class="autocomplete-item" data-idx="${i}">${esc(r.label)}</div>`
  ).join('');
  el.style.display = 'block';
  el._results = results;
  el.querySelectorAll('.autocomplete-item').forEach((item, i) => {
    item.addEventListener('click', () => {
      _pendingLocation = el._results[i];
      document.getElementById('location-search-input').value = _pendingLocation.label;
      hideAutocomplete();
      document.getElementById('btn-location-save').disabled = false;
    });
  });
}

function hideAutocomplete() {
  const el = document.getElementById('location-autocomplete');
  el.style.display = 'none';
}

document.getElementById('btn-location-save').addEventListener('click', async () => {
  if (!_pendingLocation) return;
  try {
    await homebridge.request('/location/set', _pendingLocation);
    updateLocationDisplay(_pendingLocation);
    document.getElementById('location-status').textContent = 'Saved ✓';
    document.getElementById('btn-location-save').disabled = true;
    _pendingLocation = null;
    setTimeout(() => { document.getElementById('location-status').textContent = ''; }, 2500);
  } catch (e) {
    document.getElementById('location-status').textContent = 'Failed: ' + e.message;
  }
});

// ---------------------------------------------------------------------------
// XSS-safe text escaping
// ---------------------------------------------------------------------------

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Scheduler heartbeat
// ---------------------------------------------------------------------------

async function refreshHeartbeat() {
  const dot  = document.getElementById('hb-dot');
  const text = document.getElementById('hb-text');
  const next = document.getElementById('hb-next');
  if (!dot) return;

  try {
    const hb = await homebridge.request('/scheduler/status');

    if (!hb || !hb.running) {
      dot.style.background  = '#ef4444';
      text.style.color      = '#fca5a5';
      text.textContent      = hb?.ts
        ? '⚠ Scheduler stopped — restart Homebridge to recover'
        : '⚠ Scheduler not running — check Homebridge config has DibbyWemo platform';
      next.textContent = '';
      return;
    }

    if (hb.stale) {
      dot.style.background = '#f97316';
      text.style.color     = '#fdba74';
      text.textContent     = '⚠ Scheduler may be unresponsive (last heartbeat: ' + _relTime(hb.ts) + ')';
      next.textContent     = '';
      return;
    }

    // Healthy
    dot.style.background = '#22c55e';
    text.style.color     = '#4ade80';
    text.textContent     = '✓ Scheduler running · ' + hb.totalEntries + ' schedule entr' + (hb.totalEntries === 1 ? 'y' : 'ies');

    // Last fired
    if (hb.lastFire) {
      const icon = hb.lastFire.success ? '✓' : '⚠';
      next.textContent = 'Last: ' + icon + ' ' + hb.lastFire.msg.replace(/\s*[✓⚠]\s*$/, '') + ' · ' + _relTime(hb.lastFire.at);
      next.style.color = hb.lastFire.success ? 'var(--muted)' : '#fca5a5';
    } else if (hb.upcoming && hb.upcoming.length) {
      const u = hb.upcoming[0];
      next.textContent = 'Next: ' + u.ruleName + ' → ' + u.action + ' at ' + u.at;
      next.style.color = 'var(--muted)';
    } else {
      next.textContent = 'No upcoming rules today';
      next.style.color = 'var(--muted)';
    }
  } catch {
    dot.style.background = 'var(--muted)';
    text.style.color     = 'var(--muted)';
    text.textContent     = 'Scheduler status unavailable';
    next.textContent     = '';
  }
}

function _relTime(iso) {
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 5)   return 'just now';
  if (diff < 60)  return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  return Math.floor(diff / 3600) + 'h ago';
}

// Poll heartbeat every 35 seconds while on the DWM tab
let _hbTimer = null;
function startHeartbeatPolling() {
  refreshHeartbeat();
  _hbTimer = setInterval(refreshHeartbeat, 35_000);
}
function stopHeartbeatPolling() {
  if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null; }
}

// Start/stop polling when tab changes
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'dwm-rules') startHeartbeatPolling();
    else stopHeartbeatPolling();
  });
});

// ---------------------------------------------------------------------------
// Plugin config (heartbeat / poll / discovery)
// ---------------------------------------------------------------------------

async function loadPluginConfig() {
  try {
    const cfg = await homebridge.request('/config/get');
    document.getElementById('cfg-heartbeat').value  = cfg.heartbeatInterval  ?? 1;
    document.getElementById('cfg-poll').value        = cfg.pollInterval       ?? 30;
    document.getElementById('cfg-discovery').value   = cfg.discoveryTimeout   ?? 10000;
  } catch { /* non-fatal */ }
}

document.getElementById('btn-cfg-save').addEventListener('click', async () => {
  const btn = document.getElementById('btn-cfg-save');
  const status = document.getElementById('cfg-status');
  btn.disabled = true;
  try {
    await homebridge.request('/config/set', {
      heartbeatInterval: parseInt(document.getElementById('cfg-heartbeat').value,  10),
      pollInterval:      parseInt(document.getElementById('cfg-poll').value,        10),
      discoveryTimeout:  parseInt(document.getElementById('cfg-discovery').value,   10),
    });
    status.textContent = 'Saved ✓';
    setTimeout(() => { status.textContent = ''; }, 2500);
  } catch (e) {
    status.textContent = 'Failed: ' + e.message;
    status.style.color = 'var(--accent)';
  }
  btn.disabled = false;
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async function init() {
  await loadDevices();
  await loadDwmRules();
  await loadLocation();
  await loadPluginConfig();
  refreshWemoDeviceSelect();
  startHeartbeatPolling();
  // Fetch today's sun times in background — used by rule editor previews
  homebridge.request('/sun-times').then((st) => { _todaySunTimes = st; }).catch(() => {});
})();
