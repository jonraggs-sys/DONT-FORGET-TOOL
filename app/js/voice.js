// The assistant's mouth (speech synthesis) and ears (speech recognition).
// Both use the browser's built-in engines, so no API keys and nothing leaves the device
// beyond what the browser vendor's own speech service does.

const synth = window.speechSynthesis;
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const canListen = Boolean(Recognition);
export const canSpeak = Boolean(synth);

let voicesReady;
function loadVoices() {
  if (!synth) return Promise.resolve([]);
  if (voicesReady) return voicesReady;
  voicesReady = new Promise((resolve) => {
    const v = synth.getVoices();
    if (v.length) return resolve(v);
    synth.addEventListener('voiceschanged', () => resolve(synth.getVoices()), { once: true });
    setTimeout(() => resolve(synth.getVoices()), 1500);
  });
  return voicesReady;
}

async function pickVoice(lang) {
  const voices = await loadVoices();
  const base = lang.slice(0, 2);
  const matches = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(base));
  // Prefer natural-sounding voices when the platform ships them.
  return (
    matches.find((v) => /natural|neural|premium|enhanced|google/i.test(v.name)) ||
    matches.find((v) => v.lang === lang) ||
    matches[0] ||
    null
  );
}

let muted = false;
export function setMuted(v) {
  muted = v;
  if (v) stopSpeaking();
}

/**
 * Speak text aloud. Resolves when finished (or immediately if muted/unsupported).
 * onStart/onEnd let the UI animate the assistant's "orb" while talking.
 */
export async function speak(text, lang, { onStart, onEnd, rate = 1.02, pitch = 1 } = {}) {
  if (!synth || muted || !text) {
    onEnd?.();
    return;
  }
  const voice = await pickVoice(lang);
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    if (voice) u.voice = voice;
    u.rate = rate;
    u.pitch = pitch;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onEnd?.();
      resolve();
    };
    u.onstart = () => onStart?.();
    u.onend = finish;
    u.onerror = finish;
    // Safety net: some engines never fire onend.
    setTimeout(finish, Math.max(4000, text.length * 110));
    synth.speak(u);
  });
}

export function stopSpeaking() {
  synth?.cancel();
}

/**
 * Continuous listener. Returns a controller with stop().
 * onText(finalText, interimText) is called as words arrive.
 */
export function listen(lang, { onText, onEnd, continuous = true } = {}) {
  if (!Recognition) return null;
  const rec = new Recognition();
  rec.lang = lang;
  rec.continuous = continuous;
  rec.interimResults = true;
  let finalText = '';
  let stopped = false;

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript.trim() + ' ';
      else interim += r[0].transcript;
    }
    onText?.(finalText.trim(), interim.trim());
  };
  // Chrome ends recognition after silence; keep it alive while we're still recording.
  rec.onend = () => {
    if (!stopped && continuous) {
      try { rec.start(); } catch { /* already started */ }
    } else {
      onEnd?.(finalText.trim());
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') stopped = true;
  };

  try { rec.start(); } catch { return null; }

  return {
    stop() {
      stopped = true;
      try { rec.stop(); } catch { /* noop */ }
      return finalText.trim();
    },
    get text() { return finalText.trim(); },
  };
}

/** Live 0..1 loudness from a MediaStream, for the orb and the LIVE meter. */
export function meter(stream, onLevel) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !stream) return () => {};
  const ctx = new Ctx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let raf;
  const tick = () => {
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    onLevel(Math.min(1, sum / data.length / 90));
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    ctx.close();
  };
}
