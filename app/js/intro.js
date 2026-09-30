// The "before the mission" scene: boot text, light beams, a talking orb,
// then the scene melts away and the voice tours the journal, lighting up
// each piece (camera, transcript, calendar, text box, assistant, off switch)
// as it names it.

import { speak, stopSpeaking } from './voice.js';

// Which element each first-visit intro line points at (matches the order in i18n.js).
export const FIRST_TOUR = [null, null, null, 'studio', 'transcript', 'calendar', 'composer', 'assistant', 'aiToggle', null, null];
export const FIRST_REVEAL_AT = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function runIntro({ P, lines, tour = [], revealAt = 1, onReveal, onTalk }) {
  const intro = document.getElementById('intro');
  const sub = document.getElementById('introSub');
  const boot = document.getElementById('introBoot');
  const orb = document.getElementById('introOrb');
  const skipBtn = document.getElementById('introSkip');

  let skipped = false;
  let revealed = false;
  let jitter = null;
  let resolveSkip;
  const skipSignal = new Promise((r) => { resolveSkip = r; });

  intro.hidden = false;
  intro.classList.remove('reveal', 'done', 'flash');

  const talking = (on) => {
    clearInterval(jitter);
    if (on) jitter = setInterval(() => intro.style.setProperty('--lvl', (0.3 + Math.random() * 0.7).toFixed(2)), 90);
    else intro.style.setProperty('--lvl', 0);
    onTalk?.(on);
  };

  const reveal = () => {
    if (revealed) return;
    revealed = true;
    intro.classList.add('flash');
    setTimeout(() => intro.classList.add('reveal'), 120);
    onReveal?.();
  };

  const spotlight = (target) => {
    document.querySelectorAll('.spotlight').forEach((el) => el.classList.remove('spotlight'));
    if (!target) return;
    const el = document.querySelector(`[data-spot="${target}"]`);
    if (!el) return;
    el.classList.add('spotlight');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const showLine = (text) => {
    sub.innerHTML = '';
    text.split(/\s+/).forEach((w, i) => {
      const span = document.createElement('span');
      span.className = 'w';
      span.style.animationDelay = `${i * 70}ms`;
      span.textContent = w;
      sub.append(span, ' ');
    });
  };

  skipBtn.onclick = () => {
    skipped = true;
    stopSpeaking();
    resolveSkip();
  };

  const run = async () => {
    // Boot sequence while the beams rise.
    boot.innerHTML = '';
    for (const step of P.booting) {
      if (skipped) break;
      const row = document.createElement('div');
      row.innerHTML = `&gt; ${step}… <span class="ok">[ OK ]</span>`;
      boot.append(row);
      await Promise.race([sleep(380), skipSignal]);
    }

    for (let i = 0; i < lines.length && !skipped; i++) {
      if (i === revealAt) reveal();
      spotlight(tour[i]);
      showLine(lines[i]);
      const minRead = Math.max(1300, lines[i].split(/\s+/).length * 300);
      await Promise.race([
        Promise.all([
          speak(lines[i], P.speech, { onStart: () => talking(true), onEnd: () => talking(false) }),
          sleep(minRead),
        ]),
        skipSignal,
      ]);
      if (!skipped) await Promise.race([sleep(220), skipSignal]);
    }

    talking(false);
    spotlight(null);
    if (!revealed) reveal();
    intro.classList.add('done');
    await sleep(650);
    intro.hidden = true;
    orb.style.removeProperty('transform');
  };

  return run();
}
