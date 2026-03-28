import React from 'react';
import useSettingsStore from '../../store/settings';

export default function Toast() {
  const { toasts, removeToast } = useSettingsStore();
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.type}`}
          onClick={() => removeToast(t.id)}
          style={{ cursor: 'pointer' }}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
