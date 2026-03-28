import React from 'react';
import PowerButton from './PowerButton';
import useDeviceStore from '../../store/devices';

const ICONS = {
  lightswitch: '💡',
  dimmer: '🔆',
  insight: '⚡',
  socket: '🔌',
  sensor: '👁',
  bridge: '🌉',
  default: '🔌',
};

function deviceIcon(udn = '') {
  const t = udn.replace(/^uuid:/i, '').split('-')[0].toLowerCase();
  return ICONS[t] ?? ICONS.default;
}

export default function DeviceCard({ device }) {
  const { selectedUdn, selectDevice, updateDevice } = useDeviceStore();
  const isSelected = selectedUdn === device.udn;

  const handleToggle = async (on) => {
    await window.wemoAPI.setDeviceState({ host: device.host, port: device.port, on });
    updateDevice(device.udn, { on });
  };

  const onlineBadge = device.online === true
    ? <span className="badge badge-online">● Online</span>
    : device.online === false
    ? <span className="badge badge-offline">● Offline</span>
    : null;

  return (
    <div
      className={`device-card${isSelected ? ' selected' : ''}`}
      onClick={() => selectDevice(device.udn)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px', cursor: 'pointer', borderRadius: 8,
        border: '1px solid ' + (isSelected ? 'var(--accent)' : 'transparent'),
        background: isSelected ? 'rgba(0,169,213,.08)' : 'transparent',
        transition: 'all .15s',
        marginBottom: 2,
      }}
    >
      <span style={{ fontSize: 22, flexShrink: 0 }}>{deviceIcon(device.udn)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {device.friendlyName || 'Unknown Device'}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
          {device.host}:{device.port}
          {onlineBadge && <span style={{ marginLeft: 6 }}>{onlineBadge}</span>}
        </div>
      </div>
      <PowerButton device={device} onToggle={handleToggle} />
    </div>
  );
}
