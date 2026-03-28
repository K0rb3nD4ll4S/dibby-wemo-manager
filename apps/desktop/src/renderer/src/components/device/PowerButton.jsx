import React, { useState } from 'react';
import useSettingsStore from '../../store/settings';

export default function PowerButton({ device, onToggle }) {
  const [busy, setBusy] = useState(false);
  const addToast = useSettingsStore((s) => s.addToast);
  const on = !!device?.on;

  const toggle = async (e) => {
    e.stopPropagation();
    if (busy || !device) return;
    setBusy(true);
    try {
      await onToggle(!on);
    } catch (err) {
      addToast(`Toggle failed: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className={`power-btn ${on ? 'on' : 'off'}`}
      onClick={toggle}
      disabled={busy}
      title={on ? 'Turn Off' : 'Turn On'}
    >
      {busy
        ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
        : <span className={`power-dot ${on ? 'on' : ''}`} />}
    </button>
  );
}
