/* ══════════════════════════════════════════
   JOURNAL — app.js  (clean rewrite)
   Fixes: PIN auth · back nav · play · delete · title
══════════════════════════════════════════ */
'use strict';

/* ════════════════════════════════════════
   INDEXEDDB
   'entries' store  → keyPath:'id' (inline key)
   'audio'   store  → no keyPath   (explicit key)
════════════════════════════════════════ */
const DB_NAME = 'VoiceDiaryDB', DB_VER = 2;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('entries'))
        db.createObjectStore('entries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio'))
        db.createObjectStore('audio');
    };
    r.onsuccess = e => { _db = e.target.result; res(_db); };
    r.onerror   = e => rej(e.target.error);
  });
}

function idbSetEntry(val) {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction('entries', 'readwrite');
    tx.objectStore('entries').put(val);
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  }));
}
function idbSetAudio(key, val) {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction('audio', 'readwrite');
    tx.objectStore('audio').put(val, key);
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  }));
}
function idbGet(store, key) {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r  = tx.objectStore(store).get(key);
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  }));
}
function idbDelete(store, key) {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  }));
}
function idbAllEntries() {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction('entries', 'readonly');
    const r  = tx.objectStore('entries').getAll();
    r.onsuccess = e => res(e.target.result.sort((a, b) => b.createdAt - a.createdAt));
    r.onerror   = e => rej(e.target.error);
  }));
}
function idbClearAll() {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction(['entries', 'audio'], 'readwrite');
    tx.objectStore('entries').clear();
    tx.objectStore('audio').clear();
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  }));
}

/* ════════════════════════════════════════
   SETTINGS — localStorage
════════════════════════════════════════ */
const LS = {
  get pin()      { return localStorage.getItem('vd_pin') || ''; },
  set pin(v)     { localStorage.setItem('vd_pin', v); },
  get groqKey()  { return localStorage.getItem('vd_groq') || ''; },
  set groqKey(v) { localStorage.setItem('vd_groq', v); },
};

/* ════════════════════════════════════════
   STATE
════════════════════════════════════════ */
const S = {
  // PIN
  pinBuffer:     '',
  isSetup:       false,

  // Entry
  currentId:     null,

  // Recording
  mediaRecorder: null,
  audioChunks:   [],
  mimeType:      '',
  recSeconds:    0,
  recInterval:   null,
  isRecording:   false,

  // Player
  playerActive:  false,
};

/* ════════════════════════════════════════
   HELPERS
════════════════════════════════════════ */
const $ = id => document.getElementById(id);

function fmtT(s) {
  s = Math.max(0, Math.round(s || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}
function fmtShort(ts) {
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function getSupportedMime() {
  const list = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  return list.find(t => MediaRecorder.isTypeSupported(t)) || '';
}
function mimeToExt(m) {
  if (!m) return 'webm';
  if (m.includes('mp4')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  return 'webm';
}

/* ════════════════════════════════════════
   SCREENS
════════════════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

/* ════════════════════════════════════════
   TOAST
════════════════════════════════════════ */
let _toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ════════════════════════════════════════
   PLAYER helpers  (safe — won't crash if elements missing)
════════════════════════════════════════ */
function setPlayIcon(playing) {
  const pi = $('playIcon'), pa = $('pauseIcon');
  if (!pi || !pa) return;
  pi.style.display = playing ? 'none' : '';
  pa.style.display = playing ? ''     : 'none';
}

function stopPlayer() {
  const a = $('audioPlayer');
  if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
  setPlayIcon(false);
  const wp = $('waveformProgress');
  if (wp) wp.style.width = '0%';
  S.playerActive = false;
}

/* ════════════════════════════════════════
   PIN SCREEN
════════════════════════════════════════ */
function initLock() {
  S.isSetup   = !LS.pin;
  S.pinBuffer = '';
  $('pinLabel').textContent = S.isSetup ? 'Create a 4-digit PIN' : 'Enter your PIN';
  $('pinHint').textContent  = '';
  renderDots();
}

function renderDots() {
  document.querySelectorAll('.pin-dot').forEach((d, i) => {
    d.classList.remove('error');
    d.classList.toggle('filled', i < S.pinBuffer.length);
  });
}

function pinInput(val) {
  if (val === 'del') { S.pinBuffer = S.pinBuffer.slice(0, -1); renderDots(); return; }
  if (val === 'ok')  { if (S.pinBuffer.length === 4) submitPin(); return; }
  if (S.pinBuffer.length >= 4) return;
  S.pinBuffer += val;
  renderDots();
  if (S.pinBuffer.length === 4) submitPin();
}

function submitPin() {
  if (S.isSetup) {
    LS.pin = S.pinBuffer;
    toast('PIN created');
    showScreen('homeScreen');
    loadHome();
  } else {
    if (S.pinBuffer === LS.pin) {
      showScreen('homeScreen');
      loadHome();
    } else {
      document.querySelectorAll('.pin-dot').forEach(d => d.classList.add('error'));
      $('pinHint').textContent = 'Incorrect PIN. Try again.';
      setTimeout(() => { S.pinBuffer = ''; renderDots(); }, 650);
    }
  }
}

document.querySelectorAll('.num-btn').forEach(btn =>
  btn.addEventListener('click', () => pinInput(btn.dataset.num))
);

/* ════════════════════════════════════════
   SETTINGS SCREEN
   — PIN change requires current PIN first
════════════════════════════════════════ */
$('homeSettingsBtn').addEventListener('click', openSettings);
$('homeLockBtn').addEventListener('click', () => {
  stopPlayer();
  initLock();
  showScreen('lockScreen');
});
$('settingsBack').addEventListener('click', () => {
  showScreen('homeScreen');
  loadHome();
});

function openSettings() {
  // Reset all fields
  $('currentPinInput').value   = '';
  $('newPinInput').value       = '';
  $('pinSaveMsg').textContent  = '';
  $('pinSaveMsg').style.color  = '';
  $('groqKeyInput').value      = LS.groqKey ? '••••••••' : '';
  $('groqSaveMsg').textContent = '';
  $('groqSaveMsg').style.color = '';
  showScreen('settingsScreen');
}

$('savePinBtn').addEventListener('click', () => {
  const cur = $('currentPinInput').value.trim();
  const nw  = $('newPinInput').value.trim();
  const m   = $('pinSaveMsg');

  // If a PIN already exists, require the current one
  if (LS.pin && cur !== LS.pin) {
    m.style.color  = 'var(--danger)';
    m.textContent  = 'Current PIN is incorrect';
    $('currentPinInput').value = '';
    return;
  }
  if (!/^\d{4}$/.test(nw)) {
    m.style.color = 'var(--danger)';
    m.textContent = 'New PIN must be exactly 4 digits';
    return;
  }

  LS.pin = nw;
  m.style.color = '';
  m.textContent = 'PIN updated successfully';
  $('currentPinInput').value = '';
  $('newPinInput').value     = '';
});

$('saveGroqBtn').addEventListener('click', () => {
  const v = $('groqKeyInput').value.trim();
  const m = $('groqSaveMsg');
  if (!v || v === '••••••••') {
    m.style.color = 'var(--danger)';
    m.textContent = 'Enter a valid key';
    return;
  }
  if (!v.startsWith('gsk_')) {
    m.style.color = 'var(--danger)';
    m.textContent = 'Key should start with gsk_...';
    return;
  }
  LS.groqKey = v;
  m.style.color = '';
  m.textContent = 'API key saved';
  $('groqKeyInput').value = '••••••••';
});

$('deleteAllBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL diary entries? This cannot be undone.')) return;
  await idbClearAll();
  toast('All entries deleted');
  showScreen('homeScreen');
  loadHome();
});

/* ════════════════════════════════════════
   HOME SCREEN
════════════════════════════════════════ */
async function loadHome() {
  $('homeDate').textContent = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  const entries = await idbAllEntries();
  const list    = $('entriesList');
  list.innerHTML = '';

  if (!entries.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-line"></div>
        <p class="empty-title">Nothing here yet</p>
        <p class="empty-sub">Tap the mic button to record your first entry</p>
      </div>`;
    return;
  }

  entries.forEach((entry, idx) => {
    const title   = entry.title || 'Untitled entry';
    const preview = entry.transcript
      ? esc(entry.transcript.slice(0, 72)) + (entry.transcript.length > 72 ? '…' : '')
      : '';

    // Outer wrapper
    const wrap = document.createElement('div');
    wrap.className = 'entry-wrap';
    wrap.style.animationDelay = (idx * 40) + 'ms';

    // ── Inline title edit row (sits above card) ──
    const editRow = document.createElement('div');
    editRow.className = 'entry-title-edit-row';
    editRow.innerHTML = `
      <span class="entry-title-label">${esc(title)}</span>
      <button class="entry-edit-btn" title="Rename">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
      <input class="entry-title-input-inline" type="text" maxlength="80" placeholder="Entry title…" value="${esc(title)}" />
      <button class="entry-edit-save" title="Save">&#10003;</button>
      <button class="entry-edit-cancel" title="Cancel">&#10005;</button>
    `;

    const labelEl  = editRow.querySelector('.entry-title-label');
    const editBtn  = editRow.querySelector('.entry-edit-btn');
    const inputEl  = editRow.querySelector('.entry-title-input-inline');
    const saveBtn  = editRow.querySelector('.entry-edit-save');
    const cancelBtn = editRow.querySelector('.entry-edit-cancel');

    function startEdit(e) {
      e.stopPropagation();
      editRow.classList.add('editing');
      inputEl.value = entry.title || '';
      inputEl.focus();
      inputEl.select();
    }
    function cancelEdit(e) {
      e && e.stopPropagation();
      editRow.classList.remove('editing');
      inputEl.value = entry.title || '';
    }
    async function commitEdit(e) {
      e && e.stopPropagation();
      const newTitle = inputEl.value.trim() || 'Untitled entry';
      editRow.classList.remove('editing');
      if (newTitle === (entry.title || 'Untitled entry')) return;
      entry.title = newTitle;
      labelEl.textContent = newTitle;
      // also update card heading
      const cardTitle = card.querySelector('.entry-card-title');
      if (cardTitle) cardTitle.textContent = newTitle;
      try {
        const stored = await idbGet('entries', entry.id);
        if (stored) { stored.title = newTitle; await idbSetEntry(stored); }
      } catch(err) { console.warn('Title save failed', err); }
      toast('Title updated');
    }

    editBtn.addEventListener('click', startEdit);
    saveBtn.addEventListener('click', commitEdit);
    cancelBtn.addEventListener('click', cancelEdit);
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
      if (e.key === 'Escape') cancelEdit();
    });
    // stop clicks inside editRow bubbling to card
    editRow.addEventListener('click', e => e.stopPropagation());

    // ── Card ──
    const card = document.createElement('div');
    card.className = 'entry-card';
    card.innerHTML = `
      <div class="entry-card-title">${esc(title)}</div>
      ${preview ? `<div class="entry-card-preview">${preview}</div>` : ''}
      <div class="entry-card-meta">
        <span class="entry-card-date">${fmtDate(entry.createdAt)}</span>
        <span class="entry-card-dur">${fmtT(entry.duration)}</span>
      </div>`;
    card.addEventListener('click', () => openEntry(entry.id));

    wrap.appendChild(editRow);
    wrap.appendChild(card);
    list.appendChild(wrap);
  });
}

$('newEntryBtn').addEventListener('click', openNewEntry);

/* ════════════════════════════════════════
   NEW ENTRY — RECORD SCREEN
════════════════════════════════════════ */
function openNewEntry() {
  S.currentId   = null;
  S.audioChunks = [];
  S.mimeType    = '';

  $('entryNavTitle').textContent    = 'New Entry';
  $('entryTitleInput').value        = '';
  $('playerArea').classList.add('hidden');
  $('transcriptArea').classList.add('hidden');
  $('recordSection').classList.remove('hidden');
  resetRecordUI();
  showScreen('entryScreen');
}

function resetRecordUI() {
  $('recordTimer').textContent      = '00:00';
  $('recordHint').textContent       = 'Tap to begin recording';
  $('recordRing').classList.remove('recording');
  $('recordBtn').classList.remove('recording');
  $('recordBtn').disabled           = false;
  $('recMicIcon').style.display     = '';
  $('recStopIcon').style.display    = 'none';
  $('recordControls').style.display = 'none';
  $('saveRecordBtn').disabled       = true;
  $('saveRecordBtn').textContent    = 'Save Entry';
}

// ── Back button — works from both record and playback views ──
$('entryBack').addEventListener('click', () => {
  hardStop();      // kills recording if active (safe noop otherwise)
  stopPlayer();    // pauses audio if playing (safe noop otherwise)
  showScreen('homeScreen');
  loadHome();
});

// ── Record / Stop toggle ──
$('recordBtn').addEventListener('click', () => {
  if (!S.isRecording) startRecording();
  else stopRecording();
});

$('cancelRecordBtn').addEventListener('click', () => {
  hardStop();
  showScreen('homeScreen');
  loadHome();
});

$('saveRecordBtn').addEventListener('click', saveEntry);

async function startRecording() {
  try {
    const stream    = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime      = getSupportedMime();
    S.mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    S.mimeType      = S.mediaRecorder.mimeType || mime || 'audio/webm';
    S.audioChunks   = [];
    S.recSeconds    = 0;
    S.isRecording   = true;

    S.mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) S.audioChunks.push(e.data);
    };

    S.mediaRecorder.start(100);

    $('recordRing').classList.add('recording');
    $('recordBtn').classList.add('recording');
    $('recMicIcon').style.display     = 'none';
    $('recStopIcon').style.display    = '';
    $('recordHint').textContent       = 'Recording — tap to stop';
    $('recordControls').style.display = 'flex';
    $('saveRecordBtn').disabled       = true;

    S.recInterval = setInterval(() => {
      S.recSeconds++;
      $('recordTimer').textContent = fmtT(S.recSeconds);
    }, 1000);

  } catch (err) {
    console.error(err);
    toast('Microphone access denied');
  }
}

function stopRecording() {
  if (!S.mediaRecorder || S.mediaRecorder.state === 'inactive') return;

  clearInterval(S.recInterval);
  S.isRecording = false;

  $('recordRing').classList.remove('recording');
  $('recordBtn').classList.remove('recording');
  $('recordBtn').disabled        = true;
  $('recMicIcon').style.display  = '';
  $('recStopIcon').style.display = 'none';
  $('recordHint').textContent    = 'Finishing…';

  // onstop fires after ALL ondataavailable chunks are flushed — safe to blob here
  S.mediaRecorder.onstop = () => {
    try { S.mediaRecorder.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    $('recordBtn').disabled        = false;
    $('recordHint').textContent    = 'Done — give it a title and save';
    $('saveRecordBtn').disabled    = false;
    $('saveRecordBtn').textContent = 'Save Entry';
    $('entryTitleInput').focus();
    toast('Recording complete');
  };

  S.mediaRecorder.stop();
}

function hardStop() {
  if (!S.mediaRecorder) return;
  clearInterval(S.recInterval);
  S.isRecording = false;
  S.mediaRecorder.ondataavailable = null;
  S.mediaRecorder.onstop = () => {
    try { S.mediaRecorder.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
  };
  if (S.mediaRecorder.state !== 'inactive') S.mediaRecorder.stop();
  S.mediaRecorder = null;
  S.audioChunks   = [];
}

async function saveEntry() {
  const blob = new Blob(S.audioChunks, { type: S.mimeType || 'audio/webm' });

  if (!blob || blob.size < 100) {
    toast('Nothing recorded yet');
    return;
  }

  const btn = $('saveRecordBtn');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  const id      = Date.now().toString();
  const created = Date.now();
  const title   = ($('entryTitleInput').value || '').trim() || 'Untitled entry';

  // Auto-transcribe if Groq key present
  let transcript = '';
  if (LS.groqKey) {
    btn.textContent = 'Transcribing…';
    try {
      transcript = await groqTranscribe(blob, LS.groqKey, S.mimeType);
    } catch (err) {
      console.warn('Auto-transcription failed:', err.message);
    }
  }

  // Store audio (separate store, no 5 MB limit)
  try {
    await idbSetAudio(id, { blob, mimeType: S.mimeType });
  } catch (e) {
    console.warn('Audio store error:', e);
  }

  // Store entry metadata + transcript + title
  const entry = { id, createdAt: created, duration: S.recSeconds, mimeType: S.mimeType, transcript, title };
  await idbSetEntry(entry);

  S.currentId   = id;
  S.audioChunks = [];

  toast('Entry saved');
  await openEntry(id);
}

/* ════════════════════════════════════════
   VIEW EXISTING ENTRY
════════════════════════════════════════ */
async function openEntry(id) {
  S.currentId = id;

  const [entry, audioRec] = await Promise.all([
    idbGet('entries', id),
    idbGet('audio',   id),
  ]);

  if (!entry) { toast('Entry not found'); return; }

  // Nav + title
  $('entryNavTitle').textContent    = entry.title || 'Untitled entry';
  $('playerEntryTitle').textContent = entry.title || 'Untitled entry';
  $('playerDate').textContent       = fmtDate(entry.createdAt);
  $('playerTime').textContent       = fmtShort(entry.createdAt);

  // Audio player
  if (audioRec && audioRec.blob) {
    setupPlayer(audioRec.blob, entry.duration);
    $('playerArea').classList.remove('hidden');
  } else {
    $('playerArea').classList.add('hidden');
  }

  // Transcript
  $('transcriptArea').classList.remove('hidden');
  if (entry.transcript) {
    $('transcriptPlaceholder').classList.add('hidden');
    $('transcriptText').textContent = entry.transcript;
  } else {
    $('transcriptPlaceholder').classList.remove('hidden');
    $('transcriptText').textContent = '';
  }
  $('transcriptStatus').textContent = '';

  // Hide record UI
  $('recordSection').classList.add('hidden');

  showScreen('entryScreen');
}

// ── Delete ──
$('deleteEntryBtn').addEventListener('click', async () => {
  if (!S.currentId) {
    showScreen('homeScreen');
    loadHome();
    return;
  }
  if (!confirm('Delete this entry?')) return;

  const id = S.currentId;
  S.currentId = null;
  stopPlayer();

  await Promise.all([
    idbDelete('entries', id),
    idbDelete('audio',   id),
  ]);

  toast('Entry deleted');
  showScreen('homeScreen');
  loadHome();
});

// ── Share ──
$('shareEntryBtn').addEventListener('click', async () => {
  if (!S.currentId) { toast('No entry to share'); return; }
  const entry = await idbGet('entries', S.currentId);
  if (!entry) return;

  const lines = [];
  if (entry.title) lines.push(entry.title);
  lines.push(fmtDate(entry.createdAt));
  if (entry.transcript) { lines.push(''); lines.push(entry.transcript); }
  else lines.push(`Duration: ${fmtT(entry.duration)}`);

  const text = lines.join('\n');

  if (navigator.share) {
    navigator.share({ title: entry.title || 'Voice Diary Entry', text }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(text)
      .then(()  => toast('Copied to clipboard'))
      .catch(() => toast('Share not supported'));
  }
});

/* ════════════════════════════════════════
   AUDIO PLAYER
   — takes a Blob directly, creates URL internally
   — safe: never crashes if elements missing
════════════════════════════════════════ */
function setupPlayer(blob, totalSecs) {
  stopPlayer();

  const url = URL.createObjectURL(blob);
  const a   = $('audioPlayer');
  a.src     = url;

  $('totalTime').textContent        = fmtT(totalSecs);
  $('currentTime').textContent      = '0:00';
  $('waveformProgress').style.width = '0%';
  setPlayIcon(false);
  buildWaveformBars();

  a.onloadedmetadata = () => {
    if (isFinite(a.duration) && a.duration > 0)
      $('totalTime').textContent = fmtT(a.duration);
  };

  a.ontimeupdate = () => {
    const dur = (isFinite(a.duration) && a.duration > 0) ? a.duration : (totalSecs || 1);
    $('waveformProgress').style.width = (a.currentTime / dur * 100) + '%';
    $('currentTime').textContent = fmtT(a.currentTime);
  };

  a.onended = () => {
    setPlayIcon(false);
    $('waveformProgress').style.width = '0%';
  };

  S.playerActive = true;
}

function buildWaveformBars() {
  const bars = $('waveformBars');
  if (!bars) return;
  bars.innerHTML = '';
  for (let i = 0; i < 36; i++) {
    const b = document.createElement('div');
    b.className    = 'waveform-bar';
    b.style.height = (18 + Math.random() * 64) + '%';
    bars.appendChild(b);
  }
}

$('playPauseBtn').addEventListener('click', () => {
  const a = $('audioPlayer');
  if (!a || !a.src || a.src === window.location.href) return;  // no src loaded
  if (a.paused) {
    a.play().then(() => setPlayIcon(true)).catch(err => console.warn(err));
  } else {
    a.pause();
    setPlayIcon(false);
  }
});

$('waveformTrack').addEventListener('click', e => {
  const a = $('audioPlayer');
  if (!a || !isFinite(a.duration) || a.duration === 0) return;
  const r = $('waveformTrack').getBoundingClientRect();
  a.currentTime = Math.max(0, Math.min(((e.clientX - r.left) / r.width) * a.duration, a.duration));
});

/* ════════════════════════════════════════
   GROQ WHISPER — STT
════════════════════════════════════════ */
async function groqTranscribe(blob, key, mimeType) {
  const ext = mimeToExt(mimeType);
  const fd  = new FormData();
  fd.append('file', blob, `recording.${ext}`);
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('response_format', 'json');
  fd.append('language', 'en');

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);

  try {
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body:    fd,
      signal:  ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`Groq ${r.status}: ${txt}`);
    }
    const d = await r.json();
    return (d.text || '').trim();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Transcription timed out after 45s');
    throw err;
  }
}

// Manual Transcribe button
$('sttBtn').addEventListener('click', async () => {
  if (!LS.groqKey) { toast('Add your Groq API key in Settings'); return; }
  if (!S.currentId) { toast('No entry loaded'); return; }

  const audioRec = await idbGet('audio', S.currentId);
  if (!audioRec || !audioRec.blob) { toast('No audio found for this entry'); return; }

  $('sttBtn').disabled    = true;
  $('sttBtn').textContent = 'Transcribing…';
  $('transcriptStatus').textContent = 'Sending to Groq Whisper…';

  try {
    const text = await groqTranscribe(audioRec.blob, LS.groqKey, audioRec.mimeType);
    if (text) {
      $('transcriptPlaceholder').classList.add('hidden');
      $('transcriptText').textContent = text;
      $('transcriptStatus').textContent = 'Transcription complete';
      await persistTranscript(text);
    } else {
      $('transcriptStatus').textContent = 'No speech detected';
    }
  } catch (err) {
    $('transcriptStatus').textContent = err.message;
  } finally {
    $('sttBtn').disabled    = false;
    $('sttBtn').textContent = 'Transcribe';
  }
});

/* ════════════════════════════════════════
   AI POLISH — Groq LLM
════════════════════════════════════════ */
$('polishBtn').addEventListener('click', async () => {
  const raw = ($('transcriptText').textContent || '').trim();
  if (!raw)        { toast('Transcribe the audio first'); return; }
  if (!LS.groqKey) { toast('Add your Groq API key in Settings'); return; }

  $('polishBtn').disabled    = true;
  $('polishBtn').textContent = 'Polishing…';
  $('transcriptStatus').textContent = 'Polishing with AI…';

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${LS.groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: "You are a personal diary editor. The user spoke a diary entry that was auto-transcribed. Fix punctuation, remove filler words (um, uh, like, you know), correct grammar, and make it flow naturally as a personal diary entry. Preserve the user's voice, tone, emotions and all content exactly. Return ONLY the polished text — no commentary, no preamble.",
          },
          { role: 'user', content: raw },
        ],
        temperature: 0.35,
        max_tokens:  1200,
      }),
    });

    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error?.message || `HTTP ${r.status}`);
    }

    const data     = await r.json();
    const polished = (data.choices?.[0]?.message?.content || '').trim();

    if (polished) {
      $('transcriptText').textContent = polished;
      $('transcriptStatus').textContent = 'Entry polished';
      await persistTranscript(polished);
    } else {
      $('transcriptStatus').textContent = 'Could not polish — try again';
    }
  } catch (err) {
    $('transcriptStatus').textContent = err.message;
  } finally {
    $('polishBtn').disabled    = false;
    $('polishBtn').textContent = 'AI Polish';
  }
});

// Auto-save transcript on manual edit
$('transcriptText').addEventListener('input', () => {
  const text = ($('transcriptText').textContent || '').trim();
  $('transcriptPlaceholder').classList.toggle('hidden', !!text);
  clearTimeout($('transcriptText')._saveTimer);
  $('transcriptText')._saveTimer = setTimeout(() => persistTranscript(text), 1500);
});

async function persistTranscript(text) {
  if (!S.currentId) return;
  try {
    const entry = await idbGet('entries', S.currentId);
    if (!entry) return;
    entry.transcript = text;
    await idbSetEntry(entry);
  } catch (e) {
    console.warn('Transcript save failed', e);
  }
}

/* ════════════════════════════════════════
   INIT
════════════════════════════════════════ */
(async () => {
  await openDB();
  initLock();
})();
