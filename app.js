/* ══════════════════════════════════════════
   VOICE DIARY — app.js
   IndexedDB · PIN · Groq STT · AI Polish
══════════════════════════════════════════ */
'use strict';

// ─── INDEXEDDB ────────────────────────────
// DB_VER 2: added 'audio' object store (out-of-line keys)
// 'entries' store uses keyPath:'id' (inline) — never pass a separate key
// 'audio'   store has no keyPath       (out-of-line) — always pass a key
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
        db.createObjectStore('audio');   // out-of-line keys
    };
    r.onsuccess = e => { _db = e.target.result; res(_db); };
    r.onerror   = e => rej(e.target.error);
  });
}

// entries store: inline key — val must contain val.id, do NOT pass key arg
// audio   store: out-of-line key — pass key separately
async function idbSetEntry(val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('entries', 'readwrite');
    tx.objectStore('entries').put(val);   // key comes from val.id
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}
async function idbSetAudio(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('audio', 'readwrite');
    tx.objectStore('audio').put(val, key);  // explicit key
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}
async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r  = tx.objectStore(store).get(key);
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}
async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}
async function idbAllEntries() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('entries', 'readonly');
    const r  = tx.objectStore('entries').getAll();
    r.onsuccess = e => res(e.target.result.sort((a,b) => b.createdAt - a.createdAt));
    r.onerror   = e => rej(e.target.error);
  });
}
async function idbClearAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(['entries','audio'], 'readwrite');
    tx.objectStore('entries').clear();
    tx.objectStore('audio').clear();
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}

// ─── SETTINGS (localStorage) ─────────────
const LS = {
  get pin()      { return localStorage.getItem('vd_pin') || ''; },
  set pin(v)     { localStorage.setItem('vd_pin', v); },
  get groqKey()  { return localStorage.getItem('vd_groq') || ''; },
  set groqKey(v) { localStorage.setItem('vd_groq', v); },
};

// ─── APP STATE ────────────────────────────
const S = {
  pinBuffer:     '',
  isSetup:       false,
  currentId:     null,

  mediaRecorder: null,
  audioChunks:   [],
  mimeType:      '',
  recSeconds:    0,
  recInterval:   null,
  isRecording:   false,
};

// ─── HELPERS ─────────────────────────────
const $     = id => document.getElementById(id);
const fmtT  = s  => {
  s = Math.max(0, Math.round(s));
  return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
};
const fmtDate = ts =>
  new Date(ts).toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
const fmtShort = ts =>
  new Date(ts).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
const esc = s =>
  String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function getSupportedMime() {
  const list = ['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg'];
  return list.find(t => MediaRecorder.isTypeSupported(t)) || '';
}
function mimeToExt(m) {
  if (!m) return 'webm';
  if (m.includes('mp4')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  return 'webm';
}

// ─── SCREENS ─────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ─── TOAST ───────────────────────────────
let _tt;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => t.classList.remove('show'), 2600);
}

// ══════════════════════════════════════════
//  PIN
// ══════════════════════════════════════════
function initLock() {
  S.isSetup   = !LS.pin;
  S.pinBuffer = '';
  $('pinLabel').textContent = S.isSetup ? 'Create a 4-digit PIN' : 'Enter PIN';
  $('pinHint').textContent  = S.isSetup ? "You'll use this to unlock your diary" : '';
  renderDots();
}

function renderDots() {
  document.querySelectorAll('.pin-dot').forEach((d, i) => {
    d.classList.remove('error');
    d.classList.toggle('filled', i < S.pinBuffer.length);
  });
}

function pinInput(val) {
  if (val === 'del') { S.pinBuffer = S.pinBuffer.slice(0,-1); renderDots(); return; }
  if (val === 'ok')  { if (S.pinBuffer.length === 4) submitPin(); return; }
  if (S.pinBuffer.length >= 4) return;
  S.pinBuffer += val;
  renderDots();
  if (S.pinBuffer.length === 4) submitPin();
}

function submitPin() {
  if (S.isSetup) {
    LS.pin = S.pinBuffer;
    toast('PIN set! 🔐');
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

// ══════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════
$('homeSettingsBtn').addEventListener('click', openSettings);
$('homeLockBtn').addEventListener('click', () => { stopPlayer(); initLock(); showScreen('lockScreen'); });
$('settingsBack').addEventListener('click', () => { showScreen('homeScreen'); loadHome(); });

function openSettings() {
  $('groqKeyInput').value      = LS.groqKey ? '••••••••' : '';
  $('groqSaveMsg').textContent = '';
  $('newPinInput').value       = '';
  $('pinSaveMsg').textContent  = '';
  showScreen('settingsScreen');
}

$('savePinBtn').addEventListener('click', () => {
  const v = $('newPinInput').value.trim();
  const m = $('pinSaveMsg');
  if (!/^\d{4}$/.test(v)) { m.style.color='#e53935'; m.textContent='⚠ Must be exactly 4 digits'; return; }
  LS.pin = v;
  m.style.color = ''; m.textContent = '✓ PIN updated';
  $('newPinInput').value = '';
});

$('saveGroqBtn').addEventListener('click', () => {
  const v = $('groqKeyInput').value.trim();
  const m = $('groqSaveMsg');
  if (!v || v === '••••••••') { m.style.color='#e53935'; m.textContent='⚠ Enter a valid key'; return; }
  if (!v.startsWith('gsk_'))  { m.style.color='#e53935'; m.textContent='⚠ Key should start with gsk_...'; return; }
  LS.groqKey = v;
  m.style.color = ''; m.textContent = '✓ API key saved';
  $('groqKeyInput').value = '••••••••';
});

$('deleteAllBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL diary entries? This cannot be undone.')) return;
  await idbClearAll();
  toast('All entries deleted');
  showScreen('homeScreen');
  loadHome();
});

// ══════════════════════════════════════════
//  HOME
// ══════════════════════════════════════════
async function loadHome() {
  const entries = await idbAllEntries();
  const list    = $('entriesList');
  list.innerHTML = '';

  if (!entries.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎙️</div>
        <p class="empty-title">No entries yet</p>
        <p class="empty-sub">Tap the mic button below to record your first diary entry</p>
      </div>`;
    return;
  }

  entries.forEach(entry => {
    const card    = document.createElement('div');
    card.className = 'entry-card';
    const preview = entry.transcript
      ? esc(entry.transcript.slice(0,65)) + (entry.transcript.length > 65 ? '…' : '')
      : 'Voice entry';
    card.innerHTML = `
      <div class="entry-thumb">🎙️</div>
      <div class="entry-info">
        <div class="entry-title">${preview}</div>
        <div class="entry-meta">
          <span>${fmtDate(entry.createdAt)}</span>
          <span class="entry-duration">${fmtT(entry.duration || 0)}</span>
        </div>
      </div>`;
    card.addEventListener('click', () => openEntry(entry.id));
    list.appendChild(card);
  });
}

$('newEntryBtn').addEventListener('click', openNewEntry);

// ══════════════════════════════════════════
//  NEW ENTRY — RECORD
// ══════════════════════════════════════════
function openNewEntry() {
  S.currentId   = null;
  S.audioChunks = [];
  S.mimeType    = '';

  $('entryDateTitle').textContent = 'New Entry';
  $('playerArea').classList.add('hidden');
  $('transcriptArea').classList.add('hidden');
  $('recordSection').classList.remove('hidden');
  resetRecordUI();
  showScreen('entryScreen');
}

function resetRecordUI() {
  $('recordTimer').textContent      = '00:00';
  $('recordHint').textContent       = 'Tap to start recording';
  $('recordRing').classList.remove('recording');
  $('recordBtn').classList.remove('recording');
  $('recordBtn').disabled           = false;
  $('recordIcon').textContent       = '🎙️';
  $('recordControls').style.display = 'none';
  $('saveRecordBtn').disabled       = true;
  $('saveRecordBtn').textContent    = '✓ Save';
}

$('entryBack').addEventListener('click', () => {
  hardStop();
  stopPlayer();
  showScreen('homeScreen');
  loadHome();
});

// ── Record / Stop button ──
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

// ── Start recording ──
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

    S.mediaRecorder.start(100);   // flush chunks every 100 ms

    $('recordRing').classList.add('recording');
    $('recordBtn').classList.add('recording');
    $('recordIcon').textContent       = '⏹';
    $('recordHint').textContent       = 'Recording… tap to stop';
    $('recordControls').style.display = 'flex';
    $('saveRecordBtn').disabled       = true;

    S.recInterval = setInterval(() => {
      S.recSeconds++;
      $('recordTimer').textContent = fmtT(S.recSeconds);
    }, 1000);

  } catch (err) {
    console.error(err);
    toast('🎤 Microphone access denied');
  }
}

// ── Stop recording — wait for onstop to flush all chunks ──
function stopRecording() {
  if (!S.mediaRecorder || S.mediaRecorder.state === 'inactive') return;

  clearInterval(S.recInterval);
  S.isRecording = false;

  $('recordRing').classList.remove('recording');
  $('recordBtn').classList.remove('recording');
  $('recordBtn').disabled     = true;   // prevent double-tap
  $('recordIcon').textContent = '🎙️';
  $('recordHint').textContent = 'Stopping…';

  // onstop fires after all ondataavailable events are done
  S.mediaRecorder.onstop = () => {
    S.mediaRecorder.stream.getTracks().forEach(t => t.stop());
    $('recordBtn').disabled           = false;
    $('recordHint').textContent       = 'Done! Tap "Save Entry"';
    $('saveRecordBtn').disabled       = false;
    $('saveRecordBtn').textContent    = '✓ Save Entry';
    toast('Done recording! Tap Save.');
  };

  S.mediaRecorder.stop();
}

// ── Hard stop (cancel / navigate away) ──
function hardStop() {
  if (!S.mediaRecorder) return;
  clearInterval(S.recInterval);
  S.isRecording = false;
  S.mediaRecorder.ondataavailable = null;
  S.mediaRecorder.onstop = () => {
    try { S.mediaRecorder.stream.getTracks().forEach(t => t.stop()); } catch(e) {}
  };
  if (S.mediaRecorder.state !== 'inactive') S.mediaRecorder.stop();
  S.mediaRecorder = null;
  S.audioChunks   = [];
}

// ── Save entry ──
async function saveEntry() {
  const blob = new Blob(S.audioChunks, { type: S.mimeType || 'audio/webm' });

  if (!blob || blob.size < 100) {
    toast('⚠ Nothing recorded yet');
    return;
  }

  const btn = $('saveRecordBtn');
  btn.disabled    = true;
  btn.textContent = '⏳ Saving…';

  const id      = Date.now().toString();
  const created = Date.now();

  // Auto-transcribe if Groq key is set
  let transcript = '';
  if (LS.groqKey) {
    btn.textContent = '⏳ Transcribing…';
    try {
      transcript = await groqTranscribe(blob, LS.groqKey, S.mimeType);
    } catch (err) {
      console.warn('Auto-transcription failed:', err.message);
    }
  }

  // Store audio blob in its own store (no size limits)
  try {
    await idbSetAudio(id, { blob, mimeType: S.mimeType });
  } catch (e) {
    console.warn('Audio store error:', e);
  }

  // Store entry
  const entry = { id, createdAt: created, duration: S.recSeconds, mimeType: S.mimeType, transcript };
  await idbSetEntry(entry);

  S.currentId   = id;
  S.audioChunks = [];

  toast('Entry saved! ✓');
  await openEntry(id);   // switch to playback view
}

// ══════════════════════════════════════════
//  VIEW EXISTING ENTRY
// ══════════════════════════════════════════
async function openEntry(id) {
  S.currentId = id;

  const [entry, audioRec] = await Promise.all([
    idbGet('entries', id),
    idbGet('audio',   id),
  ]);

  if (!entry) { toast('Entry not found'); return; }

  $('entryDateTitle').textContent = fmtDate(entry.createdAt);
  $('playerDate').textContent     = fmtDate(entry.createdAt);
  $('playerTime').textContent     = fmtShort(entry.createdAt);

  if (audioRec && audioRec.blob) {
    const url = URL.createObjectURL(audioRec.blob);
    setupPlayer(url, entry.duration || 0);
    $('playerArea').classList.remove('hidden');
  } else {
    $('playerArea').classList.add('hidden');
  }

  $('transcriptArea').classList.remove('hidden');
  if (entry.transcript) {
    $('transcriptPlaceholder').classList.add('hidden');
    $('transcriptText').textContent = entry.transcript;
  } else {
    $('transcriptPlaceholder').classList.remove('hidden');
    $('transcriptText').textContent = '';
  }
  $('transcriptStatus').textContent = '';
  $('recordSection').classList.add('hidden');

  showScreen('entryScreen');
}

// ── Delete ──
$('deleteEntryBtn').addEventListener('click', async () => {
  if (!S.currentId) { showScreen('homeScreen'); loadHome(); return; }
  if (!confirm('Delete this entry?')) return;
  await Promise.all([
    idbDelete('entries', S.currentId),
    idbDelete('audio',   S.currentId),
  ]);
  stopPlayer();
  toast('Entry deleted');
  showScreen('homeScreen');
  loadHome();
});

// ── Share ──
$('shareEntryBtn').addEventListener('click', async () => {
  if (!S.currentId) { toast('Save the entry first'); return; }
  const entry = await idbGet('entries', S.currentId);
  if (!entry) return;
  const text = entry.transcript
    ? `🎙️ Voice Diary — ${fmtDate(entry.createdAt)}\n\n${entry.transcript}`
    : `🎙️ Voice Diary — ${fmtDate(entry.createdAt)}\nDuration: ${fmtT(entry.duration || 0)}`;
  if (navigator.share) {
    navigator.share({ title: 'Voice Diary Entry', text }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(text)
      .then(() => toast('Copied to clipboard ✓'))
      .catch(() => toast('Share not supported'));
  }
});

// ══════════════════════════════════════════
//  AUDIO PLAYER
// ══════════════════════════════════════════
function setupPlayer(url, totalSecs) {
  stopPlayer();
  const a = $('audioPlayer');
  a.src   = url;

  $('totalTime').textContent         = fmtT(totalSecs || 0);
  $('currentTime').textContent       = '00:00';
  $('waveformProgress').style.width  = '0%';
  $('playPauseBtn').textContent      = '▶';

  buildWaveformBars();

  a.onloadedmetadata = () => {
    if (a.duration && isFinite(a.duration))
      $('totalTime').textContent = fmtT(a.duration);
  };
  a.ontimeupdate = () => {
    const dur = a.duration || totalSecs || 1;
    $('waveformProgress').style.width = (a.currentTime / dur * 100) + '%';
    $('currentTime').textContent = fmtT(a.currentTime);
  };
  a.onended = () => {
    $('playPauseBtn').textContent = '▶';
    $('waveformProgress').style.width = '0%';
  };
}

function buildWaveformBars() {
  const bars = $('waveformBars');
  bars.innerHTML = '';
  for (let i = 0; i < 36; i++) {
    const b = document.createElement('div');
    b.className    = 'waveform-bar';
    b.style.height = (20 + Math.random() * 60) + '%';
    bars.appendChild(b);
  }
}

$('playPauseBtn').addEventListener('click', () => {
  const a = $('audioPlayer');
  if (!a.src) return;
  if (a.paused) { a.play(); $('playPauseBtn').textContent = '⏸'; }
  else          { a.pause(); $('playPauseBtn').textContent = '▶'; }
});

$('waveformTrack').addEventListener('click', e => {
  const a = $('audioPlayer');
  if (!a.duration) return;
  const r = $('waveformTrack').getBoundingClientRect();
  a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
});

function stopPlayer() {
  const a = $('audioPlayer');
  a.pause();
  a.src = '';
  $('playPauseBtn').textContent     = '▶';
  $('waveformProgress').style.width = '0%';
}

// ══════════════════════════════════════════
//  GROQ WHISPER
// ══════════════════════════════════════════
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
    if (!r.ok) { const e = await r.text(); throw new Error(`Groq ${r.status}: ${e}`); }
    const d = await r.json();
    return (d.text || '').trim();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Transcription timed out');
    throw err;
  }
}

// ── Manual Transcribe button ──
$('sttBtn').addEventListener('click', async () => {
  if (!LS.groqKey) { toast('Add Groq API key in ⚙ Settings'); return; }
  if (!S.currentId) { toast('No entry loaded'); return; }

  const audioRec = await idbGet('audio', S.currentId);
  if (!audioRec || !audioRec.blob) { toast('No audio found for this entry'); return; }

  $('sttBtn').disabled    = true;
  $('sttBtn').textContent = '⏳ Transcribing…';
  $('transcriptStatus').textContent = 'Sending to Groq Whisper…';

  try {
    const text = await groqTranscribe(audioRec.blob, LS.groqKey, audioRec.mimeType);
    if (text) {
      $('transcriptPlaceholder').classList.add('hidden');
      $('transcriptText').textContent = text;
      $('transcriptStatus').textContent = '✓ Transcription complete';
      await persistTranscript(text);
    } else {
      $('transcriptStatus').textContent = 'No speech detected';
    }
  } catch (err) {
    $('transcriptStatus').textContent = `⚠ ${err.message}`;
  } finally {
    $('sttBtn').disabled    = false;
    $('sttBtn').textContent = '🎙 Transcribe';
  }
});

// ══════════════════════════════════════════
//  AI POLISH — GROQ LLM
// ══════════════════════════════════════════
$('polishBtn').addEventListener('click', async () => {
  const raw = $('transcriptText').textContent.trim();
  if (!raw)         { toast('Transcribe the audio first'); return; }
  if (!LS.groqKey)  { toast('Add Groq API key in ⚙ Settings'); return; }

  $('polishBtn').disabled    = true;
  $('polishBtn').textContent = '⏳ Polishing…';
  $('transcriptStatus').textContent = 'AI is polishing your entry…';

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${LS.groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',
        messages: [
          {
            role: 'system',
            content: "You are a personal diary editor. The user spoke a diary entry that was auto-transcribed. Fix punctuation, remove filler words (um, uh, like, you know), fix grammar, and make it flow naturally as a personal diary entry. Preserve the user's voice, tone, emotions and all content exactly. Return ONLY the polished text — no commentary, no preamble.",
          },
          { role: 'user', content: raw },
        ],
        temperature: 0.35,
      }),
    });

    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error?.message || `HTTP ${r.status}`);
    }

    const data     = await r.json();
    const polished = data.choices?.[0]?.message?.content?.trim() || '';

    if (polished) {
      $('transcriptText').textContent = polished;
      $('transcriptStatus').textContent = '✨ Entry polished';
      await persistTranscript(polished);
    } else {
      $('transcriptStatus').textContent = 'Could not polish';
    }
  } catch (err) {
    $('transcriptStatus').textContent = `⚠ ${err.message}`;
  } finally {
    $('polishBtn').disabled    = false;
    $('polishBtn').textContent = '✨ AI Polish';
  }
});

// ── Auto-save transcript on manual edit ──
$('transcriptText').addEventListener('input', () => {
  const text = $('transcriptText').textContent.trim();
  $('transcriptPlaceholder').classList.toggle('hidden', !!text);
  clearTimeout($('transcriptText')._t);
  $('transcriptText')._t = setTimeout(() => persistTranscript(text), 1500);
});

async function persistTranscript(text) {
  if (!S.currentId) return;
  try {
    const entry = await idbGet('entries', S.currentId);
    if (!entry) return;
    entry.transcript = text;
    await idbSetEntry(entry);
  } catch (e) { console.warn('Transcript save failed', e); }
}

// ══════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════
(async () => {
  await openDB();
  initLock();
})();