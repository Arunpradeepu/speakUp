'use strict';
/* ═══════════════════════════════════════════
   GROQ — transcribe, topics, vocab, analysis
   Models always come from Settings.
═══════════════════════════════════════════ */
const Groq = (() => {
  const BASE = 'https://api.groq.com/openai/v1';

  /* ── low level ── */
  function needKey() {
    if (!Settings.groqKey) throw new Error('Add your Groq API key in Settings');
  }
  function mimeToExt(m) {
    if (!m) return 'webm';
    if (m.includes('mp4')) return 'm4a';
    if (m.includes('ogg')) return 'ogg';
    return 'webm';
  }
  async function post(path, init, ms = 60000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(BASE + path, { ...init, signal: ctrl.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Request timed out');
      throw new Error('Network error. Check your internet');
    } finally {
      clearTimeout(timer);
    }
  }
  async function failMsg(r, model) {
    const txt = await r.text().catch(() => '');
    if (r.status === 401) return 'Groq key was rejected. Check it in Settings';
    if (r.status === 429) return 'Groq rate limit reached. Wait a minute and try again';
    if (/model/i.test(txt) && (r.status === 400 || r.status === 404))
      return `Model "${model}" is not available. Pick another in Settings`;
    return `Groq ${r.status}: ${txt.slice(0, 160)}`;
  }
    function parseJSON(txt) {
    const clean = String(txt || '').replace(/```json|```/g, '')
      .replace(/\s*\n\s*/g, ' ').trim();   // line breaks inside strings break JSON
    try { return JSON.parse(clean); } catch (_) {}
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    throw new Error('The AI reply was not readable. Try again');
  }

  /* ── chat ── */
  async function chat(messages, { json = false, temperature = 0.7, max = 1500 } = {}) {
    needKey();
    const model = Settings.llmModel;
    const body = { model, messages, temperature, max_tokens: max };
    const noJson = new Set(JSON.parse(localStorage.getItem('vd_nojson') || '[]'));
    if (json && !noJson.has(model)) body.response_format = { type: 'json_object' };
    const send = () => post('/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${Settings.groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let r = await send();
    if (!r.ok && json && r.status === 400 && body.response_format) {   // some models lack JSON mode
      delete body.response_format;
      r = await send();
      if (r.ok) {
        noJson.add(model);
        localStorage.setItem('vd_nojson', JSON.stringify([...noJson]));
      }
    }
    if (!r.ok) throw new Error(await failMsg(r, model));
    const d = await r.json();
    let out = (d.choices?.[0]?.message?.content || '').trim();
    out = out.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!json) return out;
    try { return parseJSON(out); } catch (_) { return { _raw: out }; }
  }

  /* ── transcription ── */
  async function transcribe(blob, mimeType) {
    needKey();
    const model = Settings.sttModel;
    const build = fmt => {
      const fd = new FormData();
      fd.append('file', blob, `recording.${mimeToExt(mimeType)}`);
      fd.append('model', model);
      fd.append('response_format', fmt);
      fd.append('language', 'en');
      fd.append('temperature', '0');
      // this prompt nudges Whisper to keep fillers instead of deleting them
      fd.append('prompt', 'Umm, so, uh, like, you know, actually, I mean, well, uh... okay.');
      return { method: 'POST', headers: { Authorization: `Bearer ${Settings.groqKey}` }, body: fd };
    };
    let r = await post('/audio/transcriptions', build('verbose_json'), 90000);
    if (!r.ok && r.status === 400) r = await post('/audio/transcriptions', build('json'), 90000);
    if (!r.ok) throw new Error(await failMsg(r, model));
    const d = await r.json();
    return { text: (d.text || '').trim(), segments: d.segments || [] };
  }

  /* ── topics ── */
  const STOP = new Set('the a an of to in on for and or is are was were be do does why how what when who people their they it that this with as at by from your you i we can should would could more most than then about into out over'.split(' '));
  const words = s => new Set(String(s).toLowerCase().replace(/[^a-z\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
  function tooSimilar(a, list) {
    const A = words(a);
    if (!A.size) return false;
    return list.some(t => {
      const B = words(t);
      let hit = 0;
      A.forEach(w => B.has(w) && hit++);
      return hit / (A.size + B.size - hit || 1) > 0.5;
    });
  }

  const DOMAINS = ['everyday life', 'psychology', 'technology', 'business', 'society',
    'human behaviour', 'decision-making', 'creativity', 'health and habits', 'money',
    'culture', 'science', 'relationships', 'a real-world situation'];

  async function generateTopic() {
    const topics = await DB.allTopics();
    const used = topics.map(t => t.text);
    const recentDomains = topics.slice(-8).map(t => t.domain).filter(Boolean);
    const noBusiness = topics.slice(-5).some(t => t.domain === 'business');
    const history = used.slice(-200).map(t => '- ' + t.slice(0, 110)).join('\n') || '(none yet)';
    let hint = '';

    for (let i = 0; i < 3; i++) {
      const res = await chat([
        {
          role: 'system',
          content:
            'You create speaking-practice topics for an English learner who talks for 3-4 minutes per topic. ' +
            'Rules: the topic must have enough depth for 3-4 minutes and encourage opinions and independent thinking. ' +
            'Never repeat or closely relate to any previous topic or concept. ' +
            'Pick a domain from: ' + DOMAINS.join(', ') + '. Use a different domain from the recent ones. ' +
            (noBusiness ? 'Do NOT use business this time. ' : 'Business is allowed only occasionally. ') +
            'No college-related topics and no questions about the speaker\'s future or career. ' +
                        'Write the topic as a question or a situation the speaker must react to, never as a bare title. ' +
            'Example style: "Would you rather have a job you love with low pay or a boring job with high pay? Why?" ' +
            'Use simple, clear wording, one or two sentences, under 30 words. '  +
            'Reply with JSON only: {"topic":"...","domain":"..."}',
        },
        {
          role: 'user',
          content: `Recent domains: ${recentDomains.join(', ') || 'none'}\n\nPrevious topics:\n${history}\n${hint}\nGive one new topic.`,
        },
      ], { json: true, temperature: 1, max: 200 });

    const rawMatch = (res._raw || '').match(/"topic"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/);
    const rawTopic = rawMatch ? rawMatch[1] : (res._raw || '');
    const text = String(res.topic || rawTopic.replace(/\s+/g, ' ')
        .replace(/^["'\s]*(topic\s*:)?\s*/i, '').replace(/["'\s{}]+$/, '')).trim();

      if (text && !tooSimilar(text, used)) return { text, domain: String(res.domain || '').toLowerCase() };
      hint = `\nYour last attempt ("${text}") was too close to an old topic. Choose a completely different idea.`;
    }
    throw new Error('Could not find a fresh topic. Try again');
  }

  /* ── vocabulary ── */
  async function generateVocab() {
    const used = await DB.allVocabWords();
    const usedSet = new Set(used.map(w => w.toLowerCase()));
    let got = [];
    for (let i = 0; i < 3 && got.length < 5; i++) {
      const res = await chat([
        {
          role: 'system',
          content:
            'Give 5 English words slightly above everyday vocabulary, useful in spoken conversation. ' +
            'Single words only, no phrases. Never use a word from the used list. ' +
            'Reply with JSON only: {"words":["...","...","...","...","..."]}',
        },
        { role: 'user', content: 'Used words: ' + (used.join(', ') || 'none') },
      ], { json: true, temperature: 0.9, max: 120 });
      (res.words || (res._raw || '').split(/[\s,;\n]+/)).forEach(w => {
        w = String(w).toLowerCase().trim();
        if (/^[a-z-]+$/.test(w) && !usedSet.has(w) && !got.includes(w)) got.push(w);
      });
    }
    if (got.length < 5) throw new Error('Could not get 5 new words. Try again');
    return got.slice(0, 5);
  }

  /* ── fillers & stats (local, no AI) ── */
  function findFillers(text) {
    const out = [];
    const rules = [
      /\b(?:u+m+|u+h+|e+r+m*|h+m+)\b/gi,
      /\byou know\b/gi,
      /\bi mean\b/gi,
      /\b(?:actually|basically)\b/gi,
      /(?:^|[.!?,]\s*)(so)\b/gi,             // "so" at the start of a sentence or clause
      /,\s*(like)\s*,|(?:^|[.!?]\s*)(like),/gi // "like" used as a filler
    ];
    rules.forEach(re => {
      let m;
      while ((m = re.exec(text))) {
        const g = m[1] || m[2] || m[0];
        const start = m.index + m[0].toLowerCase().indexOf(g.toLowerCase());
        out.push([start, start + g.length]);
        if (m[0].length === 0) re.lastIndex++;
      }
    });
    out.sort((a, b) => a[0] - b[0]);
    return out.filter((r, i) => !i || r[0] >= out[i - 1][1]);
  }

  function stats(text, duration, segments) {
    const n = (text.match(/\b[\w']+\b/g) || []).length;
    const mins = Math.max(duration / 60, 0.1);
    let longPauses = 0;
    (segments || []).forEach((s, i, a) => {
      if (i && s.start - a[i - 1].end > 1.5) longPauses++;
    });
    return {
      words: n,
      wpm: Math.round(n / mins),
      fillers: findFillers(text).length,
      longPauses,
    };
  }

  /* ── mistake tracking ── */
  async function addMistakeCounts(mistakes) {
    const c = await DB.getMeta('mistakeCounts', {});
    mistakes.forEach(m => {
      const k = m.type || 'grammar';
      c[k] = c[k] || { count: 0, example: '' };
      c[k].count++;
      c[k].example = `${m.phrase} → ${m.correction}`;
    });
    await DB.setMeta('mistakeCounts', c);
  }
  async function topRecurring(n = 5) {
    const c = await DB.getMeta('mistakeCounts', {});
    return Object.entries(c).sort((a, b) => b[1].count - a[1].count).slice(0, n)
      .map(([type, v]) => ({ type, count: v.count, example: v.example }));
  }

  /* ── analysis (red mistakes) ── */
  const TYPES = 'grammar, tense, subject-verb agreement, article, preposition, sentence construction, word choice, connector, repetition, incomplete sentence';

  async function analyze(transcript, topic) {
    const recurring = await topRecurring(5);
    const focus = recurring.length
      ? 'This speaker often makes these mistakes, so check them carefully: ' +
        recurring.map(r => `${r.type} (e.g. ${r.example})`).join('; ') + '. '
      : '';
    const res = await chat([
      {
        role: 'system',
        content:
          'You are an honest English speaking coach. The text is an auto-transcript of someone speaking, so ignore capital letters and punctuation. ' +
          'Find real grammar and sentence-construction mistakes, wrong word choices, weak connectors, and incomplete sentences. ' +
          'Do not flag fillers. Do not rewrite the speaker\'s style or upgrade simple words into fancy ones. ' +
          focus +
          'For each mistake give: "phrase" = the exact shortest span copied from the transcript (2 to 6 words), ' +
          '"correction" = the fixed version of that span, "reason" = a plain explanation under 20 words, ' +
          '"type" = one of: ' + TYPES + '. ' +
          'Also list up to 3 "repeated_words" the speaker overuses. ' +
          'Reply with JSON only: {"mistakes":[{"phrase":"","correction":"","reason":"","type":""}],"repeated_words":[]}',
      },
      { role: 'user', content: `Topic: ${topic}\n\nTranscript:\n${transcript}` },
    ], { json: true, temperature: 0.2, max: 1800 });

    if (res._raw !== undefined) throw new Error('The AI reply was not readable. Try another text model in Settings');

    const low = transcript.toLowerCase();
    const seen = new Set();
    const mistakes = (res.mistakes || []).filter(m => {
      const p = String(m.phrase || '').trim().toLowerCase();
      if (!p || !m.correction || seen.has(p) || !low.includes(p)) return false;
      seen.add(p);
      return true;
    }).map(m => ({
      phrase: String(m.phrase).trim(),
      correction: String(m.correction).trim(),
      reason: String(m.reason || '').trim(),
      type: String(m.type || 'grammar').toLowerCase(),
    }));
    return { mistakes, repeated: (res.repeated_words || []).slice(0, 3) };
  }

  /* ── polish ── */
  function polish(transcript) {
    return chat([
      {
        role: 'system',
        content:
          'You edit a spoken transcript. Fix grammar and punctuation, remove filler words (um, uh, like, you know, so, actually) and false starts. ' +
          'Keep the speaker\'s own ideas, order, tone and simple wording. Do not add new content and do not make the vocabulary fancier. ' +
          'Return ONLY the edited text.',
      },
      { role: 'user', content: transcript },
    ], { temperature: 0.3, max: 1800 });
  }

  /* ── whole-day feedback ── */
    async function dayFeedback(items) {
    const recurring = await topRecurring(6);
    const brief = items.map((t, i) =>
      `Topic ${i + 1}: ${t.text}\n` +
      `Stats: ${t.stats.wpm} wpm, ${t.stats.fillers} fillers, ${t.stats.longPauses} long pauses\n` +
      'Mistakes: ' + (t.mistakes.length
        ? t.mistakes.map(m => `[${m.type}] "${m.phrase}" → "${m.correction}"`).join('; ')
        : 'none found')).join('\n\n');
    const fb = await chat([
      {
        role: 'system',
        content:
          'You are an honest, constructive English speaking coach. No unnecessary praise. ' +
          'Look at the day\'s results and the speaker\'s all-time recurring mistakes. Explain WHY the mistakes happen so they stop repeating. ' +
          'Use simple language. Reply with JSON only: ' +
          '{"summary":"3-4 sentences, honest overall assessment",' +
          '"improve":[{"area":"","why":"","fix":""}],' +
          '"exercise":"one concrete 5-minute exercise for tomorrow"} ' +
          'Give at most 3 items in "improve", ordered by importance.',
      },
      {
        role: 'user',
        content: `Today:\n${brief}\n\nAll-time recurring mistakes:\n` +
          (recurring.map(r => `${r.type}: ${r.count} times (e.g. ${r.example})`).join('\n') || 'none yet'),
      },
    ], { json: true, temperature: 0.4, max: 1200 });
    if (fb._raw !== undefined) throw new Error('The AI reply was not readable. Try another text model in Settings');
    return fb;
  }

  return {
    chat, transcribe, generateTopic, generateVocab,
    findFillers, stats, analyze, polish, dayFeedback,
    addMistakeCounts, topRecurring,
  };
})();


// if (!r.ok && j