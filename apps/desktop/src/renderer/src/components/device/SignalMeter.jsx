import React from 'react';

/**
 * Renders 4 signal bars. dBm values: > -50 excellent, > -65 good, > -75 fair, else poor.
 */
export default function SignalMeter({ dBm }) {
  const val = parseInt(dBm, 10);
  const bars = isNaN(val) ? 0
    : val > -50 ? 4
    : val > -65 ? 3
    : val > -75 ? 2
    : 1;

  const label = isNaN(val) ? 'Unknown'
    : val > -50 ? 'Excellent'
    : val > -65 ? 'Good'
    : val > -75 ? 'Fair'
    : 'Poor';

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="signal-bars">
        {[1, 2, 3, 4].map((b) => (
          <span
            key={b}
            className={`signal-bar${b <= bars ? ' lit' : ''}`}
            style={{ height: `${b * 4}px` }}
          />
        ))}
      </span>
      <span style={{ fontSize: 12, color: 'var(--text2)' }}>
        {isNaN(val) ? '—' : `${val} dBm`}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text3)' }}>({label})</span>
    </span>
  );
}
