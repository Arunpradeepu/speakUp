'use strict';
/* ═══════════════════════════════════════════
   SESSION — generate, record, pause, finish,
   next topic, end for today
═══════════════════════════════════════════ */
const Session = (() => {
  const S = {
    day: '', order: 0, topic: null,
    stream: null, rec: null, chunks: [], mime: '',
    secs: 0, timer: null,
    busy: false, pending: [], wake: null, vocabBusy: false,
  };
  const MIMES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  const state = () => $('sessionScreen').dataset.state;
  const isLive = () => state() === 'recording' || state() === 'paused';

  /* ── UI state ── */
  function setState(st) {
    $('sessionScreen').dataset.state = st;
    $('finishBtn').disabled = !(st === 'recording' || st === 'paused');
    $('nextBtn').disabled = !(st === 'finished' || st === 'ready') || S.busy;
    $('nextBtn').classList.toggle('glow', st === 'finished' && !S.busy);
    $('pauseBtn').textContent = st === 'paused' ? 'Resume' : 'Pause';
  }
  function setBusy(b) {
    S.busy = b;
    $('generateBtn').disabled = b;
    $('generateBtn').textContent = b ? 'Generating…' : 'Generate topic';
    $('nextBtn').textContent = b ? 'Generating…' : 'Next topic';
    $('endBtn').disabled = b;
    setState(state());
  }

  /* ── open ── */
  async function open() {
    S.day = DB.dayKey();
    S.order = (await DB.topicsForDay(S.day)).length;
    S.topic = null;
    S.secs = 0;
    $('timerText').textContent = '00:00';
    $('topicText').textContent = 'Tap the button below and a fresh topic appears here.';
    $('topicCounter').textContent = `Topic ${S.order + 1} today`;
    $('endBtn').textContent = 'End for today';
    setBusy(false);
    setState('idle');
    showScreen('sessionScreen');
  }

  /* ── mic / wake lock ── */
  async function getMic() {
    if (S.stream && S.stream.getTracks().some(t => t.readyState === 'live')) return;
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  function stopStream() {
    try { S.stream && S.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    S.stream = null;
  }
  async function lockOn() {
    try { if ('wakeLock' in navigator) S.wake = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  function lockOff() {
    try { S.wake && S.wake.release(); } catch (_) {}
    S.wake = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.rec && S.rec.state === 'recording' && !S.wake) lockOn();
  });
  window.addEventListener('beforeunload', e => {
    if (isLive()) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ── vocabulary (background) ── */
  async function ensureVocab() {
    if (S.vocabBusy) return;
    S.vocabBusy = true;
    try {
      if (await DB.get('vocab', S.day)) return;
      const words = await Groq.generateVocab();
      await DB.put('vocab', { day: S.day, words });
    } catch (err) {
      console.warn('Vocabulary failed:', err.message);
    } finally { S.vocabBusy = false; }
  }

  async function dropReady(keepMic) {
    if (state() !== 'ready' || !S.topic) return;
    S.topic.skipped = true;
    await DB.put('topics', S.topic);
    S.topic = null;
    S.order--;
    if (!keepMic) stopStream();
  }

  /* ── start a topic (Generate topic / Next topic) ── */
  async function begin() {
    if (S.busy) return;
    await dropReady();
    setBusy(true);
    try {
      ensureVocab();
      const t = await Groq.generateTopic();
      S.order++;
      S.topic = {
        id: 't' + Date.now(), sessionId: 'day-' + S.day, day: S.day, order: S.order,
        text: t.text, domain: t.domain, createdAt: Date.now(),
        duration: 0, mimeType: '', transcript: '', polished: '', mistakes: [], analyzed: false,
      };
      await DB.put('topics', S.topic);   // saved now, so it can never repeat
      $('topicText').textContent = t.text;
      $('topicCounter').textContent = `Topic ${S.order} today`;
    } catch (err) {
      stopStream();
      toast(err.message);
      return setBusy(false);
    }
    $('timerText').textContent = '00:00';
    $('sessionStatus').textContent = 'Take a moment to think, then start';
    setBusy(false);
    setState('ready');
  }

  /* ── recording ── */
  function tick() {
    S.secs++;
    $('timerText').textContent = fmtT(S.secs);
  }
  async function startRecording() {
    if (state() !== 'ready') return;
    try { await getMic(); } catch (_) { return toast('Microphone access denied'); }
    const pick = MIMES.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    S.rec = new MediaRecorder(S.stream, pick ? { mimeType: pick } : {});
    S.mime = S.rec.mimeType || pick || 'audio/webm';
    S.chunks = [];
    S.secs = 0;
    S.rec.ondataavailable = e => { if (e.data && e.data.size) S.chunks.push(e.data); };
    S.rec.start(250);
    $('timerText').textContent = '00:00';
    clearInterval(S.timer);
    S.timer = setInterval(tick, 1000);
    setState('recording');
    lockOn();
  }
  function togglePause() {
    if (!S.rec) return;
    if (state() === 'recording') {
      S.rec.pause();
      clearInterval(S.timer);
      setState('paused');
    } else if (state() === 'paused') {
      S.rec.resume();
      S.timer = setInterval(tick, 1000);
      setState('recording');
    }
  }

  /* ── finish ── */
  function finish() {
    return new Promise(resolve => {
      if (!S.rec || S.rec.state === 'inactive') return resolve();
      clearInterval(S.timer);
      S.rec.onstop = async () => {
        stopStream();
        lockOff();
        const t = S.topic;
        const blob = new Blob(S.chunks, { type: S.mime });
        S.chunks = [];
        t.duration = S.secs;
        t.mimeType = S.mime;
        if (blob.size < 1000) {
          t.duration = 0;
          await DB.put('topics', t);
          $('sessionStatus').textContent = 'Nothing was recorded';
          setState('finished');
          return resolve();
        }
        try {
          await DB.saveAudio(t.id, blob, S.mime);
          await DB.put('topics', t);
        } catch (_) { toast('Could not save the audio'); }
        $('sessionStatus').textContent = 'Saved · transcribing…';
        setState('finished');
        S.pending.push(process(t, blob));
        resolve();
      };
      S.rec.stop();
    });
  }

  /* ── background: transcript, stats, mistakes ── */
  async function process(t, blob) {
    const say = m => { if (S.topic && S.topic.id === t.id) $('sessionStatus').textContent = m; };
    try {
      const r = await Groq.transcribe(blob, t.mimeType);
      t.transcript = r.text;
      t.stats = Groq.stats(r.text, t.duration, r.segments);
      await DB.put('topics', t);
      if (!r.text) return say('No speech detected');
      say('Transcript ready · checking mistakes…');
      const a = await Groq.analyze(r.text, t.text);
      t.mistakes = a.mistakes;
      t.repeated = a.repeated;
      t.analyzed = true;
      t.error = '';
      await Groq.addMistakeCounts(a.mistakes);
      await DB.put('topics', t);
      say('Transcript ready');
    } catch (err) {
      t.error = err.message;
      await DB.put('topics', t).catch(() => {});
      say(err.message);
      toast(err.message);
    }
  }

  /* ── end for today ── */
  async function end() {
    if (S.busy) return;
    await dropReady();
    if (isLive()) {
      if (!confirm('Save this recording and end for today?')) return;
      await finish();
    }
    const today = await DB.topicsForDay(S.day);
    if (!today.length) { toast('No topics yet'); return goHome(); }

    setBusy(true);
    $('endBtn').textContent = 'Preparing your results…';
    try {
      await Promise.all(S.pending);
      S.pending = [];
      const all = await DB.topicsForDay(S.day);
      const items = all.filter(t => t.transcript).map(t => ({
        text: t.text,
        stats: t.stats || { wpm: 0, fillers: 0, longPauses: 0 },
        mistakes: t.mistakes || [],
      }));
      const prev = await DB.get('sessions', 'day-' + S.day);
      let feedback = null;
      if (items.length) {
        try { feedback = await Groq.dayFeedback(items); }
        catch (err) { toast(err.message); }
      }
      await DB.put('sessions', {
        id: 'day-' + S.day, day: S.day,
        startedAt: prev ? prev.startedAt : all[0].createdAt,
        endedAt: Date.now(),
        topicIds: all.map(t => t.id),
        feedback: feedback || (prev && prev.feedback) || null,
      });
      if (typeof Backup !== 'undefined') { try { await Backup.auto(); } catch (e) { console.warn(e); } }
    } finally {
      setBusy(false);
      $('endBtn').textContent = 'End for today';
    }
    lockOff();
    if (typeof Results !== 'undefined') Results.openDay(S.day);
    else { toast('Saved. Results screen comes in chunk 6'); goHome(); }
  }

  /* ── back ── */
  async function back() {
    if (S.busy) return;
    if (isLive()) {
      if (!confirm('Save this recording and leave?')) return;
      await finish();
    }
    goHome();
  }

  function release() {
    if (!isLive()) { stopStream(); lockOff(); }
  }

  $('generateBtn').addEventListener('click', begin);
  $('startBtn').addEventListener('click', startRecording); 
  $('nextBtn').addEventListener('click', begin);
  $('pauseBtn').addEventListener('click', togglePause);
  $('finishBtn').addEventListener('click', finish);
  $('endBtn').addEventListener('click', end);
  $('sessionBack').addEventListener('click', back);

  return { open, release };
})();


// begin()