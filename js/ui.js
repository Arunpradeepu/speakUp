'use strict';
/* ═══════════════════════════════════════════
   UI — helpers, screens, lock, home, settings
═══════════════════════════════════════════ */
const $ = id => document.getElementById(id);

/* ── helpers ── */
function fmtT(s) {
  s = Math.max(0, Math.round(s || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtDay(key) {
  if (key === DB.dayKey()) return 'Today';
  if (key === DB.dayKey(Date.now() - 864e5)) return 'Yesterday';
  return new Date(key + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
}
let _toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function setMsg(el, text, isErr) {
  el.textContent = text;
  el.classList.toggle('err', !!isErr);
}

/* ── screens ── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  const name = id.replace('Screen', '');
  document.body.dataset.screen = name;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.go === name));
  window.scrollTo(0, 0);
  // leaving the session screen: make sure the mic is released
  if (id !== 'sessionScreen' && typeof Session !== 'undefined') Session.release();
}

function stopAudio() {
  const a = $('audioPlayer');
  if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
}
function goHome() { showScreen('homeScreen'); loadHome(); }

/* ═════════ PIN LOCK ═════════ */
const Lock = { buf: '', setup: false };

function initLock() {
  Lock.setup = !Settings.pin;
  Lock.buf = '';
  $('pinLabel').textContent = Lock.setup ? 'Create a 4-digit PIN' : 'Enter your PIN';
  $('pinHint').textContent = '';
  renderDots();
}
function renderDots() {
  document.querySelectorAll('.pin-dot').forEach((d, i) => {
    d.classList.remove('error');
    d.classList.toggle('filled', i < Lock.buf.length);
  });
}
function pinInput(val) {
  if (val === 'del') { Lock.buf = Lock.buf.slice(0, -1); renderDots(); return; }
  if (val === 'ok')  { if (Lock.buf.length === 4) submitPin(); return; }
  if (Lock.buf.length >= 4) return;
  Lock.buf += val;
  renderDots();
  if (Lock.buf.length === 4) submitPin();
}
function submitPin() {
  if (Lock.setup) {
    Settings.pin = Lock.buf;
    toast('PIN created');
    goHome();
  } else if (Lock.buf === Settings.pin) {
    goHome();
  } else {
    document.querySelectorAll('.pin-dot').forEach(d => d.classList.add('error'));
    $('pinHint').textContent = 'Incorrect PIN. Try again.';
    setTimeout(() => { Lock.buf = ''; renderDots(); }, 650);
  }
}
document.querySelectorAll('.num-btn').forEach(b =>
  b.addEventListener('click', () => pinInput(b.dataset.num)));

$('homeLockBtn').addEventListener('click', () => {
  stopAudio();
  initLock();
  showScreen('lockScreen');
});

/* ═════════ HOME ═════════ */
function calcStreak(days) {
  const set = new Set(days);
  let t = Date.now();
  if (!set.has(DB.dayKey(t))) t -= 864e5;
  let n = 0;
  while (set.has(DB.dayKey(t))) { n++; t -= 864e5; }
  return n;
}

async function loadHome() {
  $('homeDate').textContent = new Date().toLocaleDateString('en-IN',
    { weekday: 'long', day: 'numeric', month: 'long' });

  const topics = (await DB.allTopics()).filter(t => !t.skipped);
  const byDay = {};
  topics.forEach(t => (byDay[t.day] = byDay[t.day] || []).push(t));
  const days = Object.keys(byDay).sort().reverse();

  const todaySecs = (byDay[DB.dayKey()] || []).reduce((a, t) => a + (t.duration || 0), 0);
  $('statStreak').textContent = calcStreak(days);
  $('statTopics').textContent = topics.length;
  $('statToday').textContent = Math.round(todaySecs / 60) + 'm';

  const list = $('daysList');
  list.innerHTML = '';
  if (!days.length) {
    list.innerHTML = '<div class="empty">Nothing here yet.<br>Tap the mic to start your first topic.</div>';
    return;
  }
  days.forEach((day, i) => {
    const ts = byDay[day];
    const mins = Math.max(1, Math.round(ts.reduce((a, t) => a + (t.duration || 0), 0) / 60));
    const card = document.createElement('div');
    card.className = 'day-card';
    card.style.animationDelay = (i * 40) + 'ms';
    card.innerHTML = `
      <div>
        <div class="day-title">${esc(fmtDay(day))}</div>
        <div class="muted">${ts.length} topic${ts.length > 1 ? 's' : ''} · ${mins} min</div>
      </div>
      <span class="muted">Read &amp; listen ›</span>`;
    card.addEventListener('click', () => {
      if (typeof Results !== 'undefined') Results.openDay(day);
      else toast('Results screen comes in chunk 6');
    });
    list.appendChild(card);
  });
}

/* ── mic button + bottom nav ── */
$('newSessionBtn').addEventListener('click', () => {
  if (typeof Session !== 'undefined') Session.open();
  else toast('Session screen comes in chunk 5');
});
document.querySelectorAll('.nav-item').forEach(b =>
  b.addEventListener('click', () => {
    if (b.dataset.go === 'home') goHome();
    else {
      showScreen('wordsScreen');
      if (typeof Words !== 'undefined') Words.load();
      else $('wordsList').innerHTML = '<div class="empty">Words come in chunk 7.</div>';
    }
  }));

/* ═════════ SETTINGS ═════════ */
$('homeSettingsBtn').addEventListener('click', openSettings);
$('settingsBack').addEventListener('click', goHome);

const MODEL_CACHE = 'vd_models';
const cachedModels = () => {
  try { return JSON.parse(localStorage.getItem(MODEL_CACHE)) || []; } catch (_) { return []; }
};
const isStt = id => /whisper/i.test(id);
const isLlm = id => !/whisper|guard|tts|orpheus|playai|embed/i.test(id);

function fillSelect(sel, ids, current) {
  const list = (!current || ids.includes(current)) ? ids : [current, ...ids];
  sel.innerHTML = list.map(id =>
    `<option value="${esc(id)}"${id === current ? ' selected' : ''}>${esc(id)}</option>`).join('');
}
function renderModelSelects() {
  const ids = cachedModels();
  fillSelect($('sttModelSelect'), ids.filter(isStt), Settings.sttModel);
  fillSelect($('llmModelSelect'), ids.filter(isLlm), Settings.llmModel);
  $('sttModelManual').value = '';
  $('llmModelManual').value = '';
}

async function refreshModels(silent) {
  const m = $('modelsMsg');
  if (!Settings.groqKey) { if (!silent) setMsg(m, 'Save your Groq key first', true); return; }
  if (!silent) setMsg(m, 'Fetching models…');
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${Settings.groqKey}` },
    });
    if (!r.ok) throw new Error(`Groq ${r.status}`);
    const d = await r.json();
    const ids = (d.data || []).map(x => x.id).sort();
    localStorage.setItem(MODEL_CACHE, JSON.stringify(ids));
    renderModelSelects();
    if (!silent) setMsg(m, `Found ${ids.length} models`);
  } catch (err) {
    if (!silent) setMsg(m, err.message || 'Could not fetch models', true);
  }
}

function openSettings() {
  $('groqKeyInput').value = Settings.groqKey ? '••••••••' : '';
  setMsg($('groqSaveMsg'), '');
  setMsg($('modelsMsg'), '');
  setMsg($('pinSaveMsg'), '');
  $('currentPinInput').value = '';
  $('newPinInput').value = '';
  renderModelSelects();
  showScreen('settingsScreen');
  if (Settings.groqKey && !cachedModels().length) refreshModels(true);
}

$('saveGroqBtn').addEventListener('click', () => {
  const v = $('groqKeyInput').value.trim();
  const m = $('groqSaveMsg');
  if (!v || v === '••••••••') return setMsg(m, 'Enter a valid key', true);
  if (!v.startsWith('gsk_'))  return setMsg(m, 'Key should start with gsk_', true);
  Settings.groqKey = v;
  $('groqKeyInput').value = '••••••••';
  setMsg(m, 'Key saved');
  refreshModels(true);
});

$('refreshModelsBtn').addEventListener('click', () => refreshModels(false));

$('sttModelSelect').addEventListener('change', () => { $('sttModelManual').value = ''; });
$('llmModelSelect').addEventListener('change', () => { $('llmModelManual').value = ''; });

$('saveModelsBtn').addEventListener('click', () => {
  const stt = $('sttModelManual').value.trim() || $('sttModelSelect').value;
  const llm = $('llmModelManual').value.trim() || $('llmModelSelect').value;
  if (!stt || !llm) return setMsg($('modelsMsg'), 'Pick or type both models', true);
  Settings.sttModel = stt;
  Settings.llmModel = llm;
  renderModelSelects();
  setMsg($('modelsMsg'), 'Models saved');
});

$('savePinBtn').addEventListener('click', () => {
  const cur = $('currentPinInput').value.trim();
  const nw  = $('newPinInput').value.trim();
  const m   = $('pinSaveMsg');
  if (Settings.pin && cur !== Settings.pin) {
    $('currentPinInput').value = '';
    return setMsg(m, 'Current PIN is incorrect', true);
  }
  if (!/^\d{4}$/.test(nw)) return setMsg(m, 'New PIN must be exactly 4 digits', true);
  Settings.pin = nw;
  $('currentPinInput').value = '';
  $('newPinInput').value = '';
  setMsg(m, 'PIN updated');
});

$('deleteAllBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL recordings, topics and feedback? This cannot be undone.')) return;
  await DB.clearAll();
  toast('Everything deleted');
  goHome();
});

/* ═════════ START ═════════ */
(async () => {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) {}
  await DB.open();
  initLock();
})();

//showScreen