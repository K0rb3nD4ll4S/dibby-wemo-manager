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
    </Modal>
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
