// Speech to text on this device, in a background thread: the open-source Whisper speech model (MIT licence) run by
// transformers.js (Apache-2.0). The library and model are downloaded once from public CDNs and kept by the browser;
// the audio never leaves the device. Each message is a 16 kHz mono chunk. The reply is what was said in its own
// language, whether the piece was only music, and (when asked) the model's own English translation.
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";
let asr = null, loading = null, device = "wasm";

async function load(model) {
  const T = await import(LIB);
  T.env.allowLocalModels = false;
  try { if (navigator.gpu && (await navigator.gpu.requestAdapter())) device = "webgpu"; } catch { /* wasm */ }
  const opts = { device, progress_callback: (p) => { if (p.status === "progress" || p.status === "done") postMessage({ type: "progress", file: p.file, loaded: p.loaded, total: p.total, status: p.status }); } };
  opts.dtype = device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8";
  asr = await T.pipeline("automatic-speech-recognition", model, opts);
  return device;
}
// What the model writes for a piece with no speech: a bracketed "music" tag in the station's language, or notes.
const MUSIC = /^[\s[(（*♪♫-]*(music|musique|musik|música|musica|muzyka|muzika|музика|музыка|мелодія|מוזיקה|موسيقى|音楽|音乐|음악|applause|silence|тиша|тишина)?[\s\])）*♪♫.-]*$/i;

onmessage = async (e) => {
  const m = e.data;
  if (m.type === "load") {
    try { await (loading ||= load(m.model)); postMessage({ type: "ready", device }); }
    catch (err) { loading = null; postMessage({ type: "error", error: String(err?.message || err).slice(0, 200) }); }
    return;
  }
  if (m.type === "chunk") {
    if (!asr) return postMessage({ type: "error", id: m.id, error: "speech model not loaded" });
    const t0 = performance.now(), language = m.language || "english", english = language === "english";
    try {
      // First what was said, in its own language (this also tells music from speech); then, only for speech and only
      // when the page can't translate on the device, the model's own translation into English.
      const orig = (await asr(m.audio, { task: "transcribe", language, chunk_length_s: 30, return_timestamps: false })).text.trim();
      if (MUSIC.test(orig)) return postMessage({ type: "text", id: m.id, t: m.t, music: true, text: "", orig, ms: Math.round(performance.now() - t0) });
      let text = english ? orig : null;
      if (!english && m.translate) text = (await asr(m.audio, { task: "translate", language, chunk_length_s: 30, return_timestamps: false })).text.trim();
      postMessage({ type: "text", id: m.id, t: m.t, text, orig: english ? null : orig, ms: Math.round(performance.now() - t0) });
    } catch (err) { postMessage({ type: "error", id: m.id, error: String(err?.message || err).slice(0, 200) }); }
  }
};
