import React, { useState } from 'react';

export default function NetworkStatus({ device }) {
  const [status, setStatus] = useState(null); // null | 'checking' | 'connected' | 'disconnected'

  const check = async () => {
    setStatus('checking');
    try {
      const online = await window.wemoAPI.checkOnline({ host: device.host, port: device.port });
      setStatus(online ? 'connected' : 'disconnected');
    } catch {
      setStatus('disconnected');
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {status === null && (
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>Network status unknown</span>
      )}
      {status === 'checking' && (
        <span style={{ fontSize: 12, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Checking…
        </span>
      )}
      {status === 'connected' && (
        <span className="badge badge-online" style={{ fontSize: 12 }}>● Connected</span>
      )}
      {status === 'disconnected' && (
        <span className="badge badge-offline" style={{ fontSize: 12 }}>● Disconnected</span>
      )}
      <button className="btn btn-ghost btn-sm" onClick={check} disabled={status === 'checking'}>
        {status === null ? 'Check Status' : '↺ Recheck'}
      </button>
    </div>
  );
}
