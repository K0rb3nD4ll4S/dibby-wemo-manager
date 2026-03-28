import React from 'react';

function signalBars(rssi) {
  const n = rssi >= -50 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 1, height: 14 }}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: 3 + i * 2.5,
            borderRadius: 1,
            background: i <= n ? 'var(--accent)' : 'var(--border)',
          }}
        />
      ))}
    </span>
  );
}

function securityIcon(auth) {
  if (!auth || auth === 'OPEN') return <span title="Open" style={{ fontSize: 11, color: 'var(--text3)' }}>🔓</span>;
  return <span title={auth} style={{ fontSize: 11 }}>🔒</span>;
}

export default function ApList({ networks, selected, onSelect }) {
  if (!networks || networks.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--text3)', padding: '8px 0' }}>No networks found.</div>;
  }

  const sorted = [...networks].sort((a, b) => (b.rssi ?? -100) - (a.rssi ?? -100));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
      {sorted.map((ap) => (
        <div
          key={ap.ssid + ap.bssid}
          className={`ap-item${selected === ap.ssid ? ' selected' : ''}`}
          onClick={() => onSelect(ap.ssid)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            {signalBars(ap.rssi ?? -90)}
            <span style={{ fontSize: 13, fontWeight: selected === ap.ssid ? 600 : 400 }}>{ap.ssid || '(hidden)'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {securityIcon(ap.auth)}
            {ap.rssi !== undefined && (
              <span style={{ fontSize: 11, color: 'var(--text3)', minWidth: 36, textAlign: 'right' }}>{ap.rssi} dBm</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
