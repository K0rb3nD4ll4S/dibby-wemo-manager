import React, { useState, useEffect } from 'react';
import Modal from '../shared/Modal';
import ScheduleEditor  from './editors/ScheduleEditor';
import CountdownEditor from './editors/CountdownEditor';
import AwayModeEditor  from './editors/AwayModeEditor';
import useDeviceStore   from '../../store/devices';
import useSettingsStore from '../../store/settings';

const RULE_TYPES = [
  { value: 'Schedule',  label: '📅 Schedule',   desc: 'Turn on/off at a specific time' },
  { value: 'Countdown', label: '⏱ Countdown',   desc: 'Auto-off after a set duration' },
  { value: 'Away',      label: '🏠 Away Mode',   desc: 'Random on/off to simulate occupancy' },
  { value: 'AlwaysOn',  label: '🔒 Always On',  desc: 'Keep device on — re-enables if turned off' },
  { value: 'Trigger',   label: '⚡ Trigger',     desc: 'If a device changes state, act on another' },
];

// ── Day name ↔ number conversion ─────────────────────────────────────────────

const DAY_NAMES = { 1:'Monday', 2:'Tuesday', 3:'Wednesday', 4:'Thursday', 5:'Friday', 6:'Saturday', 7:'Sunday' };
const DAY_NUMS  = { Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6, Sunday:7 };

function dayNumsToNames(nums) {
  return (nums ?? []).map((n) => DAY_NAMES[n]).filter(Boolean);
}

function dayNamesToNums(names) {
  return (names ?? []).map((n) => DAY_NUMS[n]).filter(Boolean);
}

function secsToHHMM(secs) {
  if (secs === null || secs === undefined || secs < 0) return '';
  const h = Math.floor(secs / 3600) % 24;
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function hhmmToSecs(t) {
  if (!t) return -1;
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
}

// ── Normalise Wemo firmware type strings ─────────────────────────────────────

const TYPE_MAP = {
  'time interval': 'Schedule', timeinterval: 'Schedule',
  'simple switch': 'Schedule', simpleswitch: 'Schedule',
  'countdown rule': 'Countdown', countdownrule: 'Countdown',
  'away mode': 'Away', awaymode: 'Away', awaymoderule: 'Away',
  schedule: 'Schedule', timer: 'Schedule', timerrule: 'Schedule',
  automation: 'Schedule', automated: 'Schedule', time: 'Schedule',
  countdown: 'Countdown', timer2: 'Countdown',
  away: 'Away',
  'long press': 'Long Press', longpress: 'Long Press',
};

function normaliseType(raw) {
  if (!raw) return 'Schedule';
  const key = String(raw).toLowerCase().trim().replace(/\s+/g, ' ');
  return TYPE_MAP[key] || TYPE_MAP[key.replace(/\s/g, '')] || raw;
}

// ── Form init helpers ─────────────────────────────────────────────────────────

/** Build form state from a DWM rule (local store schema). */
function dwmRuleToForm(rule, defaultDeviceUdn) {
  return {
    type:        normaliseType(rule.type) || 'Schedule',
    name:        rule.name || '',
    days:        dayNumsToNames(rule.days),
    startType:   rule.startType  || 'fixed',
    startTime:   rule.startType === 'fixed' && rule.startTime >= 0 ? secsToHHMM(rule.startTime) : '',
    startOffset: rule.startOffset ?? 0,
    startAction: rule.startAction ?? 1,
    endType:     rule.endType    || 'fixed',
    endTime:     rule.endType   === 'fixed' && rule.endTime > 0 ? secsToHHMM(rule.endTime) : '',
    endOffset:   rule.endOffset  ?? 0,
    endAction:   rule.endAction  ?? -1,
    countdownMins:   rule.countdownTime ? Math.round(rule.countdownTime / 60) : 60,
    countdownTime:   rule.countdownTime ?? 3600,
    countdownAction: rule.countdownAction ?? 'on_to_off',
    // Countdown active window
    windowEnabled:   rule.windowStart >= 0 && rule.windowStart != null,
    windowStartTime: rule.windowStart >= 0 ? secsToHHMM(rule.windowStart) : '',
    windowEndTime:   rule.windowEnd   >= 0 ? secsToHHMM(rule.windowEnd)   : '',
    windowDays:      dayNumsToNames(rule.windowDays ?? []),
    deviceIds:   (rule.targetDevices ?? []).map((d) => d.udn).filter(Boolean),
    targetDeviceIds: [],
    // Trigger-specific
    triggerDeviceId: rule.triggerDevice?.udn ?? '',
    triggerEvent:    rule.triggerEvent ?? 'any',
    triggerAction:   rule.action ?? 'on',
    actionDeviceIds: (rule.actionDevices ?? []).map((d) => d.udn).filter(Boolean),
  };
}

/** Build form state from a Wemo device rule (ruleDevices schema). */
function wemoRuleToForm(rule, currentUdn) {
  if (!rule) return {
    type: 'Schedule', name: '',
    days: ['Monday','Tuesday','Wednesday','Thursday','Friday'],
    startType: 'fixed', startTime: '07:00', startOffset: 0,
    startAction: 1,
    endType: 'fixed', endTime: '', endOffset: 0, endAction: -1,
    countdownMins: 60, countdownTime: 3600,
    deviceIds: currentUdn ? [currentUdn] : [],
    targetDeviceIds: [],
  };

  const rd = rule.ruleDevices?.[0];
  const type = normaliseType(rule.type);
  const startSecs = rd?.starttime;
  const endSecs   = rd?.endtime;
  const onOff     = rd?.onmodeoffset  || 0;
  const offOff    = rd?.offmodeoffset || 0;

  let startType = 'fixed', startTime = secsToHHMM(startSecs), startOffset = 0;
  let endType   = 'fixed', endTime   = secsToHHMM(endSecs),   endOffset   = 0;

  if      (startSecs === -2) { startType = 'sunrise'; startOffset = Math.round(onOff  / 60); startTime = ''; }
  else if (startSecs === -3) { startType = 'sunset';  startOffset = Math.round(onOff  / 60); startTime = ''; }
  if      (endSecs   === -2) { endType   = 'sunrise'; endOffset   = Math.round(offOff / 60); endTime   = ''; }
  else if (endSecs   === -3) { endType   = 'sunset';  endOffset   = Math.round(offOff / 60); endTime   = ''; }

  const days      = rd?.days?.length
    ? rd.days.map((n) => ['','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][n]).filter(Boolean)
    : [];
  const deviceIds = [...new Set((rule.ruleDevices ?? []).map((r) => r.deviceid).filter(Boolean))];
  if (currentUdn && !deviceIds.includes(currentUdn)) deviceIds.unshift(currentUdn);

  return {
    type, name: rule.name.replace(/^DWM:/i, ''),
    days, startType, startTime, startOffset,
    endType, endTime, endOffset,
    startAction: rd?.startaction ?? 1,
    endAction:   rd?.endaction   ?? -1,
    countdownMins: rd?.countdowntime ? Math.round(rd.countdowntime / 60) : 60,
    countdownTime: rd?.countdowntime ?? 3600,
    deviceIds, targetDeviceIds: rule.targetDevices || [],
  };
}

// ── Trigger rule editor ───────────────────────────────────────────────────────

function TriggerEditor({ form, onChange, allDevices }) {
  const selStyle = { background: 'var(--input-bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', width: '100%' };

  const toggleActionDev = (udn) => {
    const ids = form.actionDeviceIds ?? [];
    onChange({ ...form, actionDeviceIds: ids.includes(udn) ? ids.filter((x) => x !== udn) : [...ids, udn] });
  };

  return (
    <div>
      {/* Trigger source device */}
      <div className="form-group">
        <label>Trigger Device <span style={{ color: 'var(--text3)', fontSize: 12 }}>(source)</span></label>
        <p style={{ fontSize: 12, color: 'var(--text2)', margin: '2px 0 6px' }}>
          Which device's state change should trigger the action?
        </p>
        <select value={form.triggerDeviceId ?? ''} style={selStyle}
          onChange={(e) => onChange({ ...form, triggerDeviceId: e.target.value })}>
          <option value="">— select device —</option>
          {allDevices.map((d) => (
            <option key={d.udn} value={d.udn}>{d.friendlyName || d.name}</option>
          ))}
        </select>
      </div>

      {/* When */}
      <div className="form-group" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <label>When</label>
          <select value={form.triggerEvent ?? 'any'} style={selStyle}
            onChange={(e) => onChange({ ...form, triggerEvent: e.target.value })}>
            <option value="any">Turns ON or OFF</option>
            <option value="on">Turns ON</option>
            <option value="off">Turns OFF</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <label>Then</label>
          <select value={form.triggerAction ?? 'on'} style={selStyle}
            onChange={(e) => onChange({ ...form, triggerAction: e.target.value })}>
            <option value="on">Turn ON action devices</option>
            <option value="off">Turn OFF action devices</option>
            <option value="mirror">Mirror (same as trigger)</option>
            <option value="opposite">Opposite (invert trigger)</option>
          </select>
        </div>
      </div>

      {/* Action devices */}
      <div className="form-group">
        <label>Action Devices <span style={{ color: 'var(--text3)', fontSize: 12 }}>(targets)</span></label>
        <p style={{ fontSize: 12, color: 'var(--text2)', margin: '2px 0 6px' }}>
          Which devices should be controlled when the trigger fires?
        </p>
        {allDevices.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text3)' }}>No devices found. Scan for devices first.</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {allDevices.map((d) => (
              <span key={d.udn}
                className={`day-chip${(form.actionDeviceIds ?? []).includes(d.udn) ? ' on' : ''}`}
                style={{ padding: '5px 12px', cursor: 'pointer' }}
                onClick={() => toggleActionDev(d.udn)}>
                {d.friendlyName || d.name}
              </span>
            ))}
          </div>
        )}
        {!(form.actionDeviceIds ?? []).length && (
          <p style={{ fontSize: 12, color: 'var(--danger, #e55)', marginTop: 4 }}>
            Select at least one action device.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Device picker ─────────────────────────────────────────────────────────────

/**
 * For DWM rules: any combination of devices may be selected (none mandatory).
 * For Wemo device rules: the current device is always included.
 */
function DevicePicker({ isDwm, currentUdn, selected, allDevices, onChange }) {
  if (allDevices.length === 0) return null;

  const toggle = (udn) => {
    if (!isDwm && udn === currentUdn) return; // current device locked in Wemo mode
    const next = selected.includes(udn)
      ? selected.filter((x) => x !== udn)
      : [...selected, udn];
    if (!isDwm && currentUdn) {
      onChange([currentUdn, ...next.filter((x) => x !== currentUdn)]);
    } else {
      onChange(next);
    }
  };

  const selectAll = () => {
    const allUdns = allDevices.map((d) => d.udn);
    onChange(allUdns);
  };

  const selectNone = () => {
    if (!isDwm && currentUdn) {
      // In Wemo mode the current device is always kept
      onChange([currentUdn]);
    } else {
      onChange([]);
    }
  };

  return (
    <div className="form-group">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <label style={{ margin: 0 }}>Target Devices</label>
        <button type="button" className="btn btn-ghost btn-sm"
          style={{ fontSize: 11, padding: '1px 8px' }}
          onClick={selectAll}>All</button>
        <button type="button" className="btn btn-ghost btn-sm"
          style={{ fontSize: 11, padding: '1px 8px' }}
          onClick={selectNone}>None</button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text2)', margin: '2px 0 8px' }}>
        {isDwm
          ? 'Select which devices this rule will control.'
          : 'This rule will be stored on the current device and run on all selected devices.'}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {allDevices.map((d) => {
          const locked = !isDwm && d.udn === currentUdn;
          return (
            <span
              key={d.udn}
              className={`day-chip${selected.includes(d.udn) ? ' on' : ''}`}
              style={{
                padding: '5px 12px',
                opacity: locked ? 0.7 : 1,
                cursor: locked ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
              title={locked ? 'Current device (always included)' : undefined}
              onClick={() => !locked && toggle(d.udn)}
            >
              {locked ? '🏠 ' : ''}{d.friendlyName || d.name}
            </span>
          );
        })}
      </div>
      {selected.length === 0 && isDwm && (
        <p style={{ fontSize: 12, color: 'var(--danger, #e55)', marginTop: 4 }}>
          Select at least one device.
        </p>
      )}
    </div>
  );
}

// ── Main editor ───────────────────────────────────────────────────────────────

/**
 * RuleEditor — works in two modes:
 *   isDwm=true  → saves to local DWM store via createDwmRule / updateDwmRule
 *   isDwm=false → saves to Wemo device via createRule / updateRule (Wemo Rules tab)
 */
export default function RuleEditor({ rule, device, isDwm = false, onSave, onClose }) {
  const { devices }  = useDeviceStore();
  const { location } = useSettingsStore();

  const [form, setForm] = useState(() =>
    isDwm
      ? (rule ? dwmRuleToForm(rule) : {
          type: 'Schedule', name: '',
          days: ['Monday','Tuesday','Wednesday','Thursday','Friday'],
          startType: 'fixed', startTime: '07:00', startOffset: 0,
          startAction: 1,
          endType: 'fixed', endTime: '', endOffset: 0, endAction: -1,
          countdownMins: 60, countdownTime: 3600,
          windowEnabled: false, windowStartTime: '', windowEndTime: '',
          windowDays: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
          // Pre-select the sidebar device if one is selected
          deviceIds: device?.udn ? [device.udn] : [],
          targetDeviceIds: [],
          // Trigger-specific defaults
          triggerDeviceId: '', triggerEvent: 'any', triggerAction: 'on', actionDeviceIds: [],
        })
      : wemoRuleToForm(rule, device?.udn)
  );

  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');
  const [sunTimes, setSunTimes] = useState(null);

  const isEdit = !!rule;

  useEffect(() => {
    if (location) {
      window.wemoAPI.getSunTimes({ lat: location.lat, lng: location.lng })
        .then(setSunTimes).catch(() => {});
    }
  }, [location?.lat, location?.lng]);

  const validate = () => {
    if (!form.name.trim()) return 'Rule name is required.';
    if (form.type === 'Schedule' && !form.days?.length) return 'Select at least one day.';
    if (form.type === 'Schedule' && form.startType === 'fixed' && !form.startTime) return 'Start time is required.';
    if (form.type === 'Away' && !form.days?.length) return 'Select at least one day.';
    if (form.type === 'Away' && (form.startType || 'fixed') === 'fixed' && !form.startTime) return 'Window Start time is required for Away Mode.';
    if (form.type === 'Away' && (form.endType   || 'fixed') === 'fixed' && !form.endTime)   return 'Window End time is required for Away Mode.';
    if (isDwm && form.type === 'AlwaysOn' && !form.deviceIds?.length) return 'Select at least one device to keep on.';
    if (isDwm && form.type === 'Trigger'  && !form.triggerDeviceId)    return 'Select a trigger (source) device.';
    if (isDwm && form.type === 'Trigger'  && !form.actionDeviceIds?.length) return 'Select at least one action device.';
    if (isDwm && form.type !== 'AlwaysOn' && form.type !== 'Trigger' && !form.deviceIds?.length) return 'Select at least one target device.';
    const usesSun = form.startType === 'sunrise' || form.startType === 'sunset'
                 || form.endType   === 'sunrise' || form.endType   === 'sunset';
    if (usesSun && !location) {
      return 'A location is required for Sunrise/Sunset rules. Open ⚙️ Settings and search for your city.';
    }
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setSaving(true);
    setError('');
    try {
      if (isDwm) {
        await saveDwm();
      } else {
        await saveWemo();
      }
      onSave();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  /** Save DWM rule to local store. */
  const saveDwm = async () => {
    const devById = (udn) => {
      const dev = devices.find((d) => d.udn === udn);
      return dev ? { udn: dev.udn, host: dev.host, port: dev.port, name: dev.friendlyName || dev.name } : null;
    };

    // ── AlwaysOn ──────────────────────────────────────────────────────────
    if (form.type === 'AlwaysOn') {
      const targetDevices = (form.deviceIds ?? []).map(devById).filter(Boolean);
      const payload = {
        name: form.name.trim(), type: 'AlwaysOn', enabled: rule?.enabled ?? true, targetDevices,
      };
      if (isEdit) await window.wemoAPI.updateDwmRule({ id: rule.id, updates: payload });
      else        await window.wemoAPI.createDwmRule(payload);
      return;
    }

    // ── Trigger ───────────────────────────────────────────────────────────
    if (form.type === 'Trigger') {
      const triggerDevice = devById(form.triggerDeviceId);
      const actionDevices = (form.actionDeviceIds ?? []).map(devById).filter(Boolean);
      const payload = {
        name: form.name.trim(), type: 'Trigger', enabled: rule?.enabled ?? true,
        triggerDevice, triggerEvent: form.triggerEvent ?? 'any',
        action: form.triggerAction ?? 'on', actionDevices,
      };
      if (isEdit) await window.wemoAPI.updateDwmRule({ id: rule.id, updates: payload });
      else        await window.wemoAPI.createDwmRule(payload);
      return;
    }

    // ── Schedule / Countdown / Away ───────────────────────────────────────
    const targetDevices = (form.deviceIds ?? []).map(devById).filter(Boolean);

    const startTime = form.startType === 'sunrise' ? -2
                    : form.startType === 'sunset'  ? -3
                    : hhmmToSecs(form.startTime);
    const endTime   = form.endType === 'sunrise'   ? -2
                    : form.endType === 'sunset'    ? -3
                    : (form.endTime ? hhmmToSecs(form.endTime) : -1);

    const windowStart = (form.type === 'Countdown' && form.windowEnabled && form.windowStartTime)
      ? hhmmToSecs(form.windowStartTime) : -1;
    const windowEnd = (form.type === 'Countdown' && form.windowEnabled && form.windowEndTime)
      ? hhmmToSecs(form.windowEndTime) : -1;
    const windowDays = (form.type === 'Countdown' && form.windowEnabled)
      ? dayNamesToNums(form.windowDays ?? []) : [];

    const payload = {
      name:        form.name.trim(),
      type:        form.type,
      enabled:     rule?.enabled ?? true,
      days:        dayNamesToNums(form.days),
      startTime,
      endTime,
      startAction: form.startAction ?? 1,
      endAction:   form.endAction   ?? -1,
      startType:   form.startType   || 'fixed',
      endType:     form.endType     || 'fixed',
      startOffset: form.startOffset ?? 0,
      endOffset:   form.endOffset   ?? 0,
      countdownTime:   form.countdownTime   ?? 3600,
      countdownAction: form.countdownAction ?? 'on_to_off',
      windowStart,
      windowEnd,
      windowDays,
      targetDevices,
    };

    if (isEdit) {
      await window.wemoAPI.updateDwmRule({ id: rule.id, updates: payload });
    } else {
      await window.wemoAPI.createDwmRule(payload);
    }
  };

  /** Save native Wemo device rule (Wemo Rules tab / legacy). */
  const saveWemo = async () => {
    const input = {
      name:        form.name.trim(),
      type:        form.type,
      days:        form.days,
      startTime:   form.startType === 'fixed' ? form.startTime : null,
      startType:   form.startType !== 'fixed' ? form.startType : null,
      startOffset: form.startOffset || 0,
      endTime:     form.endType   === 'fixed' ? form.endTime   : null,
      endType:     form.endType   !== 'fixed' ? form.endType   : null,
      endOffset:   form.endOffset   || 0,
      startAction: form.startAction ?? 1,
      endAction:   form.endAction   ?? -1,
      countdownTime: form.countdownTime,
      deviceIds:   form.deviceIds?.length ? form.deviceIds : [device.udn],
      targetDeviceIds: form.targetDeviceIds || [],
    };
    if (isEdit) {
      const isDwmRule = rule.name.startsWith('DWM:');
      await window.wemoAPI.updateRule({ host: device.host, port: device.port, ruleId: rule.ruleId, input: { ...input, isDwm: isDwmRule } });
    } else {
      await window.wemoAPI.createRule({ host: device.host, port: device.port, input });
    }
  };

  // All devices eligible as targets — sorted alphabetically by display name
  const allRuleDevices = devices
    .filter((d) => d.supportsRules !== false)
    .sort((a, b) => (a.friendlyName || a.name || '').localeCompare(b.friendlyName || b.name || ''));
  const otherDevices   = allRuleDevices.filter((d) => d.udn !== device?.udn);

  return (
    <Modal
      title={isEdit
        ? `Edit Rule: ${(rule.name || '').replace(/^DWM:/i, '')}`
        : isDwm ? 'New DWM Rule' : 'New Wemo Rule'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving
              ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Saving…</>
              : '💾 Save Rule'}
          </button>
        </>
      }
    >
      {error && (
        <div className="notice notice-danger" style={{ marginBottom: 12 }}>
          ⚠️ {error}
        </div>
      )}

      {/* Rule name */}
      <div className="form-group">
        <label>Rule Name</label>
        <input
          autoFocus
          placeholder="e.g. Evening Lights"
          value={form.name}
          onChange={(e) => { setError(''); setForm({ ...form, name: e.target.value }); }}
          style={error && !form.name.trim() ? { borderColor: 'var(--danger, #e55)' } : {}}
        />
      </div>

      {/* Rule type */}
      {form.type === 'Long Press' ? (
        <div className="notice notice-info" style={{ marginBottom: 10 }}>
          👆 Long Press rules are managed by the device firmware and cannot be edited here.
        </div>
      ) : (
        <div className="form-group">
          <label>Rule Type</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {RULE_TYPES.map((rt) => (
              <div
                key={rt.value}
                onClick={() => setForm({ ...form, type: rt.value })}
                style={{
                  padding: '10px 14px', borderRadius: 8, cursor: 'pointer', flex: 1, minWidth: 140,
                  border: `1px solid ${form.type === rt.value ? 'var(--accent)' : 'var(--border)'}`,
                  background: form.type === rt.value ? 'rgba(0,169,213,.1)' : 'var(--card2)',
                  transition: 'all .15s',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{rt.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{rt.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Device picker — for Schedule / Countdown / Away / AlwaysOn */}
      {(form.type === 'Schedule' || form.type === 'Countdown' || form.type === 'Away' || form.type === 'AlwaysOn') && (
        isDwm
          ? allRuleDevices.length > 0 && (
              <DevicePicker
                isDwm
                currentUdn={device?.udn}
                selected={form.deviceIds || []}
                allDevices={allRuleDevices}
                onChange={(ids) => setForm({ ...form, deviceIds: ids })}
              />
            )
          : allRuleDevices.length > 1 && (
              <DevicePicker
                isDwm={false}
                currentUdn={device?.udn}
                selected={form.deviceIds || (device?.udn ? [device.udn] : [])}
                allDevices={allRuleDevices}
                onChange={(ids) => setForm({ ...form, deviceIds: ids })}
              />
            )
      )}

      {/* Trigger rule pickers */}
      {form.type === 'Trigger' && isDwm && (
        <TriggerEditor form={form} onChange={setForm} allDevices={allRuleDevices} />
      )}

      {/* Rule-type specific editors */}
      {form.type !== 'Long Press' && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 4 }}>
          {form.type === 'Schedule'  && <ScheduleEditor  form={form} onChange={setForm} sunTimes={sunTimes} />}
          {form.type === 'Countdown' && <CountdownEditor  form={form} onChange={setForm} />}
          {form.type === 'Away'      && <AwayModeEditor   form={form} onChange={setForm} sunTimes={sunTimes} />}
          {form.type === 'AlwaysOn'  && (
            <div className="notice notice-info" style={{ marginBottom: 0 }}>
              🔒 The scheduler polls this device every 10 seconds. If it's found OFF it will be turned back ON automatically. No schedule needed.
            </div>
          )}
          {form.type === 'Trigger' && !isDwm && (
            <div className="notice notice-warn">
              Trigger rules are only available as DWM rules.
            </div>
          )}
          {form.type !== 'Schedule' && form.type !== 'Countdown' && form.type !== 'Away'
            && form.type !== 'AlwaysOn' && form.type !== 'Trigger' && (
            <div className="notice notice-warn">
              Unknown rule type: <strong>{form.type}</strong>. Select a type above to edit.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
