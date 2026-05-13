import React, { useEffect, useState } from 'react';
import useSettingsStore from '../../store/settings';

/**
 * Per-device alias manager — list of trained voice aliases with delete
 * chips and a "🎤 add voice name" button.  Records via the shared
 * window.WemoVoiceTrainer helper, persists via IPC.
 *
 * @param {object}   props
 * @param {object}   props.device        — { host, port, friendlyName, voiceAliases? }
 * @param {function} props.onAliasesChanged(newList) — optional callback after save/delete
 */
export default function VoiceAliasManager({ device, onAliasesChanged }) {
  const addToast = useSettingsStore((s) => s.addToast);
  const [aliases, setAliases]   = useState(device.voiceAliases || []);
  const [recording, setRecording] = useState(false);
  const [interim, setInterim]     = useState('');

  // Keep local state in sync if the device prop changes.
  useEffect(() => { setAliases(device.voiceAliases || []); }, [device.voiceAliases]);

  const supported = typeof window !== 'undefined' && window.WemoVoiceTrainer;

  async function trainNew() {
    if (!supported) { addToast('Voice trainer not supported in this browser.', 'warn'); return; }
    setRecording(true); setInterim('');
    try {
      const transcript = await window.WemoVoiceTrainer.recordAlias({
        maxMs: 4000,
        onInterim: (t) => setInterim(t),
      });
      if (!transcript) throw new Error('No speech heard');
      const save = window.confirm(`Heard: "${transcript}"\n\nSave as a voice name for "${device.friendlyName || device.host}"?`);
      if (save) {
        const updated = await window.wemoAPI.addVoiceAlias({
          host: device.host, port: device.port, alias: transcript,
        });
        setAliases(updated);
        if (onAliasesChanged) onAliasesChanged(updated);
        addToast(`Alias added: "${transcript}".`, 'success', 3000);
      }
    } catch (e) {
      addToast('Training failed: ' + (e.message || e), 'error');
    } finally {
      setRecording(false); setInterim('');
    }
  }

  async function removeAt(idx) {
    try {
      const updated = await window.wemoAPI.removeVoiceAlias({
        host: device.host, port: device.port, aliasIndex: idx,
      });
      setAliases(updated);
      if (onAliasesChanged) onAliasesChanged(updated);
    } catch (e) {
      addToast('Could not remove alias: ' + e.message, 'error');
    }
  }

  return (
    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {aliases.map((a, i) => (
        <span
          key={i}
          title="Voice alias"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'rgba(0,169,213,0.12)', color: 'var(--accent, #00a9d5)',
            border: '1px solid rgba(0,169,213,0.35)', borderRadius: 999,
            padding: '2px 8px', fontSize: 11, lineHeight: 1.4,
          }}
        >
          {a}
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); removeAt(i); }}
            style={{ color: '#e94560', textDecoration: 'none', fontWeight: 700 }}
            title="Remove alias"
          >×</a>
        </span>
      ))}

      <button
        type="button"
        onClick={trainNew}
        disabled={recording || !supported}
        title={supported ? 'Record a voice name for this device' : 'Voice trainer not supported'}
        style={{
          background: 'transparent', border: 'none', cursor: recording ? 'wait' : 'pointer',
          color: 'var(--accent, #00a9d5)', fontSize: 11, padding: '2px 6px',
        }}
      >
        {recording ? `🎤 listening… ${interim}` : '🎤 add voice name'}
      </button>
    </div>
  );
}
