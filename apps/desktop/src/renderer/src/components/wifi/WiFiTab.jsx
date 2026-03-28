import React, { useState, useEffect } from 'react';
import ApList from './ApList';
import NetworkStatus from './NetworkStatus';
import useSettingsStore from '../../store/settings';

const AUTH_TYPES = [
  { value: 'OPEN',    label: 'Open (no password)' },
  { value: 'WPA-PSK', label: 'WPA Personal' },
  { value: 'WPA2-PSK', label: 'WPA2 Personal' },
];

export default function WiFiTab({ device }) {
  const addToast = useSettingsStore((s) => s.addToast);

  const [networks, setNetworks]   = useState([]);
  const [scanning, setScanning]   = useState(false);
  const [ssid, setSsid]           = useState('');
  const [password, setPassword]   = useState('');
  const [auth, setAuth]           = useState('WPA2-PSK');
  const [showPass, setShowPass]   = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectResult, setConnectResult] = useState(null); // null | 'connecting' | 'success' | 'failed' | 'badpass'

  const scan = async () => {
    setScanning(true);
    setNetworks([]);
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
    try {
      await window.wemoAPI.connectHomeNetwork({
        host: device.host, port: device.port,
        ssid: ssid.trim(), password, auth,
      });
      // Poll network status
      let attempts = 0;
      const poll = async () => {
        try {
          const status = await window.wemoAPI.getNetworkStatus({ host: device.host, port: device.port });
          // 0=failed, 1=success, 2=badpass, 3=connecting
          if (status === 1) { setConnectResult('success'); return; }
          if (status === 2) { setConnectResult('badpass'); return; }
          if (status === 0) { setConnectResult('failed'); return; }
          if (attempts++ < 12) setTimeout(poll, 2500);
          else setConnectResult('failed');
        } catch {
          if (attempts++ < 12) setTimeout(poll, 2500);
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
            {connectResult === 'success' && '✅ Connected successfully!'}
            {connectResult === 'failed' && '❌ Connection failed. Check the device and try again.'}
            {connectResult === 'badpass' && '❌ Incorrect password.'}
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
    </div>
  );
}
