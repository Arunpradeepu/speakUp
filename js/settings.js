'use strict';
/* ═══════════════════════════════════════════
   SETTINGS — localStorage (small values only)
   Models are always chosen by you, never hardcoded.
   The defaults below are only a first suggestion.
═══════════════════════════════════════════ */
const Settings = (() => {
  const DEFAULT_STT = 'whisper-large-v3-turbo';
  const DEFAULT_LLM = 'llama-3.3-70b-versatile';

  const read  = (k, d = '') => localStorage.getItem(k) || d;
  const write = (k, v)      => localStorage.setItem(k, v);

  return {
    get pin()        { return read('vd_pin'); },
    set pin(v)       { write('vd_pin', v); },

    get groqKey()    { return read('vd_groq'); },
    set groqKey(v)   { write('vd_groq', v); },

    get sttModel()   { return read('vd_stt_model', DEFAULT_STT); },
    set sttModel(v)  { write('vd_stt_model', v); },

    get llmModel()   { return read('vd_llm_model', DEFAULT_LLM); },
    set llmModel(v)  { write('vd_llm_model', v); },

    /* used by backup (chunk 8). The API key is never exported. */
    exportable() {
      return { pin: this.pin, sttModel: this.sttModel, llmModel: this.llmModel };
    },
    importFrom(o) {
      if (!o) return;
      if (o.pin)      this.pin = o.pin;
      if (o.sttModel) this.sttModel = o.sttModel;
      if (o.llmModel) this.llmModel = o.llmModel;
    },
  };
})();