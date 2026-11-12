'use strict';
/* ═══════════════════════════════════════════
   BACKUP — daily auto file, full backup, restore
═══════════════════════════════════════════ */
const Backup = (() => {
  const toB64 = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
  const fromB64 = async (b64, mime) =>
    (await fetch(`data:${mime || 'audio/webm'};base64,${b64}`)).blob();

  function download(parts, name) {
    const url = URL.createObjectURL(new Blob(parts, { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* day = 'YYYY-MM-DD' for one day, or null for everything */
  async function make(day) {
    const topics   = (await DB.allTopics()).filter(t => !day || t.day === day);
    const sessions = (await DB.all('sessions')).filter(s => !day || s.day === day);
    const vocab    = await DB.all('vocab');
    const entries  = day ? [] : await DB.all('entries');
    const keys     = day ? topics.map(t => t.id) : await DB.audioKeys();

    const parts = [
      '{"app":"speak-practice","v":1,"made":' + Date.now() +
      ',"day":' + JSON.stringify(day) +
      ',"topics":'   + JSON.stringify(topics) +
      ',"sessions":' + JSON.stringify(sessions) +
      ',"vocab":'    + JSON.stringify(vocab) +
      ',"entries":'  + JSON.stringify(entries) +
      ',"meta":{"mistakeCounts":' + JSON.stringify(await DB.getMeta('mistakeCounts', {})) + '}' +
      ',"settings":' + JSON.stringify({ pin: Settings.pin }) +
      ',"audio":[',
    ];
    let n = 0;
    for (const key of keys) {
      const rec = await DB.getAudio(key);
      if (!rec || !rec.blob) continue;
      parts.push((n++ ? ',' : '') +
        '{"key":' + JSON.stringify(key) +
        ',"mime":' + JSON.stringify(rec.mimeType || rec.blob.type || '') +
        ',"data":"' + await toB64(rec.blob) + '"}');
    }
    parts.push(']}');
    return { parts, n };
  }

  async function run(day, name, kind) {
    const { parts, n } = await make(day);
    download(parts, name);
    await DB.setMeta('lastBackup', { at: Date.now(), name, kind });
    return n;
  }

  /* called by session.js after End for today */
  function auto() {
    const day = DB.dayKey();
    return run(day, `speak-${day}.json`, 'daily');
  }
  function full() {
    return run(null, `speak-full-${DB.dayKey()}.json`, 'full');
  }

  /* ── restore ── */
  async function restoreOne(file) {
    let d;
    try { d = JSON.parse(await file.text()); } catch (_) { throw new Error(`${file.name}: not a valid backup`); }
    if (d.app !== 'speak-practice') throw new Error(`${file.name}: not a Speak backup`);
    const c = { topics: 0, audio: 0 };

    for (const t of d.topics || []) {
      const ex = await DB.get('topics', t.id);
      if (!ex || (!ex.transcript && t.transcript)) { await DB.put('topics', t); c.topics++; }
    }
    for (const s of d.sessions || []) {
      const ex = await DB.get('sessions', s.id);
      if (!ex || (s.endedAt || 0) > (ex.endedAt || 0)) await DB.put('sessions', s);
    }
    for (const v of d.vocab || []) {
      if (!(await DB.get('vocab', v.day))) await DB.put('vocab', v);
    }
    for (const e of d.entries || []) {
      if (!(await DB.get('entries', e.id))) await DB.put('entries', e);
    }
    for (const a of d.audio || []) {
      if (await DB.getAudio(a.key)) continue;
      await DB.saveAudio(a.key, await fromB64(a.data, a.mime), a.mime);
      c.audio++;
    }
    const mc = (d.meta && d.meta.mistakeCounts) || {};
    const cur = await DB.getMeta('mistakeCounts', {});
    Object.keys(mc).forEach(k => {
      if (!cur[k] || mc[k].count > cur[k].count) cur[k] = mc[k];
    });
    await DB.setMeta('mistakeCounts', cur);
    if (!Settings.pin && d.settings && d.settings.pin) Settings.pin = d.settings.pin;
    return c;
  }

  async function status() {
    const m = $('backupMsg');
    const last = await DB.getMeta('lastBackup', null);
    let persisted = false;
    try { persisted = await navigator.storage.persisted(); } catch (_) {}
    setMsg(m, (last ? `Last backup: ${new Date(last.at).toLocaleString('en-IN')}. ` : 'No backup yet. ') +
      (persisted ? 'Storage is protected.' : 'Install the app to protect your data.'));
  }

  $('homeSettingsBtn').addEventListener('click', status);

  $('backupBtn').addEventListener('click', async () => {
    const b = $('backupBtn');
    b.disabled = true;
    setMsg($('backupMsg'), 'Preparing backup…');
    try {
      const n = await full();
      await status();
      toast(`Backup downloaded (${n} recordings)`);
    } catch (err) { setMsg($('backupMsg'), err.message, true); }
    b.disabled = false;
  });

  $('restoreBtn').addEventListener('click', () => $('restoreFile').click());
  $('restoreFile').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const m = $('backupMsg');
    let topics = 0, audio = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        setMsg(m, `Restoring ${i + 1} of ${files.length}…`);
        const c = await restoreOne(files[i]);
        topics += c.topics; audio += c.audio;
      }
      setMsg(m, `Restored ${topics} topics and ${audio} recordings`);
      toast('Restore complete');
    } catch (err) { setMsg(m, err.message, true); }
  });

  /* ── PWA ── */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  return { auto, full };
})();