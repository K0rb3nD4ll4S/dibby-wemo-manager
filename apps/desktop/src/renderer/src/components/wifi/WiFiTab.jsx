import React, { useState, useEffect, useRef } from 'react';
import ApList from './ApList';
import NetworkStatus from './NetworkStatus';
import useSettingsStore from '../../store/settings';

const AUTH_TYPES = [
  { value: 'OPEN',    label: 'Open (no password)' },
  { value: 'WPA-PSK', label: 'WPA Personal' },
  { value: 'WPA2-PSK', label: 'WPA2 Personal' },
];

// ---------------------------------------------------------------------------
// Log entry row — click to expand/collapse detail
// ---------------------------------------------------------------------------
const LOG_COLORS = {
  send:    'var(--accent)',
  recv:    '#4ade80',
  step:    'var(--text3)',
  error:   '#f87171',
  success: '#4ade80',
};
const LOG_ICONS = { send: '→', recv: '←', step: '⚙', error: '✕', success: '✓' };

function LogEntry({ entry }) {
  const [open, setOpen] = useState(false);
  const { type, msg, detail, ts } = entry;
  const color = LOG_COLORS[type] ?? 'var(--text1)';
  const icon  = LOG_ICONS[type]  ?? '•';
  const time  = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div style={{ lineHeight: 1.6 }}>
      <div
        style={{ display: 'flex', alignItems: 'baseline', gap: 6, cursor: detail ? 'pointer' : 'default', userSelect: 'none' }}
        onClick={() => detail && setOpen((o) => !o)}
      >
        <span style={{ color: 'var(--text3)', fontSize: 10, flexShrink: 0 }}>{time}</span>
        <span style={{ color, fontWeight: type === 'error' ? 600 : 400 }}>
          {icon} {msg}
        </span>
        {detail && (
          <span style={{ color: 'var(--text3)', fontSize: 10, marginLeft: 'auto', flexShrink: 0 }}>
            {open ? '▲' : '▼'}
          </span>
        )}
      </div>
      {open && detail && (
        <pre style={{
          margin: '2px 0 4px 22px',
          fontSize: 10,
          color: 'var(--text2)',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: '6px 8px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          overflowX: 'auto',
        }}>
          {detail}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------
export default function WiFiTab({ device }) {
  const addToast = useSettingsStore((s) => s.addToast);

  const [networks, setNetworks]       = useState([]);
  const [scanning, setScanning]       = useState(false);
  const [ssid, setSsid]               = useState('');
  const [password, setPassword]       = useState('');
  const [auth, setAuth]               = useState('WPA2-PSK');
  const [showPass, setShowPass]       = useState(false);
  const [connecting, setConnecting]   = useState(false);
  const [connectResult, setConnectResult] = useState(null);

  // WiFi diagnostic log
  const [wifiLog, setWifiLog]         = useState([]);
  const logEndRef                     = useRef(null);

  // Subscribe to main-process WiFi log events
  useEffect(() => {
    if (!window.wemoAPI?.onWifiLog) return;
    const off = window.wemoAPI.onWifiLog((entry) => {
      setWifiLog((prev) => [...prev, entry]);
    });
    return () => off();
  }, []);

  // Auto-scroll to newest entry
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [wifiLog]);

  const scan = async () => {
    setScanning(true);
    setNetworks([]);
    setWifiLog([]);   // fresh log per scan
    try {
      const res = await window.wemoAPI.getApList({ host: device.host, port: device.port });
      setNetworks(res || []);
    } catch (e) {
      addToast(`Scan failed: ${e.message}`, 'error');
    } finally {
      setScanning(false);
    }
  };

  const connect = async () => {
    if (!ssid.trim()) { addToast('Enter an SSID', 'error'); return; }
    if (auth !== 'OPEN' && !password) { addToast('Enter a password', 'error'); return; }

    setConnecting(true);
    setConnectResult('connecting');
    setWifiLog([]);   // fresh log per connect attempt
    try {
      await window.wemoAPI.connectHomeNetwork({
        host: device.host, port: device.port,
        ssid: ssid.trim(), password, auth,
      });
      // Poll network status
      // Status codes: 1=Connected, 2=Connecting (keep polling), 3=Disconnected/failed, 4=Timeout
      let attempts = 0;
      const poll = async () => {
        try {
          const status = await window.wemoAPI.getNetworkStatus({ host: device.host, port: device.port });
          if (status === '1') {
            // Connected — send CloseSetup to let device finalize and reboot onto the home network
            try { await window.wemoAPI.closeSetup({ host: device.host, port: device.port }); } catch { /* ignore */ }
            setConnectResult('success');
            return;
          }
          if (status === '3' || status === '4') { setConnectResult('badpass'); return; }
          // status 2 = still connecting, status 0 = not started yet — keep polling
          if (attempts++ < 20) setTimeout(poll, 3000);
          else setConnectResult('failed');
        } catch {
          if (attempts++ < 20) setTimeout(poll, 3000);
          else setConnectResult('failed');
        }
      };
      await poll();
    } catch (e) {
      addToast(`Connect failed: ${e.message}`, 'error');
      setConnectResult('failed');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div style={{ padding: '16px 20px', overflowY: 'auto', height: '100%' }}>
      {/* Network status header */}
      <div className="info-section" style={{ marginBottom: 20 }}>
        <div className="info-section-title">Network Status</div>
        <NetworkStatus device={device} />
      </div>

      {/* AP Scanner */}
      <div className="info-section" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div className="info-section-title" style={{ margin: 0 }}>Available Networks</div>
          <button className="btn btn-secondary btn-sm" onClick={scan} disabled={scanning}>
            {scanning
              ? <><span className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} /> Scanning…</>
              : '📡 Scan'}
          </button>
        </div>
        {networks.length > 0 || scanning ? (
          <ApList networks={networks} selected={ssid} onSelect={setSsid} />
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>Click Scan to discover nearby networks.</div>
        )}
      </div>

      {/* Connection form */}
      <div className="info-section">
        <div className="info-section-title">Connect to Network</div>

        <div className="form-group">
          <label>SSID</label>
          <input
            placeholder="Network name"
            value={ssid}
            onChange={(e) => setSsid(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>Security</label>
          <select value={auth} onChange={(e) => setAuth(e.target.value)}>
            {AUTH_TYPES.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </div>

        {auth !== 'OPEN' && (
          <div className="form-group">
            <label>Password</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type={showPass ? 'text' : 'password'}
                placeholder="Wi-Fi password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowPass(!showPass)}
                style={{ flexShrink: 0 }}
              >
                {showPass ? '🙈' : '👁'}
              </button>
            </div>
          </div>
        )}

        {connectResult && (
          <div className={`notice notice-${connectResult === 'success' ? 'info' : connectResult === 'connecting' ? 'warn' : 'danger'}`}
            style={{ marginBottom: 10 }}>
            {connectResult === 'connecting' && '⏳ Connecting to network…'}
            {connectResult === 'success'    && '✅ Connected successfully!'}
            {connectResult === 'failed'     && '❌ Connection failed. Check the device and try again.'}
            {connectResult === 'badpass'    && '❌ Incorrect password.'}
          </div>
        )}

        <button
          className="btn btn-primary"
          onClick={connect}
          disabled={connecting || !ssid.trim()}
        >
          {connecting
            ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Connecting…</>
            : '🔗 Connect'}
        </button>

        <div className="notice notice-warn" style={{ marginTop: 14 }}>
          <strong>Note:</strong> After connecting to a new network, the device will reboot and may appear offline briefly. Rediscover it after ~30 seconds.
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Real-time SOAP communication log                                    */}
      {/* ------------------------------------------------------------------ */}
      {wifiLog.length > 0 && (
        <div className="info-section" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="info-section-title" style={{ margin: 0 }}>Communication Log</div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setWifiLog([])}
              style={{ fontSize: 11 }}
            >
              Clear
            </button>
          </div>
          <div style={{
            fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
            fontSize: 11,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '8px 10px',
            maxHeight: 280,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}>
            {wifiLog.map((entry, i) => (
              <LogEntry key={i} entry={entry} />
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
