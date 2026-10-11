import { Ambient } from './ambient.js';

// ---------- small helpers ----------

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

const $ = (id) => document.getElementById(id);

function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
  return null;
}

async function cmd(body) {
  const res = await fetch('/api/cmd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn('command failed', body, err.error);
  }
}

// ---------- clock sync ----------
// Estimate the offset between this device's clock and the server's, using the
// round trip with the lowest latency out of a few samples.

let clockOffset = 0;

async function syncClock() {
  let best = null;
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    try {
      const { now } = await (await fetch('/api/time', { cache: 'no-store' })).json();
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { rtt, offset: now - (t0 + t1) / 2 };
    } catch { /* try again */ }
  }
  if (best) clockOffset = best.offset;
}

const serverNow = () => Date.now() + clockOffset;

function positionOf(pb) {
  if (!pb || pb.kind !== 'track') return 0;
  if (pb.pausedAt != null) return pb.pausedAt;
  return (serverNow() - pb.startedAt) / 1000;
}

// ---------- state ----------

let state = null;
let library = [];
let sliderBusy = false;
let renderPending = false;

const zoneOf = (roomName) => state && state.zones.find((z) => z.rooms.includes(roomName));
const zoneLabel = (z) => z.rooms.join(' + ') || z.id;

// ---------- speaker mode ----------
// A device in speaker mode plays its room's zone. Everything goes through one
// gain node so room volume works on every browser, including iOS Safari.

const speaker = {
  room: store('hm.room') || '',
  enabled: false,
  latencyMs: Number(store('hm.latency')) || 0,
  ctx: null,
  gain: null,
  audio: null,
  ambient: null,
  pb: null,
  zoneId: null,
};

function setupSpeakerAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  speaker.ctx = new Ctx();
  speaker.gain = speaker.ctx.createGain();
  speaker.gain.connect(speaker.ctx.destination);
  speaker.audio = new Audio();
  speaker.audio.preload = 'auto';
  speaker.audio.preservesPitch = true;
  speaker.ctx.createMediaElementSource(speaker.audio).connect(speaker.gain);
  speaker.ambient = new Ambient(speaker.ctx, speaker.gain);
  speaker.audio.addEventListener('ended', () => {
    const pb = speaker.pb;
    if (pb && pb.kind === 'track') {
      cmd({ cmd: 'ended', zone: speaker.zoneId, trackId: pb.trackId, startedAt: pb.startedAt });
    }
  });
}

function applySpeaker() {
  if (!speaker.enabled || !state) return;
  const room = state.rooms.find((r) => r.name === speaker.room);
  const zone = zoneOf(speaker.room);
  if (!room || !zone) return;
  const ctx = speaker.ctx;
  speaker.gain.gain.setTargetAtTime(room.volume * room.volume, ctx.currentTime, 0.05);
  speaker.zoneId = zone.id;
  const pb = zone.playback;
  speaker.pb = pb;
  const audio = speaker.audio;

  if (pb.kind === 'track') {
    speaker.ambient.stop();
    const src = `/media/${pb.trackId}`;
    if (!audio.src.endsWith(src)) {
      audio.src = src;
      audio.load();
    }
    if (pb.pausedAt != null) {
      audio.pause();
      if (Math.abs(audio.currentTime - pb.pausedAt) > 0.25) audio.currentTime = pb.pausedAt;
    }
    syncTrack();
  } else {
    audio.pause();
    if (pb.kind === 'ambient') speaker.ambient.play(pb.scene);
    else speaker.ambient.stop();
  }
  renderSpeakerStatus();
}

// Keep the local <audio> element on the shared timeline. Small drift is
// corrected by nudging playback speed; large drift by seeking.
function syncTrack() {
  const pb = speaker.pb;
  const audio = speaker.audio;
  if (!speaker.enabled || !pb || pb.kind !== 'track' || pb.pausedAt != null) return;
  const target = positionOf(pb) + speaker.latencyMs / 1000;
  if (target < 0) {
    // Scheduled to start shortly; get ready and wait.
    if (!audio.paused) audio.pause();
    if (audio.currentTime !== 0) audio.currentTime = 0;
    return;
  }
  if (pb.duration && target > pb.duration + 1) return; // finished; waiting for next
  if (audio.paused) {
    audio.currentTime = target;
    audio.play().catch((e) => console.warn('play blocked', e));
    return;
  }
  const drift = audio.currentTime - target;
  if (Math.abs(drift) > 0.4) {
    audio.currentTime = target;
    audio.playbackRate = 1;
  } else if (Math.abs(drift) > 0.03) {
    audio.playbackRate = 1 - Math.max(-0.05, Math.min(0.05, drift * 0.5));
  } else {
    audio.playbackRate = 1;
  }
}

setInterval(syncTrack, 250);

function renderSpeakerStatus() {
  const detail = $('speaker-detail');
  const btn = $('speaker-enable');
  detail.hidden = !speaker.room;
  btn.hidden = !speaker.room || speaker.enabled;
  if (!speaker.room) return;
  const zone = zoneOf(speaker.room);
  let what = 'silent';
  if (zone && zone.playback.kind === 'track' && zone.playback.track) what = `playing ${zone.playback.track.title}`;
  if (zone && zone.playback.kind === 'ambient') what = `playing ${zone.playback.scene}`;
  $('speaker-status').textContent = speaker.enabled
    ? `Speaker for ${speaker.room}, ${what}.`
    : `Will play ${speaker.room} once started.`;
}

function initSpeakerControls() {
  const sel = $('speaker-room');
  sel.addEventListener('change', () => {
    speaker.room = sel.value;
    store('hm.room', speaker.room);
    if (!speaker.room && speaker.enabled) {
      speaker.audio.pause();
      speaker.ambient.stop();
    }
    connect(); // re-register so the server counts this speaker in the right room
    renderSpeakerStatus();
  });
  $('speaker-enable').addEventListener('click', async () => {
    if (!speaker.ctx) setupSpeakerAudio();
    await speaker.ctx.resume();
    speaker.enabled = true;
    applySpeaker();
  });
  const lat = $('speaker-latency');
  lat.value = speaker.latencyMs;
  lat.addEventListener('change', () => {
    speaker.latencyMs = Number(lat.value) || 0;
    store('hm.latency', String(speaker.latencyMs));
  });
}

function fillSpeakerRooms() {
  const sel = $('speaker-room');
  if (sel.options.length > 1) return;
  for (const r of state.rooms) sel.append(el('option', { value: r.name }, `plays in ${r.name}`));
  if (!state.rooms.some((r) => r.name === speaker.room)) speaker.room = '';
  sel.value = speaker.room;
}

// ---------- rendering the rooms ----------

function sliderDone() {
  sliderBusy = false;
  if (renderPending) { renderPending = false; render(); }
}

function render() {
  if (!state) return;
  if (sliderBusy) { renderPending = true; return; }
  fillSpeakerRooms();
  renderSpeakerStatus();
  renderTargets();
  const box = $('zones');
  box.replaceChildren(...state.zones.map(renderZone));
  tick();
}

function renderZone(z) {
  const pb = z.playback;
  const playing = pb.kind === 'track' && pb.pausedAt == null;
  let now;
  if (pb.kind === 'track' && pb.track) {
    now = el('div', { class: 'now' }, pb.track.title,
      el('span', { class: 'sub' }, [pb.track.artist, pb.track.album].filter(Boolean).length
        ? ` · ${[pb.track.artist, pb.track.album].filter(Boolean).join(' · ')}` : ''));
  } else if (pb.kind === 'ambient') {
    now = el('div', { class: 'now' }, `Ambient: ${pb.scene}`);
  } else {
    now = el('div', { class: 'now sub' }, 'Silent');
  }

  const z1 = (c) => () => cmd({ cmd: c, zone: z.id });
  const controls = el('div', { class: 'row controls' },
    el('button', { onclick: z1('prev'), disabled: pb.kind !== 'track', title: 'Previous' }, '⏮'),
    el('button', { class: 'primary', onclick: z1(playing ? 'pause' : 'resume'), disabled: pb.kind !== 'track', title: playing ? 'Pause' : 'Play' }, playing ? '⏸' : '▶'),
    el('button', { onclick: z1('next'), disabled: pb.kind !== 'track', title: 'Next' }, '⏭'),
    el('button', { onclick: z1('stop'), disabled: pb.kind === 'idle', title: 'Stop' }, '⏹'),
    el('span', { class: 'small', 'data-time': z.id }),
  );

  const progress = pb.kind === 'track'
    ? el('div', {
      class: 'progress', title: 'Seek',
      onclick: (e) => {
        if (!pb.duration) return;
        const r = e.currentTarget.getBoundingClientRect();
        cmd({ cmd: 'seek', zone: z.id, seconds: ((e.clientX - r.left) / r.width) * pb.duration });
      },
    }, el('div', { 'data-bar': z.id }))
    : null;

  const scenes = el('div', { class: 'row scenes' },
    el('span', { class: 'small' }, 'Ambient'),
    state.scenes.map((s) => el('button', {
      class: pb.kind === 'ambient' && pb.scene === s ? 'on' : 'ghost',
      onclick: () => cmd({ cmd: 'ambient', zone: z.id, scene: s }),
    }, s)));

  const sleepSel = el('select', {
    'aria-label': 'Sleep timer',
    onchange: (e) => cmd({ cmd: 'sleep', zone: z.id, minutes: Number(e.target.value) }),
  }, [0, 15, 30, 60, 90].map((m) => el('option', { value: m }, m ? `${m} min` : 'off')));
  const sleepRow = el('div', { class: 'row small' }, 'Sleep timer', sleepSel,
    z.sleepAt ? el('span', { 'data-sleep': z.id }) : null);

  const others = state.zones.filter((o) => o.id !== z.id);
  const rooms = z.rooms.map((name) => {
    const r = state.rooms.find((x) => x.name === name);
    const vol = el('input', {
      type: 'range', min: 0, max: 100, value: Math.round(r.volume * 100), 'aria-label': `${name} volume`,
      onpointerdown: () => { sliderBusy = true; },
      oninput: (e) => cmd({ cmd: 'volume', room: name, value: e.target.value / 100 }),
      onchange: sliderDone,
      onpointerup: sliderDone,
      onpointercancel: sliderDone,
    });
    const move = el('select', {
      'aria-label': `Move ${name}`,
      onchange: (e) => {
        const v = e.target.value;
        if (v === '__leave') cmd({ cmd: 'leave', room: name });
        else if (v) cmd({ cmd: 'join', room: name, zone: v });
      },
    },
    el('option', { value: '' }, 'Group…'),
    z.rooms.length > 1 ? el('option', { value: '__leave' }, 'Play on its own') : null,
    others.map((o) => el('option', { value: o.id }, `Join ${zoneLabel(o)}`)));
    return el('div', { class: 'room' },
      el('span', { class: 'name', title: r.speakers ? `${r.speakers} speaker(s) connected` : 'No speaker connected' },
        el('span', { class: `dot${r.speakers ? ' live' : ''}` }), name),
      vol, move);
  });

  const upNext = z.upNext.length && pb.kind === 'track'
    ? el('ol', { class: 'upnext' }, z.upNext.map((t) => el('li', {}, `${t.title}${t.artist ? ` · ${t.artist}` : ''}`)))
    : null;

  const groupAll = others.length
    ? el('button', { class: 'ghost small', onclick: () => cmd({ cmd: 'groupAll', zone: z.id }) }, 'Whole house')
    : null;

  return el('div', { class: 'panel zone' },
    el('div', { class: 'zone-head' }, el('h2', {}, zoneLabel(z)), groupAll),
    now, progress, controls, scenes, sleepRow, rooms, upNext);
}

// Update progress bars and timers without re-rendering everything.
function tick() {
  if (!state) return;
  for (const z of state.zones) {
    const pb = z.playback;
    const t = document.querySelector(`[data-time="${z.id}"]`);
    if (t && pb.kind === 'track') {
      const pos = Math.max(0, positionOf(pb));
      t.textContent = pb.duration ? `${fmtTime(pos)} / ${fmtTime(pb.duration)}` : fmtTime(pos);
      const bar = document.querySelector(`[data-bar="${z.id}"]`);
      if (bar && pb.duration) bar.style.width = `${Math.min(100, (pos / pb.duration) * 100)}%`;
    }
    const s = document.querySelector(`[data-sleep="${z.id}"]`);
    if (s && z.sleepAt) s.textContent = `stops in ${fmtTime((z.sleepAt - serverNow()) / 1000)}`;
  }
}
setInterval(tick, 500);

// ---------- library ----------

function renderTargets() {
  const sel = $('lib-target');
  const prev = sel.value || store('hm.target');
  sel.replaceChildren(...state.zones.map((z) => el('option', { value: z.id }, zoneLabel(z))));
  const fallback = zoneOf(speaker.room) || state.zones[0];
  sel.value = state.zones.some((z) => z.id === prev) ? prev : (fallback ? fallback.id : '');
}

function filtered() {
  const q = $('lib-search').value.trim().toLowerCase();
  if (!q) return library;
  const words = q.split(/\s+/);
  return library.filter((t) => {
    const hay = `${t.artist} ${t.album} ${t.title}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const RENDER_LIMIT = 300;

function renderLibrary() {
  const list = $('lib-list');
  const rows = filtered();
  $('lib-count').textContent = `${library.length} tracks`;
  if (rows.length === 0) {
    list.replaceChildren(el('li', { class: 'empty' },
      library.length ? 'No matches.' : 'No music found. Point MUSIC_DIR at your library and press Rescan.'));
    return;
  }
  const target = () => $('lib-target').value;
  const items = rows.slice(0, RENDER_LIMIT).map((t) => el('li', {},
    el('div', { class: 'meta' },
      el('div', {}, t.title),
      el('div', { class: 'small' }, [t.artist, t.album].filter(Boolean).join(' · '))),
    el('button', { title: 'Play now', onclick: () => cmd({ cmd: 'play', zone: target(), trackIds: [t.id] }) }, '▶'),
    el('button', {
      title: 'Play this album from here',
      onclick: () => {
        const album = library.filter((x) => x.album === t.album && x.artist === t.artist);
        cmd({ cmd: 'play', zone: target(), trackIds: album.map((x) => x.id), index: album.indexOf(t) });
      },
    }, '◎'),
    el('button', { title: 'Add to queue', onclick: () => cmd({ cmd: 'enqueue', zone: target(), trackIds: [t.id] }) }, '+')));
  if (rows.length > RENDER_LIMIT) {
    items.push(el('li', { class: 'empty' }, `${rows.length - RENDER_LIMIT} more; refine the search.`));
  }
  list.replaceChildren(...items);
}

async function loadLibrary() {
  try {
    const res = await fetch('/api/library', { cache: 'no-store' });
    const data = await res.json();
    library = data.tracks;
    document.querySelector('#lib-count').previousElementSibling.textContent =
      data.source === 'playlist' ? 'Playlist' : 'Library';
  } catch { library = []; }
  renderLibrary();
}

function initLibraryControls() {
  let t;
  $('lib-search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderLibrary, 120); });
  $('lib-target').addEventListener('change', (e) => store('hm.target', e.target.value));
  $('lib-rescan').addEventListener('click', async () => {
    $('lib-rescan').disabled = true;
    await fetch('/api/rescan', { method: 'POST' });
    await loadLibrary();
    $('lib-rescan').disabled = false;
  });
  const playResults = (shuffle) => {
    const ids = filtered().map((x) => x.id);
    if (shuffle) {
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
    }
    if (ids.length) cmd({ cmd: 'play', zone: $('lib-target').value, trackIds: ids });
  };
  $('lib-play-all').addEventListener('click', () => playResults(false));
  $('lib-shuffle').addEventListener('click', () => playResults(true));
}

// ---------- live connection ----------

let source = null;

function connect() {
  if (source) source.close();
  const qs = speaker.room ? `?speaker=${encodeURIComponent(speaker.room)}` : '';
  source = new EventSource(`/api/events${qs}`);
  const conn = $('conn');
  source.addEventListener('open', () => { conn.textContent = 'connected'; conn.className = 'conn ok'; syncClock(); });
  source.addEventListener('error', () => { conn.textContent = 'reconnecting…'; conn.className = 'conn bad'; });
  source.addEventListener('library', () => loadLibrary());
  source.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    render();
    applySpeaker();
  });
}

initSpeakerControls();
initLibraryControls();
syncClock().then(connect);
setInterval(syncClock, 60000);
loadLibrary();

// Debug hook for checking speaker sync from the browser console or tests.
window.__hm = () => ({
  room: speaker.room,
  enabled: speaker.enabled,
  paused: speaker.audio ? speaker.audio.paused : null,
  position: speaker.audio ? speaker.audio.currentTime : null,
  expected: speaker.pb ? positionOf(speaker.pb) : null,
  scene: speaker.ambient ? speaker.ambient.scene : null,
  clockOffset,
});
