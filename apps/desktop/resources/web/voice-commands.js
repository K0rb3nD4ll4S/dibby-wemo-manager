/* ──────────────────────────────────────────────────────────────────────────
 *  Dibby Wemo — voice-commands.js
 *
 *  Browser-native speech recognition + intent parser + device matcher.
 *  Shared between:
 *    - the Docker / Synology web UI (apps/desktop/resources/web/index.html)
 *    - the Electron desktop renderer (imported as a static asset)
 *
 *  Engine:  webkitSpeechRecognition / SpeechRecognition (Chromium, Edge, Safari)
 *           Chrome / Edge stream audio to the vendor cloud; Safari does on-device.
 *           This module never records, stores, or transmits audio itself.
 *
 *  Exports (attached to window.WemoVoice for non-module use):
 *    - VoiceCommander  — class wrapping recognition lifecycle + event dispatch
 *    - parseIntent     — pure function (transcript, devices, opts) -> intent | null
 *    - bestDeviceMatch — pure function (spoken, devices) -> { device, score, source }
 *    - levenshtein     — pure function exposed for tests
 *    - isSupported()   — feature-detect for the disabled-button fallback
 *
 *  Storage of training aliases is the caller's job — this module only consumes
 *  device.voiceAliases when scoring matches.  See voice-trainer.js for the
 *  reusable "record + transcribe" helper that produces alias text.
 * ──────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── Feature detection ────────────────────────────────────────────────────

  const SR =
    (typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)) ||
    null;

  function isSupported() {
    return !!SR;
  }

  // ── Levenshtein distance (iterative, O(m*n) time, O(min(m,n)) space) ─────

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    // Make `b` the shorter to minimise the row width.
    if (a.length < b.length) { const t = a; a = b; b = t; }

    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;

    for (let i = 1; i <= a.length; i++) {
      const curr = new Array(b.length + 1);
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          curr[j - 1] + 1,         // insertion
          prev[j] + 1,             // deletion
          prev[j - 1] + cost,      // substitution
        );
      }
      prev = curr;
    }
    return prev[b.length];
  }

  // ── Normalisation ────────────────────────────────────────────────────────
  //
  // Lowercase, strip leading/trailing whitespace, collapse internal whitespace,
  // and remove punctuation that a Wemo name is unlikely to contain.  STT
  // engines insert apostrophes ("dibby's"), commas, full stops, etc. that
  // would otherwise inflate the edit distance.

  function normalise(s) {
    return String(s ?? '')
      .toLowerCase()
      .replace(/[.,!?;:'"`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Device matcher ───────────────────────────────────────────────────────
  //
  // Returns the best { device, score, source } across every device's
  // friendlyName AND every entry in device.voiceAliases.  Score is the
  // length-normalised Levenshtein distance: 0 = exact, 1 = totally
  // different.  A score ≤ 0.4 means at least 60 % similar — empirically
  // good enough that a slight mispronunciation matches but unrelated words
  // don't.  Tie-break: shortest target name wins (more specific match).

  function bestDeviceMatch(spoken, devices, opts) {
    const threshold = (opts && opts.threshold) ?? 0.4;
    const sn = normalise(spoken);
    if (!sn || !Array.isArray(devices) || devices.length === 0) return null;

    let best = null;

    for (const dev of devices) {
      if (!dev || !dev.friendlyName) continue;

      // friendlyName candidate
      const fn = normalise(dev.friendlyName);
      const fnScore = fn ? levenshtein(sn, fn) / Math.max(fn.length, 1) : 1;
      if (!best || fnScore < best.score ||
          (fnScore === best.score && fn.length < (best.targetLen ?? Infinity))) {
        best = { device: dev, score: fnScore, source: 'name', targetLen: fn.length };
      }

      // alias candidates
      const aliases = Array.isArray(dev.voiceAliases) ? dev.voiceAliases : [];
      for (const alias of aliases) {
        const an = normalise(alias);
        if (!an) continue;
        const aScore = levenshtein(sn, an) / Math.max(an.length, 1);
        if (aScore < best.score ||
            (aScore === best.score && an.length < (best.targetLen ?? Infinity))) {
          best = { device: dev, score: aScore, source: 'alias', alias, targetLen: an.length };
        }
      }
    }

    if (!best || best.score > threshold) return null;
    // Drop the internal targetLen before returning.
    return { device: best.device, score: best.score, source: best.source, alias: best.alias };
  }

  // ── Intent parser ────────────────────────────────────────────────────────
  //
  // Strip wake-word prefix (if required), then match one of:
  //   "all/everything <on|off>"   -> bulk
  //   "<verb> <device>"           -> set / toggle
  //
  // Returns null if the transcript doesn't look like a command (silently
  // ignored — important in continuous-listen mode where ambient chatter
  // shouldn't accidentally fire anything).

  function parseIntent(transcript, devices, opts) {
    const o          = opts || {};
    const wakeWord   = o.wakeWord ? normalise(o.wakeWord) : null;
    const threshold  = o.threshold ?? 0.4;
    let text         = normalise(transcript);
    if (!text) return null;

    // Wake-word gate.  Must be the literal first token.
    if (wakeWord) {
      if (!text.startsWith(wakeWord + ' ') && text !== wakeWord) return null;
      text = text.slice(wakeWord.length).trim();
      // Optional connector words after the wake-word ("dibby please turn off…")
      text = text.replace(/^(please|hey|can you|could you|would you)\s+/i, '');
    }

    // ── Bulk commands ──────────────────────────────────────────────────────
    // "all on", "everything off", "turn on all the lights", "shut down everything"
    const bulkMatch = text.match(
      /^(?:turn|switch|set|shut|put)?\s*(?:on|off)\s*(?:all|everything)?$|^(?:all|everything)\s*(?:on|off)$|^(?:turn|switch|set|shut|put)\s*(?:all|everything)\s*(?:the\s+)?(?:lights?|devices?|switches?|wemos?)?\s*(on|off)$/i,
    );
    if (bulkMatch) {
      const flag = (bulkMatch[1] || text).match(/\boff\b/i) ? 'off' : 'on';
      return { kind: 'bulk', on: flag === 'on' };
    }

    // Simpler bulk forms.
    if (/^(all|everything|every device|every light)\s+(on|off)$/.test(text)) {
      return { kind: 'bulk', on: /\bon$/.test(text) };
    }

    // ── Single-device verbs ───────────────────────────────────────────────
    // Capture: <verb> [<filler>] <device-words>
    //   verbs   : turn|switch|set|put|toggle|flip
    //   filler  : on/off goes here for set, none for toggle
    //   device-words: the rest of the string
    const setMatch = text.match(/^(?:turn|switch|set|put)\s+(on|off)\s+(?:the\s+)?(.+)$/);
    if (setMatch) {
      const wanted   = setMatch[1] === 'on';
      const devicePhrase = setMatch[2];
      const match = bestDeviceMatch(devicePhrase, devices, { threshold });
      if (!match) return { kind: 'no-match', spoken: devicePhrase };
      return { kind: 'set', device: match.device, on: wanted, score: match.score, source: match.source };
    }

    const toggleMatch = text.match(/^(?:toggle|flip)\s+(?:the\s+)?(.+)$/);
    if (toggleMatch) {
      const devicePhrase = toggleMatch[1];
      const match = bestDeviceMatch(devicePhrase, devices, { threshold });
      if (!match) return { kind: 'no-match', spoken: devicePhrase };
      return { kind: 'toggle', device: match.device, score: match.score, source: match.source };
    }

    // "<device> on" / "<device> off" — terse form
    const terseMatch = text.match(/^(.+?)\s+(on|off)$/);
    if (terseMatch) {
      const match = bestDeviceMatch(terseMatch[1], devices, { threshold });
      if (match) {
        return { kind: 'set', device: match.device, on: terseMatch[2] === 'on', score: match.score, source: match.source };
      }
    }

    return null;
  }

  // ── VoiceCommander class ─────────────────────────────────────────────────
  //
  // Thin wrapper around SpeechRecognition with:
  //   - continuous + interim results enabled
  //   - automatic restart after error or end (when "always-on" enabled)
  //   - clean teardown on stop()
  //   - public events: onTranscript(text, isFinal), onIntent(intent), onError(e)

  class VoiceCommander {
    constructor(opts = {}) {
      if (!SR) throw new Error('SpeechRecognition not supported in this browser.');

      this._lang        = opts.lang || 'en-US';
      this._wakeWord    = opts.wakeWord ?? 'dibby';      // null disables
      this._continuous  = opts.continuous !== false;     // default on
      this._getDevices  = opts.getDevices || (() => []);
      this._threshold   = opts.threshold ?? 0.4;

      this._cb = { transcript: [], intent: [], error: [], state: [] };
      this._running = false;
      this._stopRequested = false;
      this._rec = null;
    }

    // --- public ----------------------------------------------------------------

    setWakeWord(word) { this._wakeWord = word ? String(word) : null; }
    setThreshold(t)   { this._threshold = Math.max(0, Math.min(1, Number(t) || 0.4)); }
    isRunning()       { return this._running; }

    onTranscript(cb)  { this._cb.transcript.push(cb); }
    onIntent(cb)      { this._cb.intent.push(cb); }
    onError(cb)       { this._cb.error.push(cb); }
    onStateChange(cb) { this._cb.state.push(cb); }

    start() {
      if (this._running) return;
      this._stopRequested = false;
      this._spawn();
    }

    stop() {
      this._stopRequested = true;
      if (this._rec) { try { this._rec.stop(); } catch {} }
      this._setRunning(false);
    }

    toggle() { this._running ? this.stop() : this.start(); }

    // --- internal --------------------------------------------------------------

    _setRunning(v) {
      if (this._running !== v) {
        this._running = v;
        this._cb.state.forEach((cb) => { try { cb(v); } catch {} });
      }
    }

    _emit(channel, ...args) {
      this._cb[channel].forEach((cb) => { try { cb(...args); } catch {} });
    }

    _spawn() {
      const rec = new SR();
      rec.lang           = this._lang;
      rec.continuous     = this._continuous;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onstart = () => this._setRunning(true);

      rec.onresult = (ev) => {
        // Walk every result since last final to assemble the running text.
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const result = ev.results[i];
          const text   = result[0].transcript;
          const isFinal = result.isFinal;
          this._emit('transcript', text, isFinal);

          if (isFinal) {
            const devices = this._getDevices() || [];
            const intent  = parseIntent(text, devices, {
              wakeWord: this._wakeWord,
              threshold: this._threshold,
            });
            if (intent) this._emit('intent', intent, text);
          }
        }
      };

      rec.onerror = (ev) => {
        this._emit('error', ev.error || ev);
        // "no-speech" / "aborted" are normal in continuous mode — let onend
        // handle restart.  Anything fatal (e.g. "not-allowed", "audio-capture")
        // will block restart below.
      };

      rec.onend = () => {
        this._setRunning(false);
        if (!this._stopRequested && this._continuous) {
          // Hand back to the event loop before respawning so we don't tight-loop
          // when the engine refuses to start (e.g. mic permission revoked).
          setTimeout(() => { if (!this._stopRequested) this._spawn(); }, 250);
        }
      };

      this._rec = rec;
      try { rec.start(); }
      catch (e) {
        this._emit('error', e);
        this._setRunning(false);
      }
    }
  }

  // ── Public surface ───────────────────────────────────────────────────────

  const api = {
    VoiceCommander,
    parseIntent,
    bestDeviceMatch,
    levenshtein,
    normalise,
    isSupported,
  };

  if (typeof window !== 'undefined') window.WemoVoice = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
