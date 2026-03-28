'use strict';
import React, { useEffect, useState, useCallback } from 'react';
import RuleEditor    from './RuleEditor';
import AllRulesTab   from './AllRulesTab';
import ConfirmDialog from '../shared/ConfirmDialog';
import useSettingsStore from '../../store/settings';
import useDeviceStore   from '../../store/devices';

// ── Constants ─────────────────────────────────────────────────────────────────

const DAY_SHORT  = { 1:'Mon', 2:'Tue', 3:'Wed', 4:'Thu', 5:'Fri', 6:'Sat', 7:'Sun' };
const RULE_ICONS = { Schedule: '📅', Away: '🏠', Countdown: '⏱', AlwaysOn: '🔒', Trigger: '⚡', 'Long Press': '👆' };
const ACTION_LABEL = { 1: '→ ON', 0: '→ OFF', 2: '↔ Toggle', '-1': '' };

function actionLabel(val) {
  if (val === null || val === undefined) return '';
  return ACTION_LABEL[String(Math.round(Number(val)))] ?? '';
}

function secsToHHMM(secs) {
  if (secs === -2) return '🌅 Sunrise';
  if (secs === -3) return '🌇 Sunset';
  if (!secs && secs !== 0) return '—';
  const h = Math.floor(Math.abs(secs) / 3600) % 24;
  const m = Math.floor((Math.abs(secs) % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function ruleSummary(rule) {
  const days = (rule.days ?? []).map((d) => DAY_SHORT[d]).join(' ') || '—';
  if (rule.type === 'AlwaysOn') return 'Enforced ON every 10 s';
  if (rule.type === 'Trigger') {
    const src    = rule.triggerDevice?.name || rule.triggerDevice?.host || '?';
    const when   = rule.triggerEvent === 'on' ? 'ON' : rule.triggerEvent === 'off' ? 'OFF' : 'ON/OFF';
    const action = rule.action === 'mirror' ? 'mirror' : rule.action === 'opposite' ? 'opposite' : (rule.action ?? 'on').toUpperCase();
    return `If ${src} → ${when}, then ${action}`;
  }
  if (rule.type === 'Countdown') {
    const mins = rule.countdownTime ? Math.round(rule.countdownTime / 60) : null;
    const base = mins
      ? `${mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 > 0 ? `${mins % 60}m` : ''}` : `${mins}m`} auto-off`
      : '—';
    if (rule.windowStart >= 0 && rule.windowEnd >= 0) {
      const windowDays = (rule.windowDays ?? []).map((d) => DAY_SHORT[d]).join(' ') || '—';
      return `${base} · window ${secsToHHMM(rule.windowStart)}–${secsToHHMM(rule.windowEnd)} ${windowDays}`;
    }
    return base;
  }
  if (rule.type === 'Away') {
    return `${days} · ${secsToHHMM(rule.startTime)}–${secsToHHMM(rule.endTime)}`;
  }
  const start   = secsToHHMM(rule.startTime);
  const sa      = actionLabel(rule.startAction);
  const et      = rule.endTime;
  const endTime = (et > 0 || et === -2 || et === -3) ? secsToHHMM(et) : null;
  const ea      = endTime ? actionLabel(rule.endAction) : '';
  return endTime
    ? `${days} · ${start} ${sa} → ${endTime} ${ea}`.trim()
    : `${days} · ${start}${sa ? ' ' + sa : ''}`;
}

// ── DWM Rule Row ──────────────────────────────────────────────────────────────

function RuleRow({ rule, onEdit, onDelete, onToggle, onTest }) {
  const [toggling, setToggling] = useState(false);
  const [testing,  setTesting]  = useState(false);
  const icon      = RULE_ICONS[rule.type] || '📅';
  const badgeType = rule.type === 'Away' ? 'away' : rule.type === 'AlwaysOn' ? 'alwayson' : rule.type === 'Trigger' ? 'trigger' : 'schedule';

  return (
    <div className={`rule-card${rule.enabled ? '' : ' disabled'}`}>
      <span className="rule-icon">{icon}</span>
      <div className="rule-body" onClick={() => onEdit(rule)} style={{ cursor: 'pointer' }}>
        <div className="rule-name">{rule.name}</div>
        <div className="rule-meta">
          <span className={`badge badge-${badgeType}`} style={{ marginRight: 6 }}>
            {rule.type}
          </span>
          {ruleSummary(rule)}
          {!rule.enabled && <span className="badge badge-disabled" style={{ marginLeft: 6 }}>Disabled</span>}
        </div>
        {/* Target / action devices */}
        {rule.type === 'Trigger' ? (
          <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {rule.triggerDevice && (
              <span style={{ fontSize: 11, background: 'rgba(255,200,0,.12)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 7px', color: 'var(--text2)' }}>
                ⚡ {rule.triggerDevice.name || rule.triggerDevice.host}
              </span>
            )}
            {(rule.actionDevices ?? []).map((td) => (
              <span key={td.udn || td.host} style={{ fontSize: 11, background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 7px', color: 'var(--text2)' }}>
                🎯 {td.name || td.host}
              </span>
            ))}
          </div>
        ) : rule.targetDevices?.length > 0 && (
          <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {rule.targetDevices.map((td) => (
              <span key={td.udn || td.host} style={{
                fontSize: 11, background: 'var(--card2)', border: '1px solid var(--border)',
                borderRadius: 4, padding: '1px 7px', color: 'var(--text2)',
              }}>
                📍 {td.name || td.host}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="rule-actions">
        <label className="toggle" title={rule.enabled ? 'Disable' : 'Enable'}>
          <input type="checkbox" checked={!!rule.enabled}
            onChange={async () => {
              setToggling(true);
              try { await onToggle(rule, !rule.enabled); } finally { setToggling(false); }
            }}
            disabled={toggling} />
          <span className="toggle-track" />
          <span className="toggle-thumb" />
        </label>
        <button className="btn btn-ghost btn-icon btn-sm" title="Test — turn ON all target devices right now"
          disabled={testing}
          onClick={async () => { setTesting(true); try { await onTest(rule); } finally { setTesting(false); } }}>
          {testing ? <span className="spinner" style={{ width: 10, height: 10, borderWidth: 2 }} /> : '▶'}
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" title="Edit"   onClick={() => onEdit(rule)}>✏️</button>
        <button className="btn btn-ghost btn-icon btn-sm" title="Delete" onClick={() => onDelete(rule)}>🗑</button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RulesTab({ device }) {
  const addToast    = useSettingsStore((s) => s.addToast);
  const { devices } = useDeviceStore();

  const [subTab,       setSubTab]       = useState('dwm');
  const [dwmRules,     setDwmRules]     = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [editingRule,  setEditingRule]  = useState(null);
  const [creating,     setCreating]     = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [importing,    setImporting]    = useState(false);

  // ── Load DWM rules from local store ──────────────────────────────────────

  const loadDwmRules = useCallback(async () => {
    setLoading(true);
    try {
      const rules = await window.wemoAPI.getDwmRules();
      setDwmRules(rules ?? []);
    } catch (e) {
      addToast(`Failed to load DWM rules: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDwmRules();
  }, []);

  // ── DWM CRUD ─────────────────────────────────────────────────────────────

  const handleSaved = async () => {
    setEditingRule(null);
    setCreating(false);
    await loadDwmRules();
    addToast('✅ Rule saved', 'success');
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await window.wemoAPI.deleteDwmRule({ id: deleteTarget.id });
      setDwmRules((prev) => prev.filter((r) => r.id !== deleteTarget.id));
      addToast('Rule deleted', 'success');
    } catch (e) {
      addToast(`Delete failed: ${e.message}`, 'error');
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleToggle = async (rule, enabled) => {
    try {
      await window.wemoAPI.updateDwmRule({ id: rule.id, updates: { enabled } });
      setDwmRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled } : r));
      addToast(`Rule ${enabled ? 'enabled' : 'disabled'}`, 'info');
    } catch (e) {
      addToast(`Toggle failed: ${e.message}`, 'error');
    }
  };

  const handleTest = async (rule) => {
    const targets = (rule.targetDevices ?? []).filter((td) => td.host && td.port);
    if (targets.length === 0) {
      addToast('No devices configured for this rule', 'warn');
      return;
    }
    const results = await Promise.allSettled(
      targets.map((t) => window.wemoAPI.setDeviceState({ host: t.host, port: t.port, on: true }))
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    addToast(
      `▶ Test: turned ON ${ok}/${targets.length} device(s)` +
      (results.some((r) => r.status === 'rejected') ? ` · ${results.filter((r) => r.status === 'rejected').length} unreachable` : ''),
      ok > 0 ? 'success' : 'error'
    );
  };

  // ── Export / Import ───────────────────────────────────────────────────────

  function handleExportJSON() {
    if (!dwmRules.length) { addToast('No DWM rules to export', 'warn'); return; }
    const payload = {
      _meta: { exportedAt: new Date().toISOString(), app: 'Dibby Wemo Manager', version: '2.0' },
      rules: dwmRules,
    };
    window.wemoAPI.showSaveDialog({
      title: 'Export DWM Rules as JSON',
      defaultPath: 'dwm-rules.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }).then(({ filePath, canceled }) => {
      if (canceled || !filePath) return null;
      return window.wemoAPI.writeFile({ filePath, content: JSON.stringify(payload, null, 2) }).then(() => filePath);
    }).then((fp) => { if (fp) addToast(`✅ Exported ${dwmRules.length} DWM rules`, 'success'); })
      .catch((e) => addToast(`Export failed: ${e.message}`, 'error'));
  }

  function secsToCSVTime(secs, startType) {
    if (startType === 'sunrise') return 'sunrise';
    if (startType === 'sunset')  return 'sunset';
    if (!secs || secs < 0)      return '';
    return `${String(Math.floor(secs / 3600) % 24).padStart(2,'0')}:${String(Math.floor((secs % 3600) / 60)).padStart(2,'0')}`;
  }

  function handleExportCSV() {
    if (!dwmRules.length) { addToast('No DWM rules to export', 'warn'); return; }
    const escape = (v) => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s; };
    const ACTION_LABEL_CSV = { 1: 'ON', 0: 'OFF', 2: 'Toggle', '-1': 'None' };
    const encodeAction = (val) => ACTION_LABEL_CSV[String(Math.round(Number(val ?? -1)))] ?? 'None';
    const header = ['name','type','enabled','days','startTime','endTime','startAction','endAction','countdownTime','targetDevices'];
    const rows = [header.join(',')];
    for (const rule of dwmRules) {
      rows.push([
        escape(rule.name), escape(rule.type), rule.enabled ? '1' : '0',
        escape((rule.days ?? []).map((n) => DAY_SHORT[n]).join('|')),
        escape(secsToCSVTime(rule.startTime, rule.startType)),
        escape(secsToCSVTime(rule.endTime,   rule.endType)),
        encodeAction(rule.startAction), encodeAction(rule.endAction),
        String(rule.countdownTime ?? 0),
        escape((rule.targetDevices ?? []).map((td) => td.udn || td.host).join(';')),
      ].join(','));
    }
    window.wemoAPI.showSaveDialog({
      title: 'Export DWM Rules as CSV',
      defaultPath: 'dwm-rules.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    }).then(({ filePath, canceled }) => {
      if (canceled || !filePath) return null;
      return window.wemoAPI.writeFile({ filePath, content: rows.join('\r\n') }).then(() => filePath);
    }).then((fp) => { if (fp) addToast('✅ DWM rules exported to CSV', 'success'); })
      .catch((e) => addToast(`Export failed: ${e.message}`, 'error'));
  }

  async function handleImport() {
    let filePath;
    try {
      const result = await window.wemoAPI.showOpenDialog({
        title: 'Import DWM Rules', filters: [{ name: 'Rules files', extensions: ['json'] }], properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths?.length) return;
      filePath = result.filePaths[0];
    } catch (e) { addToast(`Import failed: ${e.message}`, 'error'); return; }

    let rawText;
    try { rawText = await window.wemoAPI.readFile({ filePath }); }
    catch (e) { addToast(`Could not read file: ${e.message}`, 'error'); return; }

    let rulesList = [];
    try {
      const parsed = JSON.parse(rawText);
      rulesList = Array.isArray(parsed) ? parsed : (parsed.rules ?? []);
    } catch (e) { addToast(`Failed to parse JSON: ${e.message}`, 'error'); return; }

    if (!rulesList.length) { addToast('No rules found in file', 'warn'); return; }

    setImporting(true);
    let ok = 0, fail = 0;
    for (const rule of rulesList) {
      // Strip the id so a new one is generated — prevents ID collisions on import
      const { id: _id, createdAt: _ca, updatedAt: _ua, ...rest } = rule;
      try { await window.wemoAPI.createDwmRule(rest); ok++; }
      catch (e) { fail++; console.error('Import rule failed:', e.message, rule); }
    }
    setImporting(false);
    await loadDwmRules();
    if (fail === 0) addToast(`✅ Imported ${ok} rule${ok !== 1 ? 's' : ''} successfully`, 'success', 8000);
    else            addToast(`Imported ${ok} rule${ok !== 1 ? 's' : ''}, ${fail} failed`, 'warn', 8000);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Sub-tab bar ─────────────────────────────────────────────────── */}
      <div className="tab-bar" style={{ padding: '0 20px', background: 'var(--bg)', flexShrink: 0 }}>
        <button
          className={`tab-btn${subTab === 'dwm' ? ' active' : ''}`}
          style={{ fontSize: 12, padding: '8px 16px' }}
          onClick={() => setSubTab('dwm')}
          title="Rules stored locally by this app — these are what the scheduler fires"
        >
          DWM Rules
        </button>
        <button
          className={`tab-btn${subTab === 'wemo' ? ' active' : ''}`}
          style={{ fontSize: 12, padding: '8px 16px' }}
          onClick={() => setSubTab('wemo')}
          title="All rules from all Wemo devices — read-only, duplicates removed"
        >
          Wemo Rules
        </button>
      </div>

      {/* ── DWM Rules ───────────────────────────────────────────────────── */}
      {subTab === 'dwm' && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

          {loading ? (
            <div className="empty-state"><span className="spinner" /><p>Loading rules…</p></div>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>

              {/* Toolbar */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>+ New Rule</button>
                <button className="btn btn-secondary btn-sm" onClick={loadDwmRules}>⟳ Refresh</button>
                <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                  <button className="btn btn-ghost btn-sm" onClick={handleExportJSON} disabled={importing}>↓ JSON</button>
                  <button className="btn btn-ghost btn-sm" onClick={handleExportCSV}  disabled={importing}>↓ CSV</button>
                  <button className="btn btn-ghost btn-sm" onClick={handleImport}     disabled={importing}>
                    {importing
                      ? <><span className="spinner" style={{ width: 10, height: 10, borderWidth: 2, marginRight: 4 }} />Importing…</>
                      : '↑ Import'}
                  </button>
                </div>
              </div>

              {/* Rule list */}
              {dwmRules.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-state-icon">📅</span>
                  <p>
                    No DWM rules yet.<br />
                    Click <strong>+ New Rule</strong> to create one, or switch to<br />
                    <strong>Wemo Rules</strong> tab to copy existing device rules here.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {dwmRules.map((rule) => (
                    <RuleRow key={rule.id} rule={rule}
                      onEdit={setEditingRule} onDelete={setDeleteTarget}
                      onToggle={handleToggle} onTest={handleTest} />
                  ))}
                </div>
              )}

              {/* Info notice */}
              <div className="notice notice-info" style={{ marginTop: 16, fontSize: 12 }}>
                💾 DWM rules are stored locally on this computer — not on the Wemo device.<br />
                The app scheduler fires them while this app is running.
              </div>

            </div>
          )}

          {/* Create / Edit modal */}
          {(creating || editingRule) && (
            <RuleEditor
              rule={editingRule}
              device={device}
              isDwm
              onSave={handleSaved}
              onClose={() => { setCreating(false); setEditingRule(null); }}
            />
          )}

          {/* Delete confirm */}
          {deleteTarget && (
            <ConfirmDialog title="Delete Rule"
              message={`Delete rule "${deleteTarget.name}"? This cannot be undone.`}
              confirmLabel="Delete" danger
              onConfirm={handleDelete}
              onCancel={() => setDeleteTarget(null)} />
          )}
        </div>
      )}

      {/* ── Wemo Rules ──────────────────────────────────────────────────── */}
      {subTab === 'wemo' && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <AllRulesTab />
        </div>
      )}
    </div>
  );
}
