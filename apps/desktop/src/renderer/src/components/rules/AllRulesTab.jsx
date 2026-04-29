'use strict';
import React, { useState, useCallback, useEffect } from 'react';
import RuleEditor       from './RuleEditor';
import useDeviceStore   from '../../store/devices';
import useSettingsStore from '../../store/settings';

// ── Constants ─────────────────────────────────────────────────────────────────

const DWM_PREFIX = 'DWM:';
function isDwm(name) { return String(name ?? '').startsWith(DWM_PREFIX); }
function stripDwm(name) { return String(name ?? '').replace(/^DWM:/i, ''); }

// ── Shared display helpers ────────────────────────────────────────────────────

const DAY_SHORT  = { 1:'Mon', 2:'Tue', 3:'Wed', 4:'Thu', 5:'Fri', 6:'Sat', 7:'Sun' };
const RULE_ICONS = { Schedule: '📅', Away: '🏠', Countdown: '⏱', 'Long Press': '👆' };
const DISPLAY_TYPE_MAP = {
  'time interval': 'Schedule', 'simple switch': 'Schedule',
  'countdown rule': 'Countdown',
  'away mode':     'Away',
  'long press':    'Long Press',
};

function normaliseType(raw) {
  if (!raw) return 'Schedule';
  const key = String(raw).toLowerCase().trim().replace(/\s+/g, ' ');
  return DISPLAY_TYPE_MAP[key] || raw;
}

function secsToHHMM(secs) {
  if (secs === -2) return '🌅 Sunrise';
  if (secs === -3) return '🌇 Sunset';
  if (!secs && secs !== 0) return '—';
  const h = Math.floor(Math.abs(secs) / 3600) % 24;
  const m = Math.floor((Math.abs(secs) % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const ACTION_LABEL = { 1: '→ ON', 0: '→ OFF', 2: '↔ Toggle', '-1': '' };
function actionLabel(val) {
  if (val === null || val === undefined) return '';
  return ACTION_LABEL[String(Math.round(Number(val)))] ?? '';
}

function ruleSummary(rule) {
  const rd      = rule.ruleDevices?.[0];
  const typeKey = normaliseType(rule.type);

  if (typeKey === 'Countdown') {
    const mins = rd?.countdowntime ? Math.round(rd.countdowntime / 60) : null;
    return mins ? `${mins} min ${actionLabel(rd?.startaction)}` : '—';
  }
  if (typeKey === 'Away') {
    const days = rd?.days?.map((d) => DAY_SHORT[d]).join(' ') || '—';
    return `${days} · ${secsToHHMM(rd?.starttime)}–${secsToHHMM(rd?.endtime)}`;
  }
  const days    = rd?.days?.map((d) => DAY_SHORT[d]).join(' ') || '—';
  const start   = secsToHHMM(rd?.starttime);
  const sa      = actionLabel(rd?.startaction);
  const et      = rd?.endtime;
  const endTime = (et > 0 || et === -2 || et === -3) ? secsToHHMM(et) : null;
  const ea      = endTime ? actionLabel(rd?.endaction) : '';
  return endTime
    ? `${days} · ${start} ${sa} → ${endTime} ${ea}`.trim()
    : `${days} · ${start}${sa ? ' ' + sa : ''}`;
}


/**
 * Deduplication key: normalised name (prefix stripped) + canonical type + sorted days + startTime.
 */
function dedupKey(rule) {
  const rd   = rule.ruleDevices?.[0];
  const days = (rd?.days ?? []).slice().sort((a, b) => a - b).join(',');
  return `${stripDwm(rule.name).toLowerCase().trim()}|${normaliseType(rule.type)}|${days}|${rd?.starttime ?? ''}`;
}

// ── Copy-to-DWM button ────────────────────────────────────────────────────────

/**
 * Converts a Wemo device rule into a DWM local-store rule and saves it.
 * Does NOT write anything to the Wemo device.
 */
function CopyToDwmButton({ rule, onDone }) {
  const [copying, setCopying] = useState(false);
  const addToast  = useSettingsStore((s) => s.addToast);
  const { devices } = useDeviceStore();

  const handle = async () => {
    setCopying(true);
    try {
      // Resolve full device info (host+port) for each source device
      const targetDevices = (rule.sourceDevices ?? []).map((sd) => {
        const dev = devices.find((d) => d.udn === sd.udn);
        return dev
          ? { udn: dev.udn, host: dev.host, port: dev.port, name: dev.friendlyName || dev.name }
          : null;
      }).filter(Boolean);

      if (!targetDevices.length) {
        addToast('No discoverable devices found for this rule — run a scan first', 'warn');
        setCopying(false);
        return;
      }

      // Convert Wemo rule schema to DWM local schema
      const rd        = rule.ruleDevices?.[0];
      const startSecs = Number(rd?.starttime ?? 0);
      const endSecs   = Number(rd?.endtime   ?? -1);

      let startType = 'fixed', startOffset = 0;
      let endType   = 'fixed', endOffset   = 0;
      let startTime = startSecs, endTime = endSecs;

      if      (startSecs === -2) { startType = 'sunrise'; startOffset = Math.round((rd?.onmodeoffset  ?? 0) / 60); startTime = -2; }
      else if (startSecs === -3) { startType = 'sunset';  startOffset = Math.round((rd?.onmodeoffset  ?? 0) / 60); startTime = -3; }
      if      (endSecs   === -2) { endType   = 'sunrise'; endOffset   = Math.round((rd?.offmodeoffset ?? 0) / 60); endTime   = -2; }
      else if (endSecs   === -3) { endType   = 'sunset';  endOffset   = Math.round((rd?.offmodeoffset ?? 0) / 60); endTime   = -3; }

      const dwmRule = {
        name:          stripDwm(rule.name),
        type:          normaliseType(rule.type),
        enabled:       rule.enabled ?? true,
        days:          rd?.days ?? [1,2,3,4,5,6,7],
        startTime,
        endTime,
        startAction:   Number(rd?.startaction   ?? 1),
        endAction:     Number(rd?.endaction     ?? -1),
        startType,     startOffset,
        endType,       endOffset,
        countdownTime: Number(rd?.countdowntime ?? 0),
        targetDevices,
      };

      await window.wemoAPI.createDwmRule(dwmRule);
      addToast(`✅ "${dwmRule.name}" copied to DWM Rules`, 'success', 6000);
      onDone?.();
    } catch (e) {
      addToast(`Copy failed: ${e.message}`, 'error');
    } finally {
      setCopying(false);
    }
  };

  return (
    <button
      className="btn btn-ghost btn-sm"
      style={{ fontSize: 11, padding: '2px 8px', color: 'var(--accent)' }}
      disabled={copying}
      title="Copy to DWM Rules (saved locally — not written to device)"
      onClick={(e) => { e.stopPropagation(); handle(); }}
    >
      {copying
        ? <span className="spinner" style={{ width: 9, height: 9, borderWidth: 2 }} />
        : '📥 Add to DWM'}
    </button>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AllRulesTab() {
  const { devices } = useDeviceStore();
  const addToast    = useSettingsStore((s) => s.addToast);

  const [allRules,     setAllRules]     = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [deviceErrors, setDeviceErrors] = useState({});
  const [editingRule,  setEditingRule]  = useState(null);
  const [editingDevice, setEditingDevice] = useState(null);
  const [svcStatus,    setSvcStatus]    = useState(null);

  // Poll scheduler service status so we know whether device-firmware rules will fire
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      window.wemoAPI?.serviceStatus?.()
        .then((s) => { if (!cancelled) setSvcStatus(s); })
        .catch(() => {});
    };
    refresh();
    const id = setInterval(refresh, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setDeviceErrors({});

    const capable = devices.filter((d) => d.supportsRules !== false);
    if (!capable.length) { setAllRules([]); setLoading(false); return; }

    const errors  = {};
    const grouped = new Map();

    await Promise.allSettled(
      capable.map(async (dev) => {
        try {
          const res      = await window.wemoAPI.getRules({ host: dev.host, port: dev.port });
          const devLabel = dev.friendlyName || dev.name || dev.host;

          for (const rule of (res.rules ?? [])) {
            const key = dedupKey(rule);
            if (grouped.has(key)) {
              const existing = grouped.get(key);
              if (!existing.sourceDevices.some((s) => s.udn === dev.udn)) {
                existing.sourceDevices.push({ udn: dev.udn, name: devLabel });
              }
              // Prefer DWM version of the rule (has more info)
              if (isDwm(rule.name) && !isDwm(existing.name)) {
                grouped.set(key, { ...rule, _key: key, sourceDevices: existing.sourceDevices });
              }
            } else {
              grouped.set(key, { ...rule, _key: key, sourceDevices: [{ udn: dev.udn, name: devLabel }] });
            }
          }
        } catch (e) {
          errors[dev.udn] = e.message || 'Failed to connect';
        }
      })
    );

    setDeviceErrors(errors);

    // Sort: DWM rules first, then enabled, then alphabetically
    const list = [...grouped.values()].sort((a, b) => {
      const aDwm = isDwm(a.name) ? 0 : 1;
      const bDwm = isDwm(b.name) ? 0 : 1;
      if (aDwm !== bDwm) return aDwm - bDwm;
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return stripDwm(a.name).localeCompare(stripDwm(b.name));
    });
    setAllRules(list);
    setLoading(false);
  }, [devices]);

  const handleEdit = (rule) => {
    const sd  = rule.sourceDevices?.[0];
    const dev = sd ? devices.find((d) => d.udn === sd.udn) : null;
    if (!dev) {
      addToast('Device not found — run a scan first', 'warn');
      return;
    }
    setEditingRule(rule);
    setEditingDevice(dev);
  };

  const handleToggle = async (rule, enabled) => {
    // Update rule on every source device it lives on
    const targets = (rule.sourceDevices ?? [])
      .map((sd) => devices.find((d) => d.udn === sd.udn))
      .filter(Boolean);

    if (!targets.length) {
      addToast('Device not found — run a scan first', 'warn');
      return;
    }

    // Optimistic UI update
    setAllRules((prev) =>
      prev.map((r) => r._key === rule._key ? { ...r, enabled } : r)
    );

    const results = await Promise.allSettled(
      targets.map((dev) =>
        window.wemoAPI.updateRule({ host: dev.host, port: dev.port, ruleId: rule.ruleId, input: { enabled } })
      )
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) {
      addToast(`Updated ${targets.length - failed}/${targets.length} device(s) — ${failed} unreachable`, 'warn');
      // Revert optimistic update on failure
      setAllRules((prev) =>
        prev.map((r) => r._key === rule._key ? { ...r, enabled: !enabled } : r)
      );
    } else {
      addToast(`Rule ${enabled ? 'enabled' : 'disabled'}`, 'info');
    }
  };

  const errorEntries = Object.entries(deviceErrors);
  const capableCount = devices.filter((d) => d.supportsRules !== false).length;

  const dwmCount    = allRules ? allRules.filter((r) => isDwm(r.name)).length : 0;
  const wemoCount   = allRules ? allRules.filter((r) => !isDwm(r.name)).length : 0;
  const dedupSaved  = allRules
    ? allRules.reduce((acc, r) => acc + r.sourceDevices.length, 0) - allRules.length
    : 0;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-secondary btn-sm" onClick={loadAll} disabled={loading}>
          {loading
            ? <><span className="spinner" style={{ width: 10, height: 10, borderWidth: 2, marginRight: 4 }} />Loading…</>
            : allRules === null ? '⟳ Load All Rules' : '⟳ Refresh'}
        </button>
        {allRules !== null && !loading && (
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            {capableCount} device{capableCount !== 1 ? 's' : ''}
            {' · '}
            <span style={{ color: 'var(--accent)' }}>{dwmCount} DWM</span>
            {wemoCount > 0 && <span> · {wemoCount} Wemo</span>}
            {dedupSaved > 0 && (
              <span style={{ marginLeft: 6, color: 'var(--success)', fontSize: 11 }}>
                ({dedupSaved} duplicate{dedupSaved !== 1 ? 's' : ''} collapsed)
              </span>
            )}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>
          📥 Copy adds rules to local DWM database
        </span>
      </div>

      {/* Scheduler-not-running banner — only when there are device-firmware rules at risk */}
      {wemoCount > 0 && svcStatus && !svcStatus.running && (
        <div className="notice notice-warn" style={{ marginBottom: 12, fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            ⚠️ {wemoCount} Wemo device rule{wemoCount !== 1 ? 's are' : ' is'} not firing — scheduler service is {svcStatus.installed ? 'stopped' : 'not installed'}
          </div>
          <div style={{ color: 'var(--text2)', lineHeight: 1.45 }}>
            Wemo on-device firmware schedulers stopped working when Belkin shut down their cloud (2024).
            Rules sit in device memory but never trigger unless an external scheduler fires them. Open the
            sidebar's <strong>Scheduler</strong> section and {svcStatus.installed ? 'start' : 'install'} the
            DibbyWemoScheduler service so these rules actually fire — or convert them to DWM rules using the
            📥 button on each card.
          </div>
        </div>
      )}

      {/* Device errors */}
      {errorEntries.length > 0 && (
        <div className="notice notice-warn" style={{ marginBottom: 12, fontSize: 12 }}>
          ⚠️ Could not reach {errorEntries.length} device{errorEntries.length !== 1 ? 's' : ''}:
          {errorEntries.map(([udn, msg]) => {
            const dev = devices.find((d) => d.udn === udn);
            return (
              <div key={udn} style={{ marginTop: 2 }}>
                · {dev?.friendlyName || dev?.name || udn}: {msg}
              </div>
            );
          })}
        </div>
      )}

      {/* Not loaded */}
      {allRules === null && !loading && (
        <div className="empty-state">
          <span className="empty-state-icon">🌐</span>
          <p>
            Click <strong>Load All Rules</strong> to fetch rules from all<br />
            your Wemo devices in one deduplicated list.<br />
            <span style={{ fontSize: 12, color: 'var(--text3)' }}>
              🔵 DWM = managed by this app &nbsp;·&nbsp; Wemo = native device rules
            </span>
          </p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="empty-state">
          <span className="spinner" />
          <p>Fetching rules from {capableCount} device{capableCount !== 1 ? 's' : ''}…</p>
        </div>
      )}

      {/* Empty */}
      {allRules !== null && !loading && allRules.length === 0 && (
        <div className="empty-state">
          <span className="empty-state-icon">📅</span>
          <p>No rules found across any devices.</p>
        </div>
      )}

      {/* Rule list */}
      {allRules !== null && !loading && allRules.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {allRules.map((rule) => {
            const typeKey  = normaliseType(rule.type);
            const icon     = RULE_ICONS[typeKey] || '📅';
            const isAway   = typeKey === 'Away';
            const managed  = isDwm(rule.name);
            return (
              <div key={rule._key} className={`rule-card${rule.enabled ? '' : ' disabled'}`}
                style={managed ? { borderLeft: '3px solid var(--accent)' } : {}}>
                <span className="rule-icon">{icon}</span>
                <div className="rule-body">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div className="rule-name">{stripDwm(rule.name)}</div>
                    {managed && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
                        background: 'var(--accent)', color: '#fff',
                        borderRadius: 3, padding: '1px 5px',
                      }}>
                        DWM
                      </span>
                    )}
                  </div>
                  <div className="rule-meta">
                    <span className={`badge badge-${isAway ? 'away' : 'schedule'}`} style={{ marginRight: 6 }}>
                      {rule.type}
                    </span>
                    {ruleSummary(rule)}
                    {!rule.enabled && (
                      <span className="badge badge-disabled" style={{ marginLeft: 6 }}>Disabled</span>
                    )}
                  </div>
                  {/* Source device chips + action buttons */}
                  <div style={{ marginTop: 5, display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    {rule.sourceDevices.map((sd) => (
                      <span key={sd.udn} style={{
                        fontSize: 11, background: 'var(--card2)', border: '1px solid var(--border)',
                        borderRadius: 4, padding: '1px 7px', color: 'var(--text2)',
                      }}>
                        📍 {sd.name}
                      </span>
                    ))}
                    {/* Copy button for non-DWM rules */}
                    {!managed && (
                      <CopyToDwmButton rule={rule} onDone={loadAll} />
                    )}
                    {managed && (
                      <span style={{ fontSize: 11, color: 'var(--accent)', marginLeft: 2 }}>
                        ✓ Managed by DWM scheduler
                      </span>
                    )}
                  </div>
                </div>
                {/* Toggle + Edit — writes back to the Wemo device */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingLeft: 8 }}>
                  <label className="toggle" title={rule.enabled ? 'Disable rule on device' : 'Enable rule on device'}>
                    <input
                      type="checkbox"
                      checked={!!rule.enabled}
                      onChange={(e) => handleToggle(rule, e.target.checked)}
                    />
                    <span className="toggle-track" />
                    <span className="toggle-thumb" />
                  </label>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    title="Edit this rule on the device"
                    onClick={() => handleEdit(rule)}
                  >✏️</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {/* Edit rule modal — writes back to the Wemo device directly */}
      {editingRule && editingDevice && (
        <RuleEditor
          rule={editingRule}
          device={editingDevice}
          isDwm={false}
          onSave={() => {
            setEditingRule(null);
            setEditingDevice(null);
            addToast('✅ Rule updated on device', 'success');
            loadAll();
          }}
          onClose={() => {
            setEditingRule(null);
            setEditingDevice(null);
          }}
        />
      )}
    </div>
  );
}
