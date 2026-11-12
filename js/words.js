'use strict';
/* ═══════════════════════════════════════════
   WORDS — daily vocabulary, tap to reveal
═══════════════════════════════════════════ */
const Words = (() => {
  const open = new Set();

  async function load() {
    const list = $('wordsList');
    const days = await DB.allVocabDays();
    const topics = (await DB.allTopics()).filter(t => !t.skipped);
    const today = DB.dayKey();
    list.innerHTML = '';

    if (!days.some(d => d.day === today)) {
      const c = document.createElement('div');
      c.className = 'word-day';
      c.innerHTML = `<div class="day-title">Today</div>
        <div class="muted" style="margin:6px 0 12px;line-height:1.6">Today's words appear when you generate your first topic. You can also get them now.</div>
        <button class="btn-mint small" id="getWordsBtn">Get today's words</button>
        <div class="r-msg" id="wordsMsg"></div>`;
      list.appendChild(c);
      $('getWordsBtn').addEventListener('click', getToday);
    }

    if (!days.length && days.every(d => d.day !== today)) {
      list.insertAdjacentHTML('beforeend', '<div class="empty">No words yet.</div>');
    }

    days.forEach(d => {
      const text = topics.filter(t => t.day === d.day)
        .map(t => (t.transcript || '').toLowerCase()).join(' ');
      const used = d.words.filter(w => new RegExp('\\b' + w + '(s|es|ed|ing|d)?\\b').test(text)).length;
      const shown = open.has(d.day);
      const card = document.createElement('div');
      card.className = 'word-day';
      card.style.cursor = 'pointer';
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="day-title">${esc(fmtDay(d.day))}</div>
            <div class="muted">${text.trim() ? `You used ${used} of ${d.words.length}` : `${d.words.length} words`}</div>
          </div>
          <span class="muted">${shown ? 'Hide' : 'Tap to reveal'}</span>
        </div>
        ${shown ? `<div class="word-chips">${d.words.map(w => {
          const ok = new RegExp('\\b' + w + '(s|es|ed|ing|d)?\\b').test(text);
          return `<span class="word-chip">${esc(w)}${ok ? ' <span class="mint">✓</span>' : ''}</span>`;
        }).join('')}</div>` : ''}`;
      card.addEventListener('click', () => {
        open.has(d.day) ? open.delete(d.day) : open.add(d.day);
        load();
      });
      list.appendChild(card);
    });
  }

  async function getToday() {
    const btn = $('getWordsBtn'), msg = $('wordsMsg');
    btn.disabled = true;
    msg.style.color = 'var(--mint)';
    msg.textContent = 'Getting words…';
    try {
      const words = await Groq.generateVocab();
      await DB.put('vocab', { day: DB.dayKey(), words });
      open.add(DB.dayKey());
      load();
    } catch (err) {
      btn.disabled = false;
      msg.style.color = '';
      msg.textContent = err.message;
    }
  }

  return { load };
})();