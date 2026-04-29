import React, { useEffect, useState } from 'react';
import Sidebar from './components/layout/Sidebar';
import DetailPanel from './components/layout/DetailPanel';
import Toast from './components/shared/Toast';
import Modal from './components/shared/Modal';
import useSettingsStore from './store/settings';
import useDeviceStore from './store/devices';

/* ── Settings Panel ─────────────────────────────────────────────────────── */
function SettingsPanel({ onClose }) {
  const { theme, setTheme, location, setLocation } = useSettingsStore();
  const addToast = useSettingsStore((s) => s.addToast);

  const [query, setQuery]       = useState('');
  const [results, setResults]   = useState([]);
  const [searching, setSearching] = useState(false);
  const [saveMsg, setSaveMsg]   = useState('');

  const searchLocation = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setResults([]);
    try {
      const res = await window.wemoAPI.searchLocation(query.trim());
      setResults(res || []);
      if (!res?.length) setSaveMsg('No results found.');
    } catch (e) {
      addToast(`Location search failed: ${e.message}`, 'error');
    } finally {
      setSearching(false);
    }
  };

  const pick = (r) => {
    setLocation({ lat: r.lat, lng: r.lng, label: r.label });
    window.wemoAPI.setLocation({ lat: r.lat, lng: r.lng, label: r.label });
    setSaveMsg(`Location set: ${r.label}`);
    setResults([]);
    setQuery('');
  };

  const clearLocation = () => {
    setLocation(null);
    window.wemoAPI.setLocation(null);
    setSaveMsg('Location cleared.');
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      {/* Theme */}
      <div className="form-group">
        <label>Theme</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {['dark', 'light'].map((t) => (
            <button
              key={t}
              className={`btn btn-sm ${theme === t ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setTheme(t); window.wemoAPI.setTheme(t); }}
            >
              {t === 'dark' ? '🌙 Dark' : '☀️ Light'}
            </button>
          ))}
        </div>
      </div>

      {/* Location for sun rules */}
      <div className="form-group" style={{ marginTop: 16 }}>
        <label>Location <span style={{ fontWeight: 400, color: 'var(--text3)', fontSize: 11 }}>(for Sunrise/Sunset rules)</span></label>
        {location && (
          <div style={{ marginBottom: 8 }}>
            <span className="badge badge-online" style={{ fontSize: 11 }}>
              📍 {location.label || `${location.lat}, ${location.lng}`}
            </span>
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={clearLocation}>Clear</button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            placeholder="City or address…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && searchLocation()}
            style={{ flex: 1 }}
          />
          <button className="btn btn-secondary btn-sm" onClick={searchLocation} disabled={searching || !query.trim()}>
            {searching ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} /> : '🔍 Search'}
          </button>
        </div>

        {results.length > 0 && (
          <div style={{ marginTop: 6, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            {results.slice(0, 5).map((r, i) => (
              <div
                key={i}
                onClick={() => pick(r)}
                style={{
                  padding: '8px 12px', cursor: 'pointer', fontSize: 12,
                  borderBottom: i < results.length - 1 ? '1px solid var(--border)' : 'none',
                  background: 'var(--card2)',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--hover)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'var(--card2)'}
              >
                {r.label}
              </div>
            ))}
          </div>
        )}

        {saveMsg && <div style={{ fontSize: 12, color: 'var(--accent)', marginTop: 6 }}>{saveMsg}</div>}
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
          Location is used to populate Sunrise/Sunset data on the device. The device calculates sun times independently once the location is set.
        </div>
      </div>

      {/* Embedded HomeKit Bridge */}
      <HomeKitBridgePanel />
    </Modal>
  );
}

/* ── HomeKit Bridge panel — runs in the headless DibbyWemoScheduler service ── */
function HomeKitBridgePanel() {
  const addToast = useSettingsStore((s) => s.addToast);
  const [status,  setStatus]  = useState(null);
  const [svcStat, setSvcStat] = useState(null);
  const [busy,    setBusy]    = useState(false);

  const refresh = async () => {
    try {
      const [hk, svc] = await Promise.all([
        window.wemoAPI.hkBridgeStatus(),
        window.wemoAPI.serviceStatus().catch(() => null),
      ]);
      setStatus(hk);
      setSvcStat(svc);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, []);

  if (!status) return null;

  const inService = status.mode === 'service';

  const start = async () => {
    setBusy(true);
    try { setStatus(await window.wemoAPI.hkBridgeStart()); addToast('HomeKit bridge started in app process', 'success'); }
    catch (e) { addToast(`Bridge start failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { const r = await window.wemoAPI.hkBridgeStop(); setStatus(r); addToast(r.msg || 'HomeKit bridge stopped', 'info'); }
    catch (e) { addToast(`Bridge stop failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  };
  const toggleAuto = async () => {
    setBusy(true);
    try { setStatus(await window.wemoAPI.hkBridgeSetAutostart(!status.autoStart)); }
    finally { setBusy(false); }
  };
  const resetPair = async () => {
    if (!confirm('Reset HomeKit pairings? You will need to re-add the bridge to Apple Home and re-pair from scratch. The setup code will change.')) return;
    setBusy(true);
    try { const r = await window.wemoAPI.hkBridgeResetPairings(); setStatus(r); addToast(r.msg || 'Bridge pairings reset', 'success'); }
    catch (e) { addToast(`Reset failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  };
  const installSvc = async () => {
    setBusy(true);
    try { await window.wemoAPI.serviceInstall(); addToast('Service installed and started', 'success'); refresh(); }
    catch (e) { addToast(`Service install failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  };
  const startSvc = async () => {
    setBusy(true);
    try { await window.wemoAPI.serviceStart(); addToast('Service started', 'success'); refresh(); }
    catch (e) { addToast(`Service start failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  };
  const stopSvc = async () => {
    setBusy(true);
    try { await window.wemoAPI.serviceStop(); addToast('Service stopped', 'info'); refresh(); }
    catch (e) { addToast(`Service stop failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  };
  const uninstallSvc = async () => {
    if (!confirm(
      'Uninstall the DibbyWemoScheduler service?\n\n' +
      'This will:\n' +
      '  • Stop and remove the service from Windows\n' +
      '  • Delete bridge pairing data (re-pair needed)\n' +
      '  • Delete deployed node-windows + node.exe\n\n' +
      'Your devices and DWM rules are preserved.'
    )) return;
    setBusy(true);
    try {
      await window.wemoAPI.serviceUninstall();
      addToast('Service uninstalled', 'success');
      refresh();
    } catch (e) {
      addToast(`Service uninstall failed: ${e.message}`, 'error');
    } finally { setBusy(false); }
  };

  return (
    <div className="form-group" style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <label>🏠 HomeKit Bridge <span style={{ fontWeight: 400, color: 'var(--text3)', fontSize: 11 }}>(adds every Wemo to Apple Home, regardless of native HomeKit support)</span></label>

      {/* Mode banner */}
      <div className={`notice ${inService ? 'notice-info' : 'notice-warn'}`} style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
        {inService ? (
          <>
            <strong>Headless mode</strong> — the bridge is running inside the <code>DibbyWemoScheduler</code> background service, so it stays alive after you close the desktop app and across reboots. Pair once, forget about Dibby being open.
          </>
        ) : svcStat?.installed ? (
          <>
            <strong>Service installed but not running.</strong> Start it so the bridge runs headless. As a fallback, you can start the bridge inside this desktop process — but it will stop when Dibby is closed.
          </>
        ) : (
          <>
            <strong>For the bridge to fire 24/7</strong>, install the <code>DibbyWemoScheduler</code> service. The service runs at boot under SYSTEM, hosts the bridge, and lives on after you close the desktop app. Without it, the bridge only runs while Dibby is open.
          </>
        )}
      </div>

      {/* Service install / start / stop / uninstall CTAs */}
      {svcStat && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          {!svcStat.installed && (
            <button className="btn btn-primary btn-sm" onClick={installSvc} disabled={busy}>
              ⚙ Install DibbyWemoScheduler service
            </button>
          )}
          {svcStat.installed && !svcStat.running && (
            <button className="btn btn-primary btn-sm" onClick={startSvc} disabled={busy}>
              ▶ Start service
            </button>
          )}
          {svcStat.installed && svcStat.running && (
            <button className="btn btn-secondary btn-sm" onClick={stopSvc} disabled={busy}>
              ■ Stop service
            </button>
          )}
          {svcStat.installed && (
            <button className="btn btn-ghost btn-sm" onClick={uninstallSvc} disabled={busy}
              style={{ color: 'var(--danger, #e55)', marginLeft: 'auto' }}>
              🗑 Uninstall service
            </button>
          )}
        </div>
      )}

      {/* Live status row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <span className={`badge ${status.running ? 'badge-online' : 'badge-disabled'}`} style={{ fontSize: 11 }}>
          {status.running ? `🟢 Running (${status.mode === 'service' ? 'service' : 'in-app'})` : '⚫ Stopped'}
        </span>
        {status.running && (
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>
            {status.paired
              ? `✅ Paired (${status.pairedClients} controller${status.pairedClients !== 1 ? 's' : ''})`
              : '⏳ Awaiting pairing'} · {status.accessoryCount ?? 0} accessor{status.accessoryCount === 1 ? 'y' : 'ies'}
          </span>
        )}
        {/* In-app fallback: only meaningful when service is not running */}
        {!inService && !status.running && (
          <button className="btn btn-secondary btn-sm" onClick={start} disabled={busy}>
            {busy ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} /> : '▶ Start in-app fallback'}
          </button>
        )}
        {!inService && status.running && (
          <button className="btn btn-secondary btn-sm" onClick={stop} disabled={busy}>■ Stop</button>
        )}
        <label style={{ fontSize: 12, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
          <input type="checkbox" checked={!!status.autoStart} onChange={toggleAuto} disabled={busy} />
          Auto-start
        </label>
      </div>

      {/* Pairing QR + setup code */}
      {status.running && status.qrDataURL && (
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap', marginTop: 6 }}>
          <img
            src={status.qrDataURL}
            alt="HomeKit pairing QR"
            style={{ width: 180, height: 180, background: '#fff', padding: 6, borderRadius: 6 }}
          />
          <div style={{ flex: 1, minWidth: 200, fontSize: 12, color: 'var(--text2)', lineHeight: 1.5 }}>
            <div style={{ marginBottom: 6 }}>
              On your iPhone: open <strong>Home</strong> → tap <strong>+</strong> → <strong>Add Accessory</strong> → scan this QR.
            </div>
            <div style={{ marginBottom: 6 }}>
              Manual setup code: <code style={{ fontFamily: 'monospace', background: 'var(--card2)', padding: '2px 6px', borderRadius: 3 }}>{status.pincode}</code>
            </div>
            <div style={{ color: 'var(--text3)', fontSize: 11 }}>
              Once paired, every Wemo Dibby knows about appears under the <strong>Dibby Wemo Bridge</strong> — including devices with no native HomeKit firmware. Apple Home automations can drive them, and changes to the device list are synced automatically.
            </div>
          </div>
        </div>
      )}

      {status.running && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await window.wemoAPI.hkBridgeSync(); refresh(); }} disabled={busy}>
            ↻ Sync Devices
          </button>
          <button className="btn btn-ghost btn-sm" onClick={resetPair} disabled={busy} style={{ color: 'var(--danger, #e55)' }}>
            ⚠ Reset Pairings
          </button>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8, lineHeight: 1.5 }}>
        Bridge identity (pincode + pairing trust) is stored in <code>{inService ? 'C:\\ProgramData\\DibbyWemoManager\\homekit-bridge\\' : 'app userData'}</code>. Pairing survives restarts. To re-pair from scratch, click <em>Reset Pairings</em>.
      </div>
    </div>
  );
}

/* ── App Root ────────────────────────────────────────────────────────────── */
export default function App() {
  const { setTheme, setLocation } = useSettingsStore();
  const { mergeDevice } = useDeviceStore();
  const [showSettings, setShowSettings] = useState(false);

  // Load persisted theme, location, and saved devices on startup
  useEffect(() => {
    window.wemoAPI.getTheme().then((t) => { if (t) setTheme(t); }).catch(() => {});
    window.wemoAPI.getLocation().then((l) => { if (l) setLocation(l); }).catch(() => {});
    window.wemoAPI.getSavedDevices().then((devs) => {
      if (devs?.length) devs.forEach((d) => mergeDevice(d));
    }).catch(() => {});
  }, []);

  // Listen for discovery trigger from Electron menu
  useEffect(() => {
    const off = window.wemoAPI.onTriggerDiscovery(() => {
      // Sidebar handles discovery internally — just trigger it via a custom event
      window.dispatchEvent(new CustomEvent('wemo:discover'));
    });
    return () => { if (off) off(); };
  }, []);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', position: 'relative' }}>
      <Sidebar onOpenSettings={() => setShowSettings(true)} />
      <DetailPanel />
      <Toast />
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
