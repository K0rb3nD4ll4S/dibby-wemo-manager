import React, { useState, useEffect, useRef } from 'react';
import DayPicker from '../DayPicker';

// ── Inline SunTimeField (same as ScheduleEditor) ──────────────────────────────

function secsToHHMM(secs) {
  if (!secs && secs !== 0) return '';
  const totalMins = Math.floor(Math.abs(secs) / 60);
  const h24 = Math.floor(totalMins / 60) % 24;
  const m   = totalMins % 60;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const h12  = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function SunTimeField({ label, type, offset, time, onTypeChange, onOffsetChange, onTimeChange, sunTimes }) {
  const isSun = type === 'sunrise' || type === 'sunset';
  const previewSecs = isSun && sunTimes
    ? (type === 'sunrise' ? sunTimes.sunrise : sunTimes.sunset)
    : null;
  const previewWithOffset = previewSecs !== null
    ? previewSecs + (offset || 0) * 60
    : null;

  const [rawOffset, setRawOffset] = useState(() => String(offset ?? 0));
  const prevOffsetRef = useRef(offset);
  useEffect(() => {
    if (offset !== prevOffsetRef.current) {
      prevOffsetRef.current = offset;
      setRawOffset(String(offset ?? 0));
    }
  }, [offset]);

  const handleOffsetChange = (e) => {
    const raw = e.target.value;
    setRawOffset(raw);
    if (raw === '' || raw === '-') return;
    const n = parseInt(raw, 10);
    if (!isNaN(n)) {
      prevOffsetRef.current = n;
      onOffsetChange(n);
    }
  };

  const handleOffsetBlur = () => {
    const n = parseInt(rawOffset, 10);
    const final = isNaN(n) ? 0 : n;
    setRawOffset(String(final));
    prevOffsetRef.current = final;
    onOffsetChange(final);
  };

  return (
    <div className="form-group">
      <label>{label}</label>
      <div className="form-row" style={{ marginBottom: 6 }}>
        <select value={type || 'fixed'} onChange={(e) => onTypeChange(e.target.value)}>
          <option value="fixed">Fixed Time</option>
          <option value="sunrise">Sunrise</option>
          <option value="sunset">Sunset</option>
        </select>
        {isSun ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="number" placeholder="0"
              value={rawOffset}
              onChange={handleOffsetChange}
              onBlur={handleOffsetBlur}
              style={{ width: 70 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
              min (+ after, − before)
            </span>
          </div>
        ) : (
          <input type="time" value={time || ''} onChange={(e) => onTimeChange(e.target.value)} />
        )}
      </div>
      {isSun && previewWithOffset !== null && (
        <div className="sun-preview">
          <span>
            <span className="lbl">Today's {type}: </span>
            <span className="val">{secsToHHMM(previewSecs)}</span>
          </span>
          <span>
            <span className="lbl">Window {label.includes('Start') ? 'opens' : 'closes'}: </span>
            <span className="val">{secsToHHMM(previewWithOffset)}</span>
            {offset !== 0 && (
              <span style={{ color: 'var(--text3)', fontSize: 11 }}>
                {' '}({offset > 0 ? '+' : ''}{offset} min)
              </span>
            )}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>
            📍 Coordinates synced to device on save
          </span>
        </div>
      )}
      {isSun && !sunTimes && (
        <div className="notice notice-warn" style={{ marginTop: 6, marginBottom: 0 }}>
          ⚠️ No location set — open <strong>⚙️ Settings</strong> and search for your city.
          The device needs your coordinates to calculate {type} times.
        </div>
      )}
    </div>
  );
}

// ── AwayModeEditor ────────────────────────────────────────────────────────────

export default function AwayModeEditor({ form, onChange, sunTimes }) {
  // Cross-midnight detection (fixed times only)
  function crossesMidnight() {
    if (!form.startTime || !form.endTime) return false;
    if ((form.startType || 'fixed') !== 'fixed' || (form.endType || 'fixed') !== 'fixed') return false;
    const [sh, sm] = form.startTime.split(':').map(Number);
    const [eh, em] = form.endTime.split(':').map(Number);
    return eh * 60 + em < sh * 60 + sm;
  }

  return (
    <>
      <div className="notice notice-info" style={{ marginBottom: 14 }}>
        <strong>Away Mode</strong> — simulates occupancy by randomly turning devices{' '}
        <strong>on</strong> (30–90 min) then <strong>off</strong> (1–15 min) within your
        configured window. The DWM scheduler handles all randomisation while the app is running.
      </div>

      {/* Start / End action */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 4 }}>
        <div className="form-group" style={{ flex: 1 }}>
          <label>Window Start Action</label>
          <select
            value={form.startAction ?? 1}
            onChange={(e) => onChange({ ...form, startAction: Number(e.target.value) })}
          >
            <option value={1}>Turn ON</option>
            <option value={0}>Turn OFF</option>
          </select>
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label>Window End Action</label>
          <select
            value={form.endAction ?? 0}
            onChange={(e) => onChange({ ...form, endAction: Number(e.target.value) })}
          >
            <option value={0}>Turn OFF</option>
            <option value={1}>Turn ON</option>
          </select>
        </div>
      </div>

      {/* Active days */}
      <div className="form-group">
        <label>Active Days</label>
        <DayPicker
          selected={form.days || []}
          onChange={(days) => onChange({ ...form, days })}
        />
      </div>

      {/* Window start */}
      <SunTimeField
        label="Window Start"
        type={form.startType || 'fixed'}
        offset={form.startOffset ?? 0}
        time={form.startTime || ''}
        onTypeChange={(v) => onChange({ ...form, startType: v })}
        onOffsetChange={(v) => onChange({ ...form, startOffset: v })}
        onTimeChange={(v) => onChange({ ...form, startTime: v })}
        sunTimes={sunTimes}
      />

      {/* Window end */}
      <SunTimeField
        label="Window End"
        type={form.endType || 'fixed'}
        offset={form.endOffset ?? 0}
        time={form.endTime || ''}
        onTypeChange={(v) => onChange({ ...form, endType: v })}
        onOffsetChange={(v) => onChange({ ...form, endOffset: v })}
        onTimeChange={(v) => onChange({ ...form, endTime: v })}
        sunTimes={sunTimes}
      />

      {/* Cross-midnight hint */}
      {crossesMidnight() && (
        <div className="notice notice-info" style={{ marginBottom: 12, fontSize: 12 }}>
          🌙 Window crosses midnight — ends at <strong>{form.endTime}</strong> the{' '}
          <strong>next day</strong>.
        </div>
      )}
    </>
  );
}
