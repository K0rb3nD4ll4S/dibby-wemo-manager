import React from 'react';
import DayPicker from '../DayPicker';

export default function CountdownEditor({ form, onChange }) {
  const mins           = form.countdownMins  ?? 60;
  const windowEnabled  = form.windowEnabled  ?? false;
  const windowStartTime = form.windowStartTime ?? '';
  const windowEndTime   = form.windowEndTime   ?? '';
  const windowDays      = form.windowDays      ?? ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

  // Determine if window crosses midnight (end time earlier in the day than start time)
  function crossesMidnight() {
    if (!windowStartTime || !windowEndTime) return false;
    const [sh, sm] = windowStartTime.split(':').map(Number);
    const [eh, em] = windowEndTime.split(':').map(Number);
    return eh * 60 + em < sh * 60 + sm;
  }

  return (
    <>
      <div className="notice notice-info">
        The device automatically turns off after the countdown completes.
        The countdown starts when the device is manually turned on (or at window start, if an active window is set below).
      </div>

      {/* Countdown duration */}
      <div className="form-group">
        <label>Turn off after (minutes)</label>
        <input
          type="number" min="1" max="1440"
          value={mins}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10) || 60;
            onChange({ ...form, countdownMins: v, countdownTime: v * 60 });
          }}
        />
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
          {mins >= 60
            ? `${Math.floor(mins / 60)}h${mins % 60 > 0 ? ` ${mins % 60}m` : ''}`
            : `${mins} minutes`}
        </div>
      </div>

      {/* Active window toggle */}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: windowEnabled ? 12 : 0 }}>
          <label className="toggle" title={windowEnabled ? 'Disable active window' : 'Enable active window'}>
            <input type="checkbox" checked={windowEnabled}
              onChange={(e) => onChange({ ...form, windowEnabled: e.target.checked })} />
            <span className="toggle-track" />
            <span className="toggle-thumb" />
          </label>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Active Window</span>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            — restrict this rule to specific hours
          </span>
        </div>

        {windowEnabled && (
          <>
            <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12 }}>
              The scheduler will turn the device <strong>ON</strong> at the window start and
              <strong> OFF</strong> at the window end. The countdown auto-off fires in between.
              Use this to prevent the timer rule conflicting with other rules outside these hours.
            </p>

            {/* Window times */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
              <div className="form-group" style={{ flex: 1, minWidth: 140, margin: 0 }}>
                <label>Window Start</label>
                <input
                  type="time"
                  value={windowStartTime}
                  onChange={(e) => onChange({ ...form, windowStartTime: e.target.value })}
                />
              </div>
              <div className="form-group" style={{ flex: 1, minWidth: 140, margin: 0 }}>
                <label>Window End</label>
                <input
                  type="time"
                  value={windowEndTime}
                  onChange={(e) => onChange({ ...form, windowEndTime: e.target.value })}
                />
              </div>
            </div>

            {/* Cross-midnight hint */}
            {windowStartTime && windowEndTime && crossesMidnight() && (
              <div className="notice notice-info" style={{ marginBottom: 12, fontSize: 12 }}>
                🌙 Window crosses midnight — ends at <strong>{windowEndTime}</strong> the <strong>next day</strong>.
                The OFF command fires on the following calendar day.
              </div>
            )}

            {/* Window days */}
            <div className="form-group">
              <label>Active Days</label>
              <DayPicker
                selected={windowDays}
                onChange={(days) => onChange({ ...form, windowDays: days })}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}
