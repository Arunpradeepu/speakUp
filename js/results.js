'use strict';
/* ═══════════════════════════════════════════
   RESULTS — tabs, transcript with red mistakes,
   audio playback, polish, day feedback
═══════════════════════════════════════════ */
const Results = (() => {
  const R = { day: '', topics: [], session: null, tab: 0, fix: -1, url: null, tok: 0 };
  const cur = () => R.topics[R.tab];
  const mins = s => Math.max(1, Math.round(s / 60));

  /* ── open / load ── */
  async function openDay(day) {
    R.day = day; R.tab = 0; R.fix = -1;
    await load();
    showScreen('resultsScreen');
    render();
  }
  async function load() {
    R.topics = await DB.topicsForDay(R.day);
    R.session = await DB.get('sessions', 'day-' + R.day);
  }
  function render() {
    const secs = R.topics.reduce((a, t) => a + (t.duration || 0), 0);
    $('resultsMeta').textContent =
      `${R.topics.length} topic${R.topics.length === 1 ? '' : 's'} · ${mins(secs)} min`;
    const d = fmtDay(R.day);
    $('resultsTitle').textContent = d === 'Today' ? "Today's practice" : d;
    renderTabs();
    renderBody();
  }
  function renderTabs() {
    $('tabsRow').innerHTML =
      R.topics.map((t, i) =>
        `<button class="tab${R.tab === i ? ' active' : ''}" data-tab="${i}">Topic ${i + 1}</button>`).join('') +
      `<button class="tab fb${R.tab === 'fb' ? ' active' : ''}" data-tab="fb">Day feedback</button>`;
  }
  $('tabsRow').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (!b) return;
    R.tab = b.dataset.tab === 'fb' ? 'fb' : +b.dataset.tab;
    R.fix = -1;
    renderTabs();
    renderBody();
  });
  $('resultsBack').addEventListener('click', () => { stopAudio(); goHome(); });

  /* ── transcript with highlights ── */
  function markedHTML(t) {
    const text = t.transcript || '';
    const low = text.toLowerCase();
    const found = [];
    (t.mistakes || []).forEach((m, i) => {
      const p = m.phrase.toLowerCase();
      let from = 0, k;
      while (p && (k = low.indexOf(p, from)) !== -1) {
        found.push({ a: k, b: k + p.length, kind: 'err', i });
        from = k + p.length;
      }
    });
    found.sort((x, y) => x.a - y.a);
    const list = [];
    found.forEach(r => {
      const last = list[list.length - 1];
      if (!last || r.a >= last.b) list.push(r);
    });
    Groq.findFillers(text).forEach(([a, b]) => {
      if (!list.some(r => a < r.b && b > r.a)) list.push({ a, b, kind: 'fill' });
    });
    list.sort((x, y) => x.a - y.a);
    let html = '', pos = 0;
    list.forEach(r => {
      html += esc(text.slice(pos, r.a));
      const s = esc(text.slice(r.a, r.b));
      html += r.kind === 'err'
        ? `<span class="mk-err" data-i="${r.i}">${s}</span>`
        : `<span class="mk-fill">${s}</span>`;
      pos = r.b;
    });
    return html + esc(text.slice(pos));
  }

  /* ── topic tab ── */
  function topicHTML(t) {
    let h = `<div class="res-card"><p class="res-topic">${esc(t.text)}</p>`;

    if (t.duration > 0) {
      h += `<div class="player" id="rPlayer">
        <button class="play-btn" id="rPlay" aria-label="Play">
          <svg id="rPlayIc" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>
          <svg id="rPauseIc" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
        <div class="p-track" id="rTrack"><div class="p-fill" id="rFill"></div></div>
        <span class="muted" id="rTime">${fmtT(t.duration)}</span>
      </div>`;
    }

    if (!t.transcript) {
      h += `<div class="muted" style="margin-top:18px;line-height:1.6">${
        t.duration > 0 ? esc(t.error || 'No transcript yet.') : 'Nothing was recorded for this topic.'}</div>`;
      if (t.duration > 0)
        h += `<div class="r-actions"><button class="btn-mint small" data-act="process">Transcribe</button></div>`;
    } else {
      const s = t.stats;
      if (s) h += `<div class="chips"><span class="chip">${s.wpm} words/min</span>
        <span class="chip">${s.fillers} fillers</span><span class="chip">${s.longPauses} long pauses</span></div>`;

      h += `<div class="muted label" style="margin:16px 0 8px">MY TRANSCRIPT</div>
        <div class="transcript">${markedHTML(t)}</div>
        <div id="rFix"></div>
        <div class="legend muted"><span><span class="mk-err">&nbsp;&nbsp;</span> mistake</span>
        <span><span class="mk-fill">&nbsp;&nbsp;</span> filler</span></div>`;

      if (t.analyzed && !(t.mistakes || []).length)
        h += `<div class="muted" style="margin-top:12px">No clear mistakes found in this one.</div>`;
      if ((t.repeated || []).length)
        h += `<div class="muted" style="margin-top:12px">Repeated words: ${t.repeated.map(esc).join(', ')}</div>`;

      h += `<div class="r-actions">
        ${t.analyzed ? '' : '<button class="btn-mint small" data-act="analyze">Check mistakes</button>'}
        <button class="btn-outline small" data-act="polish">${t.polished ? 'Polish again' : 'AI Polish'}</button></div>`;

      if (t.polished)
        h += `<div class="polish-box"><div class="muted label" style="margin-bottom:8px">POLISHED VERSION</div>${esc(t.polished)}</div>`;
    }
    return h + `<div class="r-msg" id="rMsg"></div></div>`;
  }

  function renderFix(t) {
    const box = $('rFix');
    if (!box) return;
    const m = (t.mistakes || [])[R.fix];
    box.innerHTML = m
      ? `<div class="fix-box"><s>${esc(m.phrase)}</s> → <b>${esc(m.correction)}</b>
         <div class="muted" style="margin-top:4px;line-height:1.5">${esc(m.reason)}</div></div>`
      : '';
  }

  /* ── audio ── */
  async function setupAudio(t, tok) {
    const a = $('audioPlayer');
    if (R.url) { URL.revokeObjectURL(R.url); R.url = null; }
    const rec = await DB.getAudio(t.id);
    if (tok !== R.tok || !$('rPlayer')) return;
    if (!rec || !rec.blob) { $('rPlayer').classList.add('hidden'); return; }
    R.url = URL.createObjectURL(rec.blob);
    a.src = R.url;
    const dur = () => (isFinite(a.duration) && a.duration > 0) ? a.duration : (t.duration || 1);
    const icons = playing => {
      const p = $('rPlayIc'), q = $('rPauseIc');
      if (p && q) { p.style.display = playing ? 'none' : ''; q.style.display = playing ? '' : 'none'; }
    };
    a.onplay = () => icons(true);
    a.onpause = () => icons(false);
    a.onended = () => { icons(false); if ($('rFill')) $('rFill').style.width = '0%'; };
    a.ontimeupdate = () => {
      if (!$('rFill')) return;
      $('rFill').style.width = Math.min(100, a.currentTime / dur() * 100) + '%';
      $('rTime').textContent = fmtT(a.currentTime) + ' / ' + fmtT(dur());
    };
    $('rPlay').onclick = () => {
      if (a.paused) a.play().catch(err => toast('Cannot play: ' + err.message));
      else a.pause();
    };
    $('rTrack').onclick = e => {
      const r = $('rTrack').getBoundingClientRect();
      a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur();
    };
  }

  /* ── day feedback tab ── */
  async function fbHTML() {
    const done = R.topics.filter(t => t.transcript);
    const secs = R.topics.reduce((a, t) => a + (t.duration || 0), 0);
    const sum = k => done.reduce((a, t) => a + ((t.stats && t.stats[k]) || 0), 0);
    const wpm = done.length ? Math.round(sum('wpm') / done.length) : 0;
    let h = `<div class="fb-card"><h3>The day in numbers</h3>
      <div class="chips" style="margin:0"><span class="chip">${R.topics.length} topics</span>
      <span class="chip">${mins(secs)} min</span><span class="chip">${wpm} words/min</span>
      <span class="chip">${sum('fillers')} fillers</span><span class="chip">${sum('longPauses')} long pauses</span></div></div>`;

    const fb = R.session && R.session.feedback;
    if (fb && fb.summary) {
      h += `<div class="fb-card"><h3>Overall</h3>${esc(fb.summary)}</div>`;
      if (Array.isArray(fb.improve) && fb.improve.length)
        h += `<div class="fb-card"><h3>Work on these</h3><ul>${fb.improve.map(i =>
          `<li><b>${esc(i.area || '')}</b>: ${esc(i.why || '')}<div class="muted">Fix: ${esc(i.fix || '')}</div></li>`).join('')}</ul></div>`;
      if (fb.exercise)
        h += `<div class="fb-card"><h3>Tomorrow's exercise</h3>${esc(fb.exercise)}</div>`;
    } else {
      h += `<div class="fb-card"><h3>Day feedback</h3>${done.length
        ? 'Not generated yet.<div class="r-actions"><button class="btn-mint small" data-act="fb">Generate feedback</button></div>'
        : 'Record and transcribe at least one topic first.'}<div class="r-msg" id="rMsg"></div></div>`;
    }

    const rec = await Groq.topRecurring(5);
    if (rec.length)
      h += `<div class="fb-card"><h3>Your repeated mistakes (all time)</h3><ul>${rec.map(r =>
        `<li><b>${esc(r.type)}</b> · ${r.count} times<div class="muted">e.g. ${esc(r.example)}</div></li>`).join('')}</ul></div>`;
    return h;
  }

  /* ── render body ── */
  async function renderBody() {
    const tok = ++R.tok;
    stopAudio();
    const a = $('audioPlayer');
    a.onplay = a.onpause = a.onended = a.ontimeupdate = null;
    const body = $('resultsBody');
    if (!R.topics.length) { body.innerHTML = '<div class="empty">No topics for this day.</div>'; return; }
    if (R.tab === 'fb') {
      const h = await fbHTML();
      if (tok === R.tok) body.innerHTML = h;
      return;
    }
    const t = cur() || R.topics[0];
    body.innerHTML = topicHTML(t);
    renderFix(t);
    if (t.duration > 0) setupAudio(t, tok);
  }

  /* ── actions ── */
  async function transcribeFull(t) {
    const rec = await DB.getAudio(t.id);
    if (!rec || !rec.blob) throw new Error('Audio not found for this topic');
    const r = await Groq.transcribe(rec.blob, rec.mimeType || t.mimeType);
    t.transcript = r.text;
    t.stats = Groq.stats(r.text, t.duration, r.segments);
    await DB.put('topics', t);
    if (!r.text) throw new Error('No speech detected');
  }
  async function analyzeFull(t) {
    const a = await Groq.analyze(t.transcript, t.text);
    t.mistakes = a.mistakes;
    t.repeated = a.repeated;
    t.analyzed = true;
    t.error = '';
    await Groq.addMistakeCounts(a.mistakes);
    await DB.put('topics', t);
  }
  async function makeFeedback() {
    const items = R.topics.filter(t => t.transcript).map(t => ({
      text: t.text,
      stats: t.stats || { wpm: 0, fillers: 0, longPauses: 0 },
      mistakes: t.mistakes || [],
    }));
    const feedback = await Groq.dayFeedback(items);
    const s = R.session || {
      id: 'day-' + R.day, day: R.day,
      startedAt: R.topics[0].createdAt, endedAt: Date.now(),
      topicIds: R.topics.map(t => t.id),
    };
    s.feedback = feedback;
    await DB.put('sessions', s);
    R.session = s;
  }

  $('resultsBody').addEventListener('click', async e => {
    const mk = e.target.closest('.mk-err');
    if (mk) {
      const i = +mk.dataset.i;
      R.fix = R.fix === i ? -1 : i;
      renderFix(cur());
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, t = cur();
    b.disabled = true;
    const msg = $('rMsg');
    if (msg) { msg.style.color = 'var(--mint)'; msg.textContent = 'Working…'; }
    let err = '';
    try {
      if (act === 'process') { await transcribeFull(t); await analyzeFull(t); }
      else if (act === 'analyze') await analyzeFull(t);
      else if (act === 'polish') { t.polished = await Groq.polish(t.transcript); await DB.put('topics', t); }
      else if (act === 'fb') await makeFeedback();
    } catch (ex) { err = ex.message; }
    await renderBody();
    if (err && $('rMsg')) { $('rMsg').style.color = ''; $('rMsg').textContent = err; }
  });

  return { openDay };
})();