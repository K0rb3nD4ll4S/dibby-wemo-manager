import React, { useState, useEffect } from 'react';
import CopyField from '../shared/CopyField';
import SignalMeter from './SignalMeter';
import ConfirmDialog from '../shared/ConfirmDialog';
import Modal from '../shared/Modal';
import VoiceAliasManager from '../voice/VoiceAliasManager';
import useDeviceStore from '../../store/devices';
import useSettingsStore from '../../store/settings';

export default function DeviceInfoTab({ device }) {
  const { updateDevice } = useDeviceStore();
  const addToast = useSettingsStore((s) => s.addToast);

  const [info, setInfo]         = useState(null);
  const [hkInfo, setHkInfo]     = useState(null);
  const [loading, setLoading]   = useState(false);
  const [syncing, setSyncing]   = useState(false);
  const [checking, setChecking] = useState(false);

  const [renameModal, setRenameModal] = useState(false);
  const [newName, setNewName]         = useState('');
  const [confirm, setConfirm]         = useState(null); // { action, label, code }

  useEffect(() => {
    if (!device) return;
    setInfo(null); setHkInfo(null);
    loadInfo();
  }, [device?.udn]);

  const loadInfo = async () => {
    setLoading(true);
    try {
      // Fetch the QR-bearing variant directly so we get a scannable X-HM:// QR
      // alongside the plain setup code, in a single round-trip.
      const [infoRes, hkRes] = await Promise.allSettled([
        window.wemoAPI.getDeviceInfo({ host: device.host, port: device.port }),
        window.wemoAPI.getHomekitQR({ host: device.host, port: device.port, modelName: device.modelName }),
      ]);
      if (infoRes.status === 'fulfilled') setInfo(infoRes.value);
      if (hkRes.status  === 'fulfilled') setHkInfo(hkRes.value);
    } finally {
      setLoading(false);
    }
  };

  const syncTime = async () => {
    setSyncing(true);
    try {
      const res = await window.wemoAPI.setDeviceTime({ host: device.host, port: device.port });
      addToast(`Clock synced: ${res.localISO}`, 'success');
    } catch (err) {
      addToast(`Sync failed: ${err.message}`, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const checkOnline = async () => {
    setChecking(true);
    try {
      const online = await window.wemoAPI.checkOnline({ host: device.host, port: device.port });
      updateDevice(device.udn, { online });
      addToast(online ? 'Device is online' : 'Device is offline', online ? 'success' : 'error');
    } finally {
      setChecking(false);
    }
  };

  const doRename = async () => {
    if (!newName.trim()) return;
    try {
      await window.wemoAPI.renameDevice({ host: device.host, port: device.port, name: newName.trim() });
      updateDevice(device.udn, { friendlyName: newName.trim() });
      addToast('Device renamed', 'success');
      setRenameModal(false);
    } catch (err) {
      addToast(`Rename failed: ${err.message}`, 'error');
    }
  };

  const doReset = async () => {
    if (!confirm) return;
    try {
      if (confirm.code === 1) await window.wemoAPI.resetData({ host: device.host, port: device.port });
      else if (confirm.code === 2) await window.wemoAPI.factoryReset({ host: device.host, port: device.port });
      else if (confirm.code === 5) await window.wemoAPI.resetWifi({ host: device.host, port: device.port });
      addToast(`${confirm.label} complete`, 'success');
    } catch (err) {
      addToast(`${confirm.label} failed: ${err.message}`, 'error');
    } finally {
      setConfirm(null);
    }
  };

  const combined = { ...device, ...info };

  return (
    <div style={{ padding: '16px 20px', overflowY: 'auto', height: '100%' }}>
      {/* Status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        {device.online === true  && <span className="badge badge-online">● Online</span>}
        {device.online === false && <span className="badge badge-offline">● Offline</span>}
        <button className="btn btn-secondary btn-sm" onClick={checkOnline} disabled={checking}>
          {checking ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> : '⟳'} Check Network
        </button>
        {loading && <span className="spinner" />}
      </div>

      {/* Device information */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-header">Device Information</div>

        <CopyField label="Name"    value={combined.friendlyName} />
        <CopyField label="Family"  value={combined.productModel || combined.modelDescription || combined.modelName} />
        <CopyField label="Model"   value={[combined.modelDescription, combined.modelName].filter(Boolean).join(' — ') || null} />
        <CopyField label="IP Address" value={`${device.host}:${device.port}`} mono />
        <CopyField label="UDN"     value={combined.udn} mono />
        <CopyField label="MAC Address" value={info?.macAddress} mono />
        <CopyField label="Serial Number" value={combined.serialNumber} mono />
        <CopyField label="Firmware" value={combined.firmwareVersion} mono />
        <CopyField label="Hardware" value={combined.hwVersion || info?.hwVersion || '—'} mono />

        {/* Trained voice aliases for this device — additive metadata; matched
            against live speech alongside friendlyName.  See
            apps/desktop/src/renderer/src/voice/voice-commands.js. */}
        <div className="info-row" style={{ alignItems: 'flex-start' }}>
          <span className="info-label">Voice Names</span>
          <span className="info-value" style={{ flex: 1 }}>
            <VoiceAliasManager
              device={device}
              onAliasesChanged={(list) => updateDevice(device.udn, { voiceAliases: list })}
            />
          </span>
        </div>

        <div className="info-row">
          <span className="info-label">Signal Strength</span>
          <span className="info-value">
            {info?.signalStrength
              ? <SignalMeter dBm={info.signalStrength} />
              : <span style={{ color: 'var(--text3)' }}>—</span>}
          </span>
        </div>
      </div>

      {/* Device Clock */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-header">Device Clock</div>
        <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 10 }}>
          Press Sync to push host time to the device. Required for schedule rules to fire at the correct local time.
        </p>
        <button className="btn btn-secondary btn-sm" onClick={syncTime} disabled={syncing}>
          {syncing ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Syncing…</> : '🕐 Sync Clock'}
        </button>
      </div>

      {/* HomeKit */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-header">HomeKit</div>
        {hkInfo?.setupCode
          ? <>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                {hkInfo.qrDataURL && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <img
                      src={hkInfo.qrDataURL}
                      alt={`HomeKit setup QR for ${device.friendlyName || device.name}`}
                      title="Scan with the iOS Home app to add this accessory"
                      style={{ width: 160, height: 160, background: '#fff', padding: 6, borderRadius: 6 }}
                    />
                    <span style={{ fontSize: 10, color: 'var(--text3)' }}>
                      Scan with iOS Home app
                    </span>
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 200 }}>
                  <CopyField label="Setup Code" value={hkInfo.setupCode} mono />
                  <div className="info-row">
                    <span className="info-label">Status</span>
                    <span className="info-value">{hkInfo.setupDone === '1' ? '✅ Paired' : '⏳ Not paired'}</span>
                  </div>
                  {hkInfo.setupURI && <CopyField label="Setup URI" value={hkInfo.setupURI} mono />}
                  {hkInfo.category && (
                    <div className="info-row">
                      <span className="info-label">HAP Category</span>
                      <span className="info-value">
                        {({ 5:'Lightbulb', 7:'Outlet', 8:'Switch', 10:'Sensor' }[hkInfo.category]) || `#${hkInfo.category}`}
                      </span>
                    </div>
                  )}
                  <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6, lineHeight: 1.4 }}>
                    Open the iOS <strong>Home app</strong> → tap <strong>+</strong> → <strong>Add Accessory</strong> → scan
                    this QR (or type the setup code). The device must be powered on, on the same Wi-Fi as your iPhone, and
                    not already paired to another HomeKit user.
                  </p>
                </div>
              </div>
            </>
          : <p style={{ fontSize: 13, color: 'var(--text3)' }}>HomeKit not supported on this device.</p>
        }
      </div>

      {/* Rename */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-header">Rename Device</div>
        <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 10 }}>Change this device's friendly name.</p>
        <button className="btn btn-secondary btn-sm" onClick={() => { setNewName(device.friendlyName || ''); setRenameModal(true); }}>
          ✏️ Rename…
        </button>
      </div>

      {/* Reset Options */}
      <div className="card">
        <div className="section-header">Reset Options</div>
        <div className="notice notice-warn" style={{ marginBottom: 12 }}>
          These actions cannot be undone.
          <br />
          <strong>Clear Data</strong> = name, rules, icon. &nbsp;
          <strong>Clear Wi-Fi</strong> = Wi-Fi settings only. &nbsp;
          <strong>Factory Reset</strong> = everything.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-danger btn-sm" onClick={() => setConfirm({ code: 1, label: 'Clear Data', msg: 'This will erase the device name, rules, and icon. Wi-Fi settings will be kept.' })}>
            Clear Data
          </button>
          <button className="btn btn-danger btn-sm" onClick={() => setConfirm({ code: 5, label: 'Clear Wi-Fi', msg: 'This will reset the device Wi-Fi settings only. The device will enter setup mode.' })}>
            Clear Wi-Fi
          </button>
          <button className="btn btn-danger btn-sm" onClick={() => setConfirm({ code: 2, label: 'Factory Reset', msg: 'This will completely restore the device to factory defaults. All settings, rules, and Wi-Fi configuration will be erased.' })}>
            Factory Reset
          </button>
        </div>
      </div>

      {/* Rename modal */}
      {renameModal && (
        <Modal
          title="Rename Device"
          onClose={() => setRenameModal(false)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setRenameModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={doRename}>Rename</button>
            </>
          }
        >
          <div className="form-group">
            <label>New Name</label>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doRename(); }}
              maxLength={32}
            />
          </div>
        </Modal>
      )}

      {/* Reset confirm */}
      {confirm && (
        <ConfirmDialog
          title={confirm.label}
          message={confirm.msg}
          confirmLabel={confirm.label}
          danger
          onConfirm={doReset}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
