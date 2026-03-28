import React, { useState, useEffect, useRef } from 'react';
import DayPicker from '../DayPicker';

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

  // Local string state so the user can type '-' without it snapping back to 0
  const [rawOffset, setRawOffset] = useState(() => String(offset ?? 0));
  const prevOffsetRef = useRef(offset);
  useEffect(() => {
    // Only sync from parent when parent actually changed the numeric value
    // (e.g. loading a saved rule), not on every keystroke
    if (offset !== prevOffsetRef.current) {
      prevOffsetRef.current = offset;
      setRawOffset(String(offset ?? 0));
    }
  }, [offset]);

  const handleOffsetChange = (e) => {
    const raw = e.target.value;
    setRawOffset(raw);
    if (raw === '' || raw === '-') return; // incomplete — wait for more input
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
          <span><span className="lbl">Today's {type}: </span><span className="val">{secsToHHMM(previewSecs)}</span></span>
          <span>
            <span className="lbl">Fires at: </span>
            <span className="val">{secsToHHMM(previewWithOffset)}</span>
            {offset !== 0 && <span style={{ color: 'var(--text3)', fontSize: 11 }}> ({offset > 0 ? '+' : ''}{offset} min)</span>}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>📍 Coordinates synced to device on save</span>
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

export default function ScheduleEditor({ form, onChange, sunTimes }) {
  return (
    <>
      <div className="form-group">
        <label>Days</label>
        <DayPicker selected={form.days || []} onChange={(days) => onChange({ ...form, days })} />
      </div>

      <SunTimeField
        label="Start Time"
        type={form.startType} offset={form.startOffset} time={form.startTime}
        onTypeChange={(v) => onChange({ ...form, startType: v })}
        onOffsetChange={(v) => onChange({ ...form, startOffset: v })}
        onTimeChange={(v) => onChange({ ...form, startTime: v })}
        sunTimes={sunTimes}
      />

      <div className="form-group">
        <label>Start Action</label>
        <select value={form.startAction ?? 1} onChange={(e) => onChange({ ...form, startAction: parseFloat(e.target.value) })}>
          <option value={1}>Turn ON</option>
          <option value={0}>Turn OFF</option>
          <option value={2}>Toggle</option>
        </select>
      </div>

      <SunTimeField
        label="End Time (optional)"
        type={form.endType} offset={form.endOffset} time={form.endTime}
        onTypeChange={(v) => onChange({ ...form, endType: v })}
        onOffsetChange={(v) => onChange({ ...form, endOffset: v })}
        onTimeChange={(v) => onChange({ ...form, endTime: v })}
        sunTimes={sunTimes}
      />

      {(form.endTime || form.endType === 'sunrise' || form.endType === 'sunset') && (
        <div className="form-group">
          <label>End Action</label>
          <select value={form.endAction ?? -1} onChange={(e) => onChange({ ...form, endAction: parseFloat(e.target.value) })}>
            <option value={-1}>None</option>
            <option value={0}>Turn OFF</option>
            <option value={1}>Turn ON</option>
          </select>
        </div>
      )}
    </>
  );
}
