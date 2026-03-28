import React, { useState } from 'react';

export default function CopyField({ label, value, mono }) {
  const [copied, setCopied] = useState(false);

  const doCopy = () => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className={`info-value${mono ? ' mono' : ''}`}>{value || '—'}</span>
      {value && (
        <button
          className="btn btn-ghost btn-icon btn-sm"
          title="Copy"
          onClick={doCopy}
          style={{ padding: '2px 6px', fontSize: 11 }}
        >
          {copied ? '✓' : '📋'}
        </button>
      )}
    </div>
  );
}
