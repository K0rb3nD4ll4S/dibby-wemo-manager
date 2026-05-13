/* ──────────────────────────────────────────────────────────────────────────
 *  Dibby Wemo — voice-trainer.js
 *
 *  Tiny "record one phrase, get its transcript" helper.  Returns a Promise
 *  that resolves to the STT engine's literal transcription of what the user
 *  just said — which is what we store as a voice alias (see plan: aliases
 *  use whatever STT actually returns so they round-trip cleanly through any
 *  accent or mis-pronunciation).
 *
 *  Used by both:
 *    - the per-device 🎤 Train button in the web UI
 *    - the VoiceAliasManager React component in the Electron renderer
 *
 *  Engine policy: identical to voice-commands.js — webkitSpeechRecognition /
 *  SpeechRecognition only.  No raw audio is recorded or stored.
 * ──────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  const SR =
    (typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)) ||
    null;

  /**
   * Record a single phrase and return its transcription.
   * @param {object} opts
   * @param {string}  [opts.lang='en-US']
   * @param {number}  [opts.maxMs=4000]    — hard cap; recording stops at first
   *                                         final result or this timeout, whichever
   *                                         comes first.
   * @param {function}[opts.onInterim]     — called with each interim transcript
   *                                         (string) for level-meter / live preview.
   * @returns {Promise<string>}            — the final transcript (trimmed, lowercased).
   *                                         Rejects with Error('no-speech') / mic
   *                                         denial / unsupported, etc.
   */
  function recordAlias(opts) {
    return new Promise((resolve, reject) => {
      if (!SR) return reject(new Error('SpeechRecognition not supported in this browser.'));

      const o = opts || {};
      const rec = new SR();
      rec.lang            = o.lang || 'en-US';
      rec.continuous      = false;   // one-shot — auto-stops on silence
      rec.interimResults  = true;
      rec.maxAlternatives = 1;

      let bestFinal = '';
      let lastInterim = '';
      let settled = false;
      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        try { rec.stop(); } catch {}
        fn(val);
      };

      const timer = setTimeout(() => {
        const fallback = (bestFinal || lastInterim).trim();
        if (fallback) settle(resolve, fallback.toLowerCase());
        else settle(reject, new Error('no-speech'));
      }, Math.max(1500, o.maxMs || 4000));

      rec.onresult = (ev) => {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          const text = (r[0]?.transcript || '').trim();
          if (r.isFinal) {
            bestFinal = text;
            // First final result wins — terminate immediately rather than wait
            // for the timeout, so the UX is snappy.
            clearTimeout(timer);
            settle(resolve, bestFinal.toLowerCase());
            return;
          } else {
            lastInterim = text;
            if (typeof o.onInterim === 'function') {
              try { o.onInterim(text); } catch {}
            }
          }
        }
      };

      rec.onerror = (ev) => {
        clearTimeout(timer);
        settle(reject, new Error(ev.error || 'speech-error'));
      };

      rec.onend = () => {
        // If end fires before a final result + before our timeout, surface
        // whatever interim text we collected.  Empty string → no-speech.
        if (!settled) {
          clearTimeout(timer);
          const fallback = (bestFinal || lastInterim).trim();
          if (fallback) settle(resolve, fallback.toLowerCase());
          else settle(reject, new Error('no-speech'));
        }
      };

      try { rec.start(); }
      catch (e) { clearTimeout(timer); settle(reject, e); }
    });
  }

  const api = { recordAlias };

  if (typeof window !== 'undefined') {
    window.WemoVoiceTrainer = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
