import React, { useState } from 'react';
import DeviceInfoTab from '../device/DeviceInfoTab';
import RulesTab from '../rules/RulesTab';
import WiFiTab from '../wifi/WiFiTab';
import useDeviceStore from '../../store/devices';
import useRulesStore from '../../store/rules';

const TABS = [
  { id: 'info',  label: '📋 Info' },
  { id: 'rules', label: '📅 Rules' },
  { id: 'wifi',  label: '📶 Wi-Fi' },
];

export default function DetailPanel() {
  const [activeTab, setActiveTab] = useState('info');
  const { devices, selectedUdn } = useDeviceStore();
  const clearRules = useRulesStore((s) => s.clear);

  const device = devices.find((d) => d.udn === selectedUdn);

  // Reset rules when device changes
  React.useEffect(() => {
    clearRules();
    setActiveTab('info');
  }, [selectedUdn]);

  if (!device) {
    return (
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 14, color: 'var(--text3)' }}>
        <span style={{ fontSize: 48 }}>⚡</span>
        <p style={{ fontSize: 14 }}>Select a device from the sidebar</p>
      </main>
    );
  }

  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Device header */}
      <div style={{ padding: '12px 20px 0', background: 'var(--sidebar)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{device.friendlyName}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              {device.productModel || device.modelName || 'Wemo Device'}
            </div>
          </div>
          {device.online === true  && <span className="badge badge-online" style={{ marginLeft: 'auto' }}>● Online</span>}
          {device.online === false && <span className="badge badge-offline" style={{ marginLeft: 'auto' }}>● Offline</span>}
        </div>
        <div className="tab-bar" style={{ padding: 0, background: 'transparent', borderBottom: 'none' }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab-btn${activeTab === t.id ? ' active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'info'  && <DeviceInfoTab key={device.udn} device={device} />}
        {activeTab === 'rules' && <RulesTab      device={device} />}
        {activeTab === 'wifi'  && <WiFiTab        key={device.udn} device={device} />}
      </div>
    </main>
  );
}
