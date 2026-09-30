// The assistant's "brain" — small, local and private.
// It learns from the user's own entries: the words they use most, how casual
// they talk, their mood over time, and their streak. It then talks back in the
// same language and the same register (casual vs. plain) the user uses.

import { fill, pack, SUPPORTED } from './i18n.js';
import { addDays, dayKey } from './db.js';

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Filler words from every language, since people switch and mix languages.
let stopCache;
function stopSet() {
  if (!stopCache) stopCache = new Set(SUPPORTED.flatMap((c) => normalize(pack(c).stopwords).split(' ')));
  return stopCache;
}

export function tokens(text, P) {
  const stop = stopSet();
  return normalize(text)
    .replace(/'/g, '')
    .split(' ')
    .filter((w) => w.length > 2 && !stop.has(w) && !/^\d+$/.test(w));
}

export function entryText(e) {
  return [e.transcript, e.text].filter(Boolean).join(' ');
}

function has(norm, phrase) {
  return ` ${norm} `.includes(` ${normalize(phrase)} `);
}

export function moodScore(text, P) {
  const words = normalize(text).split(' ');
  if (!words.length) return 0;
  const pos = new Set(P.positive.map(normalize));
  const neg = new Set(P.negative.map(normalize));
  let s = 0;
  for (const w of words) {
    if (pos.has(w)) s += 1;
    else if (neg.has(w)) s -= 1;
  }
  return Math.max(-1, Math.min(1, s / Math.sqrt(words.length)));
}

export function topWords(list, P, n = 8) {
  const counts = new Map();
  for (const e of list) for (const w of tokens(entryText(e), P)) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word, count]) => ({ word, count }));
}

export function isCasual(list, P) {
  const markers = new Set(P.casualMarkers.map(normalize));
  let hits = 0;
  let words = 0;
  for (const e of list) {
    const ws = normalize(entryText(e)).split(' ');
    words += ws.length;
    for (const w of ws) if (markers.has(w)) hits += 1;
  }
  return words > 0 && hits / words > 0.008;
}

export function streak(list, today = dayKey()) {
  const days = new Set(list.map((e) => e.date));
  let cursor = days.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(cursor)) {
    n += 1;
    cursor = addDays(cursor, -1);
  }
  return n;
}

function avgMood(list, P) {
  const scored = list.map((e) => moodScore(entryText(e), P)).filter((_, i) => entryText(list[i]));
  if (!scored.length) return 0;
  return scored.reduce((a, b) => a + b, 0) / scored.length;
}

export function moodByDay(list, P, days = 14, today = dayKey()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = addDays(today, -i);
    const dayEntries = list.filter((e) => e.date === key);
    out.push({ date: key, score: dayEntries.length ? avgMood(dayEntries, P) : null });
  }
  return out;
}

function trend(list, P, today) {
  const recent = list.filter((e) => e.date > addDays(today, -7));
  const prior = list.filter((e) => e.date <= addDays(today, -7) && e.date > addDays(today, -14));
  const B = P.brain;
  if (!recent.length) return B.trendFlat;
  const diff = avgMood(recent, P) - (prior.length ? avgMood(prior, P) : 0);
  if (diff > 0.08) return B.trendUp;
  if (diff < -0.08) return B.trendDown;
  return B.trendFlat;
}

function moodLabel(list, P) {
  const m = avgMood(list, P);
  if (m > 0.08) return P.brain.moodGood;
  if (m < -0.08) return P.brain.moodLow;
  return P.brain.moodOk;
}

function countLabel(n, B) {
  return n === 1 ? B.entryOne : fill(B.entryMany, { n });
}

function topicsOf(list, P) {
  const t = topWords(list, P, 3).map((x) => x.word);
  return t.length ? t.join(', ') : P.brain.nothingYet;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function variant(B, key, casual) {
  return (casual && B[`${key}_casual`]) || B[key];
}

function afterPhrase(raw, phrases) {
  const norm = normalize(raw);
  for (const p of phrases) {
    const np = normalize(p);
    const idx = ` ${norm} `.indexOf(` ${np} `);
    if (idx !== -1) return norm.slice(idx + np.length).trim();
  }
  return '';
}

/** The most talked-about topic from the user's last active day — used in the welcome-back intro. */
export function lastTopic(list, P, today = dayKey()) {
  const past = list.filter((e) => e.date < today && entryText(e));
  if (!past.length) return '';
  const last = past.reduce((a, b) => (a.date > b.date ? a : b)).date;
  const words = topWords(past.filter((e) => e.date === last), P, 1);
  return words[0]?.word || '';
}

/**
 * Answer a message. ctx = { lang, entries, name, today, fmtDate }.
 * Returns { text, action? } — action can be 'off' or 'name' (with name).
 */
export function reply(message, ctx) {
  const P = pack(ctx.lang);
  const B = P.brain;
  const I = P.intents;
  const norm = normalize(message);
  const all = ctx.entries;
  const today = ctx.today;
  const casual = isCasual(all, P) || isCasual([{ text: message }], P);
  const nameBit = ctx.name ? `, ${ctx.name}` : '';
  const longForm = norm.split(' ').length > 14; // long messages are journaling, not commands

  const matches = (key) => (I[key] || []).some((k) => has(norm, k));

  if (!longForm && matches('off')) return { text: B.off, action: 'off' };

  if (matches('name')) {
    const rest = afterPhrase(message, I.name).split(' ').slice(0, 2).join(' ');
    if (rest) {
      const name = rest.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
      return { text: fill(B.nameSet, { name }), action: 'name', name };
    }
  }

  if (matches('search')) {
    const q = afterPhrase(message, I.search).replace(/\?/g, '').trim();
    if (q) {
      const nq = normalize(q);
      const hits = all
        .filter((e) => normalize(entryText(e)).includes(nq))
        .sort((a, b) => b.createdAt - a.createdAt);
      if (!hits.length) return { text: fill(B.searchMiss, { q }) };
      const text = entryText(hits[0]);
      const at = normalize(text).indexOf(nq);
      const snippet = text.slice(Math.max(0, at - 40), at + nq.length + 60).trim();
      const times = hits.length === 1 ? B.timesOne : fill(B.timesMany, { n: hits.length });
      return { text: fill(B.searchHit, { q, times, date: ctx.fmtDate(hits[0].date), snippet }) };
    }
  }

  if (!longForm) {
    if (matches('help')) return { text: B.help };

    if (matches('growth')) {
      const days = new Set(all.map((e) => e.date)).size;
      if (days < 2) return { text: B.growthEmpty };
      const recent = all.filter((e) => e.date > addDays(today, -7));
      return {
        text: fill(B.growth, {
          days,
          streak: streak(all, today),
          trend: trend(all, P, today),
          topics: topicsOf(recent.length ? recent : all, P),
        }),
      };
    }

    const recap = (list, when) => {
      if (!list.length) return { text: fill(B.recapNone, { when }) };
      return {
        text: fill(B.recap, {
          When: when.charAt(0).toUpperCase() + when.slice(1) + ',',
          n: countLabel(list.length, B),
          topics: topicsOf(list, P),
          mood: moodLabel(list, P),
        }),
      };
    };

    if (matches('yesterday')) return recap(all.filter((e) => e.date === addDays(today, -1)), B.yesterday);
    if (matches('week')) return recap(all.filter((e) => e.date > addDays(today, -7)), B.week);
    if (matches('today')) return recap(all.filter((e) => e.date === today), B.today);

    if (matches('hi')) {
      const todays = all.filter((e) => e.date === today);
      const todayLine = todays.length ? fill(B.todaySome, { n: countLabel(todays.length, B) }) : B.todayNone;
      return { text: fill(pick(variant(B, 'hi', casual)), { name: nameBit, today: todayLine }) };
    }
  }

  // Reflective fallback — mirrors the user's own most-used word back at them.
  const top = topWords(all, P, 5).filter((w) => w.count > 2);
  let options = variant(B, 'fallback', casual);
  if (!top.length) options = options.filter((o) => !o.includes('{word}'));
  return { text: fill(pick(options), { word: top.length ? pick(top).word : '' }), kind: 'reflect' };
}
