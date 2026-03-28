import React, { useState, useEffect } from 'react';
import DeviceCard from '../device/DeviceCard';
import Modal from '../shared/Modal';
import useDeviceStore from '../../store/devices';
import useSettingsStore from '../../store/settings';

export default function Sidebar({ onOpenSettings }) {
  const { devices, discovering, deviceOrder, deviceGroups, setDiscovering, mergeDevice } = useDeviceStore();
  const addToast = useSettingsStore((s) => s.addToast);

  // ── In-process scheduler (legacy — kept for upcoming-fires panel) ─────────
  const [schedulerRunning,  setSchedulerRunning]  = useState(false);
  const [schedulerStarting, setSchedulerStarting] = useState(false);
  const [schedulerUpcoming, setSchedulerUpcoming] = useState([]);
  const [showSchedulePanel, setShowSchedulePanel] = useState(false);

  useEffect(() => {
    const offFired = window.wemoAPI.onSchedulerFired((ev) => {
      addToast(`⏱ ${ev.msg}`, ev.success ? 'success' : 'error', 6000);
    });
    const offStatus = window.wemoAPI.onSchedulerStatus((s) => {
      setSchedulerRunning(s.running);
      setSchedulerUpcoming(s.upcoming ?? []);
    });
    window.wemoAPI.schedulerStatus().then((s) => {
      setSchedulerRunning(s.running);
      setSchedulerUpcoming(s.upcoming ?? []);
    }).catch(() => {});
    return () => { offFired(); offStatus(); };
  }, []);

  const toggleScheduler = async () => {
    if (schedulerRunning) {
      await window.wemoAPI.schedulerStop();
      setSchedulerRunning(false);
      setSchedulerUpcoming([]);
      addToast('Scheduler stopped', 'info');
      return;
    }
    if (devices.length === 0) { addToast('Discover devices first', 'warn'); return; }
    setSchedulerStarting(true);
    try {
      const status = await window.wemoAPI.schedulerStart({ devices });
      setSchedulerRunning(true);
      setSchedulerUpcoming(status.upcoming ?? []);
      addToast(`Scheduler running — ${status.totalEntries} actions loaded`, 'success', 6000);
    } catch (e) {
      addToast(`Scheduler failed: ${e.message}`, 'error');
    } finally {
      setSchedulerStarting(false);
    }
  };

  // ── Windows Service ───────────────────────────────────────────────────────
  const [svcStatus,   setSvcStatus]   = useState(null);   // null | {installed,running,status}
  const [svcWorking,  setSvcWorking]  = useState(false);
  const [showSvcPanel, setShowSvcPanel] = useState(false);

  const refreshSvcStatus = () => {
    window.wemoAPI.serviceStatus().then(setSvcStatus).catch(() => setSvcStatus(null));
  };

  useEffect(() => { refreshSvcStatus(); }, []);

  const svcInstall = async () => {
    if (devices.length === 0) { addToast('Discover devices first so the service knows what to control', 'warn'); return; }
    setSvcWorking(true);
    try {
      // Push device list to ProgramData before installing
      await window.wemoAPI.syncDevicesToService(devices);
      const res = await window.wemoAPI.serviceInstall();
      addToast(`✅ ${res.msg}`, 'success', 8000);
      setTimeout(refreshSvcStatus, 3000);
    } catch (e) {
      addToast(`Service install failed: ${e.message}`, 'error', 10000);
    } finally { setSvcWorking(false); }
  };

  const svcUninstall = async () => {
    setSvcWorking(true);
    try {
      const res = await window.wemoAPI.serviceUninstall();
      addToast(res.msg, 'info');
      setTimeout(refreshSvcStatus, 3000);
    } catch (e) {
      addToast(`Service uninstall failed: ${e.message}`, 'error');
    } finally { setSvcWorking(false); }
  };

  const svcStartStop = async () => {
    setSvcWorking(true);
    try {
      const res = svcStatus?.running
        ? await window.wemoAPI.serviceStop()
        : await window.wemoAPI.serviceStart();
      addToast(res.msg, 'info');
      setTimeout(refreshSvcStatus, 3000);
    } catch (e) {
      addToast(`Service error: ${e.message}`, 'error');
    } finally { setSvcWorking(false); }
  };

  const discover = async () => {
    setDiscovering(true);
    try {
      const found = await window.wemoAPI.discoverDevices({ timeout: 6000 });
      found.forEach((d) => mergeDevice(d));
      await window.wemoAPI.saveDevices(useDeviceStore.getState().devices);
      if (found.length === 0) addToast('No new devices found', 'info');
      else addToast(`Found ${found.length} device${found.length > 1 ? 's' : ''}`, 'success');
    } catch (e) {
      addToast(`Discovery failed: ${e.message}`, 'error');
    } finally {
      setDiscovering(false);
    }
  };

  // Listen for discovery trigger from Electron menu or App
  useEffect(() => {
    const handler = () => discover();
    window.addEventListener('wemo:discover', handler);
    return () => window.removeEventListener('wemo:discover', handler);
  }, []);
  const [manualModal, setManualModal] = useState(false);
  const [manualHost, setManualHost]   = useState('');
  const [manualPort, setManualPort]   = useState('49153');

  // Sort devices by custom order
  const sortedDevices = [...devices].sort((a, b) => {
    const ia = deviceOrder.indexOf(a.udn);
    const ib = deviceOrder.indexOf(b.udn);
    if (ia === -1 && ib === -1) return (a.friendlyName || '').localeCompare(b.friendlyName || '');
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  // Group devices
  const grouped = new Map();
  grouped.set('__ungrouped__', []);
  for (const g of deviceGroups) grouped.set(g.name, []);

  for (const device of sortedDevices) {
    const group = deviceGroups.find((g) => g.udns?.includes(device.udn));
    grouped.get(group ? group.name : '__ungrouped__').push(device);
  }

  const addManual = async () => {
    if (!manualHost.trim()) return;
    try {
      const result = await window.wemoAPI.discoverDevices({
        manualEntries: [{ host: manualHost.trim(), port: parseInt(manualPort, 10) || 49153 }],
        timeout: 5000,
      });
      if (result.length === 0) {
        addToast('No device found at that address', 'error');
        return;
      }
      const { mergeDevice, saveDevices, devices: devs } = useDeviceStore.getState();
      result.forEach((d) => mergeDevice({ ...d, manual: true }));
      const allDevs = useDeviceStore.getState().devices;
      await window.wemoAPI.saveDevices(allDevs);
      addToast(`Added ${result[0].friendlyName}`, 'success');
      setManualModal(false);
    } catch (err) {
      addToast(`Failed: ${err.message}`, 'error');
    }
  };

  const renderGroup = (name, devs) => {
    if (devs.length === 0) return null;
    return (
      <div key={name} style={{ marginBottom: 8 }}>
        {name !== '__ungrouped__' && (
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase',
            color: 'var(--text3)', padding: '8px 12px 4px' }}>
            {name}
          </div>
        )}
        {devs.map((d) => <DeviceCard key={d.udn} device={d} />)}
      </div>
    );
  };

  return (
    <aside style={{ width: 'var(--sidebar-w)', minWidth: 'var(--sidebar-w)', background: 'var(--sidebar)',
      borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 20 }}>⚡</span>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Dibby Wemo Manager</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="btn btn-primary btn-sm"
            style={{ flex: 1 }}
            onClick={discover}
            disabled={discovering}
          >
            {discovering
              ? <><span className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} /> Scanning…</>
              : '🔍 Discover'}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            title="Add device manually"
            onClick={() => setManualModal(true)}
          >
            +
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="Settings"
            onClick={onOpenSettings}
          >
            ⚙️
          </button>
        </div>

        {/* Scheduler section */}
        <div style={{ marginTop: 8 }}>

          {/* Windows Service row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            {/* Status dot + label */}
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1, cursor: 'pointer',
                fontSize: 12, color: 'var(--text2)' }}
              onClick={() => setShowSvcPanel((v) => !v)}
              title="Windows Service — runs at boot, no login required"
            >
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
                background: svcStatus?.running ? '#4caf50' : svcStatus?.installed ? '#ff9800' : '#666',
                boxShadow: svcStatus?.running ? '0 0 5px #4caf50' : 'none',
              }} />
              <span>
                {svcStatus === null ? 'Service: checking…'
                  : svcStatus.running ? 'Service: running'
                  : svcStatus.installed ? 'Service: stopped'
                  : 'Service: not installed'}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 10 }}>{showSvcPanel ? '▲' : '▼'}</span>
            </div>
          </div>

          {/* Service management panel */}
          {showSvcPanel && (
            <div style={{ background: 'var(--bg2)', borderRadius: 6, padding: '8px 10px',
              marginBottom: 6, fontSize: 12 }}>
              <div style={{ color: 'var(--text3)', marginBottom: 6, lineHeight: 1.4 }}>
                {svcStatus?.installed
                  ? 'Runs at boot under SYSTEM — no user login needed.'
                  : 'Install once to run rules at boot — no login required.'}
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {!svcStatus?.installed ? (
                  <button className="btn btn-primary btn-sm" onClick={svcInstall} disabled={svcWorking}
                    style={{ flex: 1 }}>
                    {svcWorking ? <><span className="spinner" style={{ width: 9, height: 9, borderWidth: 2 }} /> Working…</> : '⬆ Install Service'}
                  </button>
                ) : (
                  <>
                    <button className="btn btn-secondary btn-sm" onClick={svcStartStop} disabled={svcWorking}
                      style={{ flex: 1 }}>
                      {svcWorking ? <><span className="spinner" style={{ width: 9, height: 9, borderWidth: 2 }} /> …</>
                        : svcStatus?.running ? '⏹ Stop' : '▶ Start'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={svcUninstall} disabled={svcWorking}>
                      🗑 Remove
                    </button>
                  </>
                )}
                <button className="btn btn-ghost btn-sm" onClick={refreshSvcStatus} title="Refresh status">↻</button>
              </div>
              {/* Sync device list to service */}
              {svcStatus?.installed && (
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 5, width: '100%', fontSize: 11 }}
                  onClick={async () => {
                    if (!devices.length) { addToast('No devices to sync', 'warn'); return; }
                    await window.wemoAPI.syncDevicesToService(devices);
                    addToast(`Synced ${devices.length} device(s) to service`, 'success');
                  }}>
                  🔄 Sync device list to service
                </button>
              )}
            </div>
          )}

          {/* In-process scheduler bar (fallback / testing) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              className={`btn btn-sm ${schedulerRunning ? 'btn-success' : 'btn-secondary'}`}
              style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}
              onClick={toggleScheduler}
              disabled={schedulerStarting}
              title="In-process scheduler — only runs while this window is open"
            >
              {schedulerStarting
                ? <><span className="spinner" style={{ width: 9, height: 9, borderWidth: 2 }} /> Starting…</>
                : schedulerRunning
                  ? <><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#4caf50',
                      display: 'inline-block', flexShrink: 0 }} /> In-app sched. ON</>
                  : '⏱ In-app sched. OFF'}
            </button>
            {schedulerRunning && schedulerUpcoming.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowSchedulePanel((v) => !v)}
                style={{ padding: '3px 7px' }} title="View upcoming fires">
                {showSchedulePanel ? '▲' : '▼'}
              </button>
            )}
          </div>

          {/* Upcoming fires */}
          {showSchedulePanel && schedulerRunning && schedulerUpcoming.length > 0 && (
            <div style={{ marginTop: 5, background: 'var(--bg2)', borderRadius: 6,
              padding: '6px 8px', fontSize: 11, color: 'var(--text2)' }}>
              <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text1)' }}>Next fires today:</div>
              {schedulerUpcoming.map((f, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    maxWidth: '65%', color: 'var(--text1)' }}>{f.ruleName}</span>
                  <span style={{ color: f.action === 'ON' ? '#4caf50' : '#ff7043', flexShrink: 0 }}>
                    {f.at} {f.action}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Device list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
        {devices.length === 0 && !discovering && (
          <div className="empty-state" style={{ padding: '30px 16px' }}>
            <span className="empty-state-icon">📡</span>
            <p>No devices found.<br />Click Discover to scan your network.</p>
          </div>
        )}
        {[...grouped.entries()].map(([name, devs]) => renderGroup(name, devs))}
      </div>

      {/* Manual add modal */}
      {manualModal && (
        <Modal
          title="Add Device Manually"
          onClose={() => setManualModal(false)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setManualModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={addManual}>Add</button>
            </>
          }
        >
          <div className="form-group">
            <label>IP Address</label>
            <input autoFocus placeholder="192.168.1.100" value={manualHost} onChange={(e) => setManualHost(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Port</label>
            <input type="number" placeholder="49153" value={manualPort} onChange={(e) => setManualPort(e.target.value)} />
          </div>
        </Modal>
      )}
    </aside>
  );
}
