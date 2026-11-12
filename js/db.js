'use strict';
/* ═══════════════════════════════════════════
   DB — IndexedDB (same name as the old app)
   entries  (old diary, untouched)
   audio    key = topic id  → { blob, mimeType }
   topics   { id, sessionId, day, order, text, createdAt,
              duration, mimeType, transcript, polished, mistakes[] }
   sessions { id, day, startedAt, endedAt, topicIds[], feedback }
   vocab    { day, words[] }
   meta     key → value  (e.g. 'mistakeCounts')
═══════════════════════════════════════════ */
const DB = (() => {
  const NAME = 'VoiceDiaryDB', VER = 3;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VER);
      r.onupgradeneeded = e => {
        const db = e.target.result;
        const has = n => db.objectStoreNames.contains(n);
        if (!has('entries')) db.createObjectStore('entries', { keyPath: 'id' });
        if (!has('audio'))   db.createObjectStore('audio');
        if (!has('topics'))  db.createObjectStore('topics',   { keyPath: 'id' });
        if (!has('sessions'))db.createObjectStore('sessions', { keyPath: 'id' });
        if (!has('vocab'))   db.createObjectStore('vocab',    { keyPath: 'day' });
        if (!has('meta'))    db.createObjectStore('meta');
      };
      r.onsuccess = e => {
        _db = e.target.result;
        _db.onversionchange = () => { _db.close(); _db = null; };
        res(_db);
      };
      r.onerror = e => rej(e.target.error);
    });
  }

  function run(store, mode, fn) {
    return open().then(db => new Promise((res, rej) => {
      const tx = db.transaction(store, mode);
      let out;
      const req = fn(tx.objectStore(store));
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => res(out);
      tx.onerror = tx.onabort = () => rej(tx.error);
    }));
  }

  const put    = (store, val, key) => run(store, 'readwrite', s => key === undefined ? s.put(val) : s.put(val, key));
  const get    = (store, key)      => run(store, 'readonly',  s => s.get(key));
  const remove = (store, key)      => run(store, 'readwrite', s => s.delete(key));
  const all    = (store)           => run(store, 'readonly',  s => s.getAll());
  const audioKeys = () => run('audio', 'readonly', s => s.getAllKeys());

  function clearAll() {
    const stores = ['entries', 'audio', 'topics', 'sessions', 'vocab', 'meta'];
    return open().then(db => new Promise((res, rej) => {
      const tx = db.transaction(stores, 'readwrite');
      stores.forEach(n => tx.objectStore(n).clear());
      tx.oncomplete = res;
      tx.onerror = tx.onabort = () => rej(tx.error);
    }));
  }

  /* local date as YYYY-MM-DD */
  function dayKey(ts = Date.now()) {
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${dd}`;
  }

  /* ── topics ── */
  async function allTopics() {
    return (await all('topics')).sort((a, b) => a.createdAt - b.createdAt);
  }
  async function topicsForDay(day) {
    return (await allTopics()).filter(t => t.day === day && !t.skipped);
  }
  async function usedTopicTexts() {
    return (await allTopics()).map(t => t.text);
  }

  /* ── sessions ── */
  async function allSessions() {
    return (await all('sessions')).sort((a, b) => b.startedAt - a.startedAt);
  }
  async function sessionForDay(day) {
    return (await all('sessions')).find(s => s.day === day) || null;
  }

  /* ── audio ── */
  const saveAudio = (id, blob, mimeType) => put('audio', { blob, mimeType }, id);
  const getAudio  = id => get('audio', id);

  /* ── vocab ── */
  async function allVocabWords() {
    return (await all('vocab')).flatMap(v => v.words);
  }
  async function allVocabDays() {
    return (await all('vocab')).sort((a, b) => b.day.localeCompare(a.day));
  }

  /* ── meta ── */
  async function getMeta(key, fallback) {
    const v = await get('meta', key);
    return v === undefined ? fallback : v;
  }
  const setMeta = (key, val) => put('meta', val, key);

  return {
    open, put, get, remove, all, audioKeys, clearAll, dayKey,
    allTopics, topicsForDay, usedTopicTexts,
    allSessions, sessionForDay,
    saveAudio, getAudio,
    allVocabWords, allVocabDays,
    getMeta, setMeta,
  };
})();

//topicsForDay const all