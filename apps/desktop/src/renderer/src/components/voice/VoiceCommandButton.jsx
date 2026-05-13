import React, { useEffect, useRef, useState } from 'react';
import useDeviceStore from '../../store/devices';
import useSettingsStore from '../../store/settings';

/**
 * Top-bar mic button — toggles continuous voice-command listening for
 * the desktop renderer.
 *
 * Uses the shared window.WemoVoice library bootstrapped in main.jsx
 * (apps/desktop/src/renderer/src/voice/voice-commands.js).  Dispatch goes
 * through window.wemoAPI.setDeviceState() so IPC stays the single source
 * of truth for device control.
 */
export default function VoiceCommandButton({ wakeWord = 'dibby' }) {
  const devices  = useDeviceStore((s) => s.devices);
  const addToast = useSettingsStore((s) => s.addToast);

  const [running,   setRunning]   = useState(false);
  const [transcript, setTranscript] = useState('');
  const commanderRef = useRef(null);

  // Track the latest device list in a ref so the parser always sees fresh data
  // even though VoiceCommander is constructed once.
  const devicesRef = useRef(devices);
  useEffect(() => { devicesRef.current = devices; }, [devices]);

  // Feature-detect once on mount; if unsupported, the button renders disabled.
  const supported = typeof window !== 'undefined' && window.WemoVoice?.isSupported?.();

  useEffect(() => {
    if (!supported) return undefined;
    const cmd = new window.WemoVoice.VoiceCommander({
      getDevices: () => devicesRef.current,
      wakeWord,
      continuous: true,
    });

    cmd.onStateChange((r) => { setRunning(r); if (!r) setTranscript(''); });
    cmd.onTranscript((text, isFinal) => setTranscript(isFinal ? '✓ ' + text : text));

    cmd.onIntent(async (intent) => {
      try {
        if (intent.kind === 'bulk') {
          for (const d of devicesRef.current) {
            try { await window.wemoAPI.setDeviceState({ host: d.host, port: d.port, on: intent.on }); } catch {}
          }
          addToast(`All devices ${intent.on ? 'on' : 'off'}.`, 'success', 3000);
        } else if (intent.kind === 'set') {
          await window.wemoAPI.setDeviceState({ host: intent.device.host, port: intent.device.port, on: intent.on });
          addToast(`${intent.device.friendlyName || intent.device.host} → ${intent.on ? 'on' : 'off'}` +
            (intent.source === 'alias' ? ` (alias "${intent.alias}")` : ''), 'success', 3000);
        } else if (intent.kind === 'toggle') {
          let target = true;
          try {
            const cur = await window.wemoAPI.getDeviceState({ host: intent.device.host, port: intent.device.port });
            target = !cur;
          } catch {}
          await window.wemoAPI.setDeviceState({ host: intent.device.host, port: intent.device.port, on: target });
          addToast(`${intent.device.friendlyName || intent.device.host} → ${target ? 'on' : 'off'}`, 'success', 3000);
        } else if (intent.kind === 'no-match') {
          addToast(`Didn't recognise: "${intent.spoken}"`, 'warn', 3000);
        }
      } catch (e) {
        addToast(`Voice command failed: ${e.message}`, 'error');
      }
    });

    cmd.onError((err) => {
      const name = typeof err === 'string' ? err : (err?.error || err?.message || '');
      if (name && name !== 'no-speech' && name !== 'aborted') addToast(`Voice: ${name}`, 'warn');
    });

    commanderRef.current = cmd;
    return () => { try { cmd.stop(); } catch {} };
  }, [supported, wakeWord, addToast]);

  // One-time privacy disclosure, persisted across launches.
  const ackKey = 'dwm.voice.privacyAck';
  function askPrivacy() {
    if (localStorage.getItem(ackKey) === '1') return true;
    const ok = window.confirm(
      'Voice commands use your browser\'s built-in speech recognition.\n\n' +
      'Chrome and Edge stream audio to Google/Microsoft to transcribe it; ' +
      'Safari uses on-device recognition.\n\n' +
      'Dibby Wemo never records, stores, or transmits audio itself.\n\n' +
      'Click OK to enable voice commands.'
    );
    if (ok) localStorage.setItem(ackKey, '1');
    return ok;
  }

  function toggle() {
    if (!commanderRef.current) return;
    if (commanderRef.current.isRunning()) return commanderRef.current.stop();
    if (!askPrivacy()) return;
    commanderRef.current.start();
  }

  if (!supported) {
    return (
      <button className="btn btn-ghost btn-sm" disabled title="Voice not supported in this browser">
        🎤
      </button>
    );
  }

  return (
    <>
      <button
        className={'btn btn-sm ' + (running ? 'btn-danger' : 'btn-ghost')}
        title={running ? 'Stop listening' : `Start voice commands ("${wakeWord} turn on …")`}
        onClick={toggle}
        style={running ? { animation: 'voicePulse 1.4s ease-out infinite' } : undefined}
      >
        🎤
      </button>
      {running && transcript ? (
        <div style={{
          position: 'absolute', top: 56, left: 12, right: 12, zIndex: 50,
          padding: '8px 12px', background: 'var(--card, #1f2937)',
          color: 'var(--text, #e5e7eb)', borderLeft: '4px solid #e94560',
          borderRadius: 6, fontSize: 12, fontStyle: 'italic',
          boxShadow: '0 4px 14px rgba(0,0,0,0.35)'
        }}>
          {transcript}
        </div>
      ) : null}
    </>
  );
}
