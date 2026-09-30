import { detectLang, setLang, pack, fill, SUPPORTED } from './i18n.js';
import { entries as store, kv, uid, dayKey, keyToDate, addDays } from './db.js';
import * as voice from './voice.js';
import * as brain from './brain.js';
import { runIntro, FIRST_TOUR, FIRST_REVEAL_AT } from './intro.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  lang: detectLang(),
  P: null,
  today: dayKey(),
  selected: dayKey(), // the journal always opens on the day it is
  month: null,
  all: [],
  profile: { name: '', ai: true, voice: true, visits: 0 },
  mic: null,
  cam: null,
  recorder: null,
  chunks: [],
  listener: null,
  recStart: 0,
  timerId: null,
  stopMeter: null,
  urls: [],
  talkListener: null,
  talkDownAt: 0,
};
state.P = pack(state.lang);
state.month = firstOfMonth(keyToDate(state.today));

/* ------------------------------------------------------------------ helpers */

function firstOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmt = {
  long: (k) => new Intl.DateTimeFormat(state.lang, { weekday: 'long', month: 'long', day: 'numeric' }).format(keyToDate(k)),
  short: (k) => new Intl.DateTimeFormat(state.lang, { month: 'short', day: 'numeric' }).format(keyToDate(k)),
  dow: (k) => new Intl.DateTimeFormat(state.lang, { weekday: 'short' }).format(keyToDate(k)),
  time: (ts) => new Intl.DateTimeFormat(state.lang, { hour: 'numeric', minute: '2-digit' }).format(new Date(ts)),
  month: (d) => new Intl.DateTimeFormat(state.lang, { month: 'long', year: 'numeric' }).format(d),
};

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function nameBit() {
  return state.profile.name ? `, ${state.profile.name}` : '';
}

function saveProfile() {
  return kv.set('profile', state.profile).catch(() => {});
}

function brainCtx() {
  return { lang: state.lang, entries: state.all, name: state.profile.name, today: state.today, fmtDate: fmt.short };
}

function onDay(key) {
  return state.all.filter((e) => e.date === key).sort((a, b) => b.createdAt - a.createdAt);
}

/* ------------------------------------------------------------------ strings */

function applyStrings() {
  const P = state.P;
  document.documentElement.lang = state.lang;
  $$('[data-i18n]').forEach((el) => {
    const v = P[el.dataset.i18n];
    if (typeof v === 'string') el.textContent = v;
  });
  $('#chatInput').placeholder = P.askPlaceholder;
  $('#talkBtn').title = P.talk;
  $('#voiceBtn').title = P.voice;
  $('#composeText').placeholder = fill(P.freewrite, { name: nameBit() });
  $('#meAvatar').textContent = (state.profile.name || '✦').charAt(0).toUpperCase();

  const sel = $('#langSelect');
  sel.innerHTML = SUPPORTED.map((c) => `<option value="${c}" ${c === state.lang ? 'selected' : ''}>${esc(pack(c).name)}</option>`).join('');
}

/* ------------------------------------------------------------------ 1. mic gate */

async function requestMic() {
  $('#gateDenied').hidden = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
    state.mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    enter();
  } catch {
    $('#gateDenied').hidden = false;
  }
}

async function enter() {
  const gate = $('#gate');
  gate.classList.add('leaving');
  setTimeout(() => { gate.hidden = true; }, 600);

  await loadAll();
  $('#hub').hidden = false;
  applyStrings();
  applyProfile();
  renderAll();

  if (state.mic) {
    state.stopMeter = voice.meter(state.mic, (lvl) => {
      $('#levelBar').style.width = `${Math.round(lvl * 100)}%`;
      $('#intro').style.setProperty('--mic', lvl.toFixed(2));
    });
  }

  const returning = state.profile.visits > 0;
  state.profile.visits += 1;
  saveProfile();

  // If the user turned the assistant off, respect it: no intro speech, straight to the journal.
  if (!state.profile.ai) {
    showHub();
    return;
  }

  let lines = state.P.intro;
  let tour = FIRST_TOUR;
  let revealAt = FIRST_REVEAL_AT;
  if (returning) {
    const P = state.P;
    const s = brain.streak(state.all, state.today);
    const topic = brain.lastTopic(state.all, P, state.today);
    lines = P.introBack
      .map((l) => fill(l, {
        name: nameBit(),
        streakLine: s ? fill(P.streakLine, { streak: s }) : P.streakZero,
        topicLine: topic ? fill(P.topicLine, { topic }) : '',
      }))
      .filter((l) => l.trim());
    tour = lines.map((_, i) => (i === lines.length - 1 ? 'studio' : null));
    revealAt = Math.max(1, lines.length - 1);
  }

  await runIntro({ P: state.P, lines, tour, revealAt, onReveal: showHub, onTalk: setTalking });
  showHub();

  // Seed the chat so it's clear what the assistant can do.
  if (returning) {
    const r = brain.reply(state.P.intents.hi[0], brainCtx());
    pushMsg('ai', r.text);
  } else {
    pushMsg('ai', state.P.brain.help);
  }
}

let hubShown = false;
function showHub() {
  if (hubShown) return;
  hubShown = true;
  $('#hub').classList.add('on');
  startCamera();
}

function setTalking(on) {
  $('#miniOrb').classList.toggle('talking', on);
}

/* ------------------------------------------------------------------ data */

async function loadAll() {
  try {
    const [all, profile] = await Promise.all([store.all(), kv.get('profile')]);
    state.all = all || [];
    if (profile) state.profile = { ...state.profile, ...profile };
  } catch (err) {
    console.error('Could not open local journal storage', err);
    toast('Storage unavailable — entries won’t be saved in this window.');
  }
}

async function saveEntry(entry) {
  state.all.push(entry);
  try { await store.put(entry); } catch (err) { console.error(err); }
}

async function updateEntry(entry) {
  try { await store.put(entry); } catch (err) { console.error(err); }
}

async function deleteEntry(id) {
  state.all = state.all.filter((e) => e.id !== id);
  try { await store.remove(id); } catch (err) { console.error(err); }
  renderAll();
}

/* ------------------------------------------------------------------ profile / toggles */

function applyProfile() {
  const on = state.profile.ai;
  $('#aiToggle').setAttribute('aria-checked', String(on));
  $('#assistant').classList.toggle('off', !on);
  $('#aiOffNote').hidden = on;
  voice.setMuted(!state.profile.voice);
  $('#voiceBtn').textContent = state.profile.voice ? '🔊' : '🔇';
  $('#voiceBtn').setAttribute('aria-pressed', String(state.profile.voice));
}

function setAI(on) {
  state.profile.ai = on;
  if (!on) voice.stopSpeaking();
  applyProfile();
  saveProfile();
  if (on) {
    const r = brain.reply(state.P.intents.hi[0], brainCtx());
    pushMsg('ai', r.text);
    say(r.text);
  }
}

/* ------------------------------------------------------------------ rendering */

function renderAll() {
  renderHeader();
  renderStories();
  renderCalendar();
  renderFeed();
  renderPatterns();
}

function select(key) {
  state.selected = key;
  const d = keyToDate(key);
  if (d.getMonth() !== state.month.getMonth() || d.getFullYear() !== state.month.getFullYear()) state.month = firstOfMonth(d);
  renderAll();
}

function renderHeader() {
  const P = state.P;
  const isToday = state.selected === state.today;
  $('#dayKicker').textContent = isToday ? P.today : P.viewing;
  $('#dayTitle').textContent = fmt.long(state.selected);
  $('#backToday').hidden = isToday;
  $('#streakNum').textContent = brain.streak(state.all, state.today);
  document.title = `${fmt.short(state.selected)} · Don't Forget`;
}

function renderStories() {
  const wrap = $('#stories');
  wrap.innerHTML = '';
  for (let i = 0; i < 14; i++) {
    const key = addDays(state.today, -i);
    const list = onDay(key);
    const poster = list.find((e) => e.poster)?.poster;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `story${list.length ? ' has' : ''}${key === state.selected ? ' sel' : ''}${i === 0 ? ' today' : ''}`;
    b.innerHTML = `
      <span class="story-ring"><span class="story-face${poster ? ' img' : ''}" ${poster ? `style="background-image:url('${poster}')"` : ''}>${keyToDate(key).getDate()}</span></span>
      <span class="story-label">${esc(i === 0 ? state.P.today : fmt.dow(key))}</span>`;
    b.onclick = () => select(key);
    wrap.append(b);
  }
}

function renderCalendar() {
  const grid = $('#calendar');
  const m = state.month;
  const title = fmt.month(m);
  $('#calTitle').textContent = title.charAt(0).toUpperCase() + title.slice(1);
  grid.innerHTML = '';

  const mondayStart = state.lang !== 'en';
  const startDow = mondayStart ? 1 : 0;
  // Weekday headers in the user's language.
  const ref = new Date(2024, 0, 7 + startDow); // Jan 7 2024 is a Sunday
  for (let i = 0; i < 7; i++) {
    const d = new Date(ref);
    d.setDate(ref.getDate() + i);
    const el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = new Intl.DateTimeFormat(state.lang, { weekday: 'narrow' }).format(d);
    grid.append(el);
  }

  const offset = (m.getDay() - startDow + 7) % 7;
  const start = new Date(m);
  start.setDate(1 - offset);
  const byDate = new Map();
  for (const e of state.all) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }

  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = dayKey(d);
    const list = byDate.get(key) || [];
    const b = document.createElement('button');
    b.type = 'button';
    const cls = ['cal-day'];
    if (d.getMonth() !== m.getMonth()) cls.push('out');
    if (key > state.today) cls.push('future');
    if (key === state.today) cls.push('today');
    if (key === state.selected) cls.push('sel');
    if (list.length) cls.push('has');
    b.className = cls.join(' ');
    if (list.length) {
      const mood = list.reduce((a, e) => a + brain.moodScore(brain.entryText(e), state.P), 0) / list.length;
      b.style.setProperty('--mood', mood > 0.05 ? 'var(--green)' : mood < -0.05 ? 'var(--red)' : 'var(--blue)');
    }
    const types = [...new Set(list.map((e) => e.type))];
    const color = { video: 'var(--red)', note: 'var(--blue)', chat: 'var(--purple)' };
    b.innerHTML = `<span>${d.getDate()}</span><span class="dots">${types.map((t) => `<i style="--c:${color[t]}"></i>`).join('')}</span>`;
    b.onclick = () => select(key);
    grid.append(b);
  }
}

function renderPatterns() {
  const P = state.P;
  $('#statDays').textContent = new Set(state.all.map((e) => e.date)).size;
  $('#statEntries').textContent = state.all.length;

  const bars = $('#moodBars');
  bars.innerHTML = '';
  for (const d of brain.moodByDay(state.all, P, 14, state.today)) {
    const i = document.createElement('i');
    i.title = fmt.short(d.date);
    if (d.score === null) {
      i.style.height = '3px';
    } else if (Math.abs(d.score) < 0.02) {
      i.className = 'zero';
    } else {
      i.className = d.score > 0 ? 'pos' : 'neg';
      i.style.height = `${Math.max(8, Math.abs(d.score) * 50)}%`;
      i.style.alignSelf = d.score > 0 ? 'end' : 'start';
    }
    bars.append(i);
  }

  const cloud = $('#wordCloud');
  const words = brain.topWords(state.all, P, 12);
  if (!words.length) {
    cloud.innerHTML = `<p class="empty-note">—</p>`;
    return;
  }
  const max = words[0].count;
  cloud.innerHTML = words.map((w) => `<span style="--w:${(w.count / max).toFixed(2)}">${esc(w.word)}</span>`).join('');
}

function revokeUrls() {
  state.urls.forEach((u) => URL.revokeObjectURL(u));
  state.urls = [];
}

function blobUrl(blob) {
  const u = URL.createObjectURL(blob);
  state.urls.push(u);
  return u;
}

function renderFeed() {
  const P = state.P;
  const feed = $('#feed');
  revokeUrls();
  feed.innerHTML = '';
  const list = onDay(state.selected);
  if (!list.length) {
    feed.innerHTML = `<div class="feed-empty">${esc(state.selected === state.today ? P.emptyDay : P.emptyPast)}</div>`;
    return;
  }
  for (const e of list) feed.append(postEl(e));
}

function postEl(e) {
  const P = state.P;
  const el = document.createElement('article');
  el.className = 'post';
  const who = state.profile.name || '✦';
  const label = { video: P.video, note: P.note, chat: P.chat }[e.type] || e.type;

  let body = '';
  if (e.type === 'video') {
    body = `<video controls playsinline preload="metadata" ${e.poster ? `poster="${e.poster}"` : ''}></video>
      <div class="post-body caption">${e.transcript ? esc(e.transcript) : `<textarea placeholder="✎ ${esc(P.transcript)}"></textarea>`}</div>`;
  } else if (e.type === 'note') {
    body = `<div class="post-body">${esc(e.text)}</div>`;
  } else if (e.type === 'chat') {
    body = `<div class="chat-pair">
      <div class="msg me">${esc(e.text)}</div>
      <div class="msg ai"><span class="who">✦</span>${esc(e.reply || '')}</div>
    </div>`;
  }

  el.innerHTML = `
    <div class="post-head">
      <div class="avatar">${esc(who.charAt(0).toUpperCase())}</div>
      <div class="post-meta"><b>${esc(state.profile.name || P.today)}</b><span>${esc(fmt.time(e.createdAt))}${e.duration ? ` · ${mmss(e.duration)}` : ''}</span></div>
      <span class="badge ${e.type}">${esc(label)}</span>
    </div>
    ${body}
    <div class="post-actions">
      <button type="button" class="fav ${e.fav ? 'liked' : ''}">${e.fav ? '♥' : '♡'}</button>
      ${e.type === 'video' && e.transcript ? `<button type="button" class="edit">✎ ${esc(P.showTranscript)}</button>` : ''}
      <button type="button" class="del">🗑 ${esc(P.delete)}</button>
    </div>`;

  if (e.type === 'video' && e.blob) el.querySelector('video').src = blobUrl(e.blob);

  const wireCaption = (ta) => {
    ta.addEventListener('blur', () => {
      const v = ta.value.trim();
      if (v === (e.transcript || '')) return;
      e.transcript = v;
      updateEntry(e);
      renderPatterns();
      toast(P.saved);
    });
  };
  const ta = el.querySelector('textarea');
  if (ta) wireCaption(ta);

  el.querySelector('.edit')?.addEventListener('click', () => {
    const box = el.querySelector('.post-body.caption');
    box.innerHTML = '<textarea></textarea>';
    const t = box.querySelector('textarea');
    t.value = e.transcript || '';
    t.focus();
    wireCaption(t);
  });

  el.querySelector('.fav').onclick = (ev) => {
    e.fav = !e.fav;
    ev.currentTarget.classList.toggle('liked', e.fav);
    ev.currentTarget.textContent = e.fav ? '♥' : '♡';
    updateEntry(e);
  };
  el.querySelector('.del').onclick = () => {
    if (confirm(`${P.delete}?`)) deleteEntry(e.id);
  };
  return el;
}

function mmss(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ camera + recording */

async function startCamera() {
  if (state.cam) return state.cam;
  try {
    state.cam = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    $('#preview').srcObject = state.cam;
    $('#camOn').hidden = true;
    if (!state.stopMeter) {
      state.stopMeter = voice.meter(state.cam, (lvl) => { $('#levelBar').style.width = `${Math.round(lvl * 100)}%`; });
    }
  } catch {
    $('#camOn').hidden = false;
  }
  return state.cam;
}

function pickMime() {
  if (!window.MediaRecorder) return '';
  const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function renderTranscript(final, interim) {
  const box = $('#liveTranscript');
  box.classList.toggle('placeholder', !final && !interim);
  if (!final && !interim) {
    box.textContent = state.P.transcriptEmpty;
    return;
  }
  box.innerHTML = `${esc(final)} <span class="interim">${esc(interim)}</span>`;
  box.scrollTop = box.scrollHeight;
}

async function startRecording() {
  const cam = await startCamera();
  if (!cam || !window.MediaRecorder) {
    toast(state.P.cameraOff);
    return;
  }
  voice.stopSpeaking();
  const mime = pickMime();
  state.chunks = [];
  state.recorder = new MediaRecorder(cam, mime ? { mimeType: mime } : undefined);
  state.recorder.ondataavailable = (e) => { if (e.data.size) state.chunks.push(e.data); };
  state.recorder.onstop = finishRecording;
  state.recorder.start(1000);
  state.recStart = Date.now();
  state.poster = '';
  setTimeout(() => { state.poster = grabFrame($('#preview')); }, 900);

  $('#recordBtn').classList.add('on');
  $('#liveBadge').hidden = false;
  $('#timer').hidden = false;
  $('#recLabel').textContent = state.P.stop;
  $('#transcriptBox').classList.add('on');
  state.timerId = setInterval(() => { $('#timer').textContent = mmss((Date.now() - state.recStart) / 1000); }, 250);

  state.liveFinal = '';
  if (voice.canListen) {
    renderTranscript('', '');
    state.listener = voice.listen(state.P.speech, {
      onText: (final, interim) => { state.liveFinal = final; renderTranscript(final, interim); },
    });
  } else {
    const box = $('#liveTranscript');
    box.classList.add('placeholder');
    box.textContent = state.P.transcriptUnsupported;
  }
}

function stopRecording() {
  if (!state.recorder || state.recorder.state === 'inactive') return;
  state.recorder.stop();
  clearInterval(state.timerId);
  $('#recordBtn').classList.remove('on');
  $('#liveBadge').hidden = true;
  $('#timer').hidden = true;
  $('#recLabel').textContent = state.P.record;
  $('#transcriptBox').classList.remove('on');
}

async function finishRecording() {
  const transcript = (state.listener?.stop() || state.liveFinal || '').trim();
  state.listener = null;
  const blob = new Blob(state.chunks, { type: state.recorder.mimeType || 'video/webm' });
  state.recorder = null;
  const entry = {
    id: uid(),
    date: state.today, // a recording always belongs to the day it happened
    type: 'video',
    createdAt: Date.now(),
    duration: (Date.now() - state.recStart) / 1000,
    blob,
    transcript,
    poster: state.poster || '',
  };
  await saveEntry(entry);
  state.selected = state.today;
  renderAll();
  toast(state.P.saved);
  renderTranscript('', '');

  if (state.profile.ai && transcript) {
    const r = brain.reply(transcript, brainCtx());
    pushMsg('ai', r.text);
    say(r.text);
  }
}

function grabFrame(video) {
  try {
    if (!video.videoWidth) return '';
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = Math.round(240 * (video.videoHeight / video.videoWidth));
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  } catch {
    return '';
  }
}

function posterFromBlob(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const url = URL.createObjectURL(blob);
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(val);
    };
    setTimeout(() => done(''), 6000);
    v.onloadeddata = () => {
      const dur = Number.isFinite(v.duration) ? v.duration : 1;
      v.currentTime = Math.min(0.6, dur / 2);
    };
    v.onseeked = () => done(grabFrame(v));
    v.onerror = () => done('');
    v.src = url;
  });
}

async function handleUpload(file) {
  if (!file || !file.type.startsWith('video/')) return;
  const now = new Date();
  const when = keyToDate(state.selected);
  when.setHours(now.getHours(), now.getMinutes(), now.getSeconds());
  const [poster, duration] = await Promise.all([posterFromBlob(file), videoDuration(file)]);
  await saveEntry({
    id: uid(),
    date: state.selected, // uploads can back-fill any day you're viewing
    type: 'video',
    createdAt: when.getTime(),
    duration,
    blob: file,
    transcript: '',
    poster,
    fileName: file.name,
  });
  renderAll();
  toast(state.P.saved);
}

function videoDuration(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    v.preload = 'metadata';
    v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(Number.isFinite(v.duration) ? v.duration : 0); };
    v.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    v.src = url;
  });
}

/* ------------------------------------------------------------------ free write */

async function postNote(text) {
  const now = new Date();
  const when = keyToDate(state.selected);
  when.setHours(now.getHours(), now.getMinutes(), now.getSeconds());
  await saveEntry({ id: uid(), date: state.selected, type: 'note', createdAt: when.getTime(), text });
  renderAll();
  toast(state.P.saved);
}

/* ------------------------------------------------------------------ assistant chat */

function pushMsg(who, text) {
  const chat = $('#chat');
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.innerHTML = `<span class="who">${who === 'ai' ? '✦' : ''}</span>${esc(text)}`;
  chat.append(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function say(text) {
  if (!state.profile.ai || !state.profile.voice) return;
  voice.speak(text, state.P.speech, { onStart: () => setTalking(true), onEnd: () => setTalking(false) });
}

async function sendChat(text) {
  text = text.trim();
  if (!text || !state.profile.ai) return;
  pushMsg('me', text);
  const typing = pushMsg('ai', '');
  typing.classList.add('typing');
  typing.innerHTML = '<span class="who">✦</span><span class="dots3"><i></i><i></i><i></i></span>';
  await new Promise((r) => setTimeout(r, 450 + Math.random() * 400));
  typing.remove();

  const r = brain.reply(text, brainCtx());
  pushMsg('ai', r.text);

  if (r.action === 'name') {
    state.profile.name = r.name;
    saveProfile();
    applyStrings();
    renderFeed();
  }
  // Journal-y messages are part of the user's story, so they're saved to today.
  if (r.kind === 'reflect') {
    await saveEntry({ id: uid(), date: state.today, type: 'chat', createdAt: Date.now(), text, reply: r.text });
    if (state.selected === state.today) renderFeed();
    renderStories();
    renderCalendar();
    renderPatterns();
    renderHeader();
  }

  if (r.action === 'off') {
    await voice.speak(r.text, state.P.speech, { onStart: () => setTalking(true), onEnd: () => setTalking(false) });
    setAI(false);
  } else {
    say(r.text);
  }
}

function startTalk() {
  if (!voice.canListen) {
    toast(state.P.transcriptUnsupported);
    return;
  }
  voice.stopSpeaking();
  const input = $('#chatInput');
  input.value = '';
  $('#talkBtn').classList.add('on');
  state.talkDownAt = Date.now();
  state.talkListener = voice.listen(state.P.speech, {
    onText: (final, interim) => { input.value = `${final} ${interim}`.trim(); },
    onEnd: (final) => {
      $('#talkBtn').classList.remove('on');
      state.talkListener = null;
      const text = final || input.value;
      input.value = '';
      sendChat(text);
    },
  });
  if (!state.talkListener) $('#talkBtn').classList.remove('on');
}

function stopTalk() {
  state.talkListener?.stop();
}

/* ------------------------------------------------------------------ rewind (reels) */

let reelObserver;
function openReels() {
  const vids = state.all.filter((e) => e.type === 'video' && e.blob).sort((a, b) => b.createdAt - a.createdAt);
  if (!vids.length) {
    toast(state.P.noVideos);
    return;
  }
  voice.stopSpeaking();
  const track = $('#reelsTrack');
  track.innerHTML = '';
  const urls = [];
  reelObserver?.disconnect();
  reelObserver = new IntersectionObserver((items) => {
    for (const it of items) {
      const v = it.target.querySelector('video');
      if (it.isIntersecting) v.play().catch(() => {});
      else v.pause();
    }
  }, { root: track, threshold: 0.6 });

  for (const e of vids) {
    const reel = document.createElement('section');
    reel.className = 'reel';
    reel.innerHTML = `
      <video playsinline loop ${e.poster ? `poster="${e.poster}"` : ''}></video>
      <div class="reel-info"><b>${esc(fmt.long(e.date))}</b>${e.transcript ? `<p>${esc(e.transcript)}</p>` : ''}</div>
      <div class="reel-side">
        <button type="button" class="fav ${e.fav ? 'liked' : ''}">${e.fav ? '♥' : '♡'}</button>
        <button type="button" class="go">▦</button>
      </div>`;
    const u = URL.createObjectURL(e.blob);
    urls.push(u);
    const v = reel.querySelector('video');
    v.src = u;
    v.onclick = () => (v.paused ? v.play() : v.pause());
    reel.querySelector('.fav').onclick = (ev) => {
      e.fav = !e.fav;
      ev.currentTarget.classList.toggle('liked', e.fav);
      ev.currentTarget.textContent = e.fav ? '♥' : '♡';
      updateEntry(e);
    };
    reel.querySelector('.go').onclick = () => { closeReels(); select(e.date); };
    track.append(reel);
    reelObserver.observe(reel);
  }
  $('#reels').hidden = false;
  $('#reels').dataset.urls = JSON.stringify(urls);
  track.scrollTop = 0;
}

function closeReels() {
  const reels = $('#reels');
  reels.querySelectorAll('video').forEach((v) => v.pause());
  reelObserver?.disconnect();
  try { JSON.parse(reels.dataset.urls || '[]').forEach((u) => URL.revokeObjectURL(u)); } catch { /* noop */ }
  $('#reelsTrack').innerHTML = '';
  reels.hidden = true;
  renderFeed();
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  $('#micBtn').onclick = requestMic;
  $('#micRetry').onclick = requestMic;
  $('#micSkip').onclick = () => enter();

  $('#backToday').onclick = () => select(state.today);
  $('#calPrev').onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); renderCalendar(); };
  $('#calNext').onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); renderCalendar(); };

  $('#camOn').onclick = startCamera;
  $('#recordBtn').onclick = () => (state.recorder ? stopRecording() : startRecording());
  $('#uploadInput').onchange = (e) => {
    handleUpload(e.target.files[0]);
    e.target.value = '';
  };

  $('#composeForm').onsubmit = (e) => {
    e.preventDefault();
    const ta = $('#composeText');
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    postNote(text);
  };
  $('#composeText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#composeForm').requestSubmit();
  });

  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const text = input.value;
    input.value = '';
    sendChat(text);
  };

  // Tap to toggle, or press-and-hold like a walkie-talkie.
  const talk = $('#talkBtn');
  talk.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state.talkListener) stopTalk();
    else startTalk();
  });
  talk.addEventListener('pointerup', () => {
    if (state.talkListener && Date.now() - state.talkDownAt > 450) stopTalk();
  });

  $('#aiToggle').onclick = () => setAI(!state.profile.ai);
  $('#voiceBtn').onclick = () => {
    state.profile.voice = !state.profile.voice;
    applyProfile();
    saveProfile();
  };
  $('#langSelect').onchange = (e) => {
    state.lang = e.target.value;
    state.P = pack(state.lang);
    setLang(state.lang);
    applyStrings();
    renderAll();
  };

  $('#rewindBtn').onclick = openReels;
  $('#reelsClose').onclick = closeReels;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#reels').hidden) closeReels();
  });

  // Roll over to the new day at midnight so the journal is always on "today".
  setInterval(() => {
    const now = dayKey();
    if (now === state.today) return;
    const wasOnToday = state.selected === state.today;
    state.today = now;
    if (wasOnToday) select(now);
    else renderAll();
  }, 60 * 1000);
}

applyStrings();
wire();
