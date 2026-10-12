// Hands-free conversation controller.
//
// Privacy: the transcript lives only in the variables of this module. Nothing
// is written to localStorage, sessionStorage, cookies or IndexedDB, and
// stop() wipes it from memory and from the screen.

import {
  candidateLanguages,
  confidenceFromJson,
  otherSide,
  RollingContext,
  shouldIgnore,
  sideForLocale,
  ttsLang,
} from "./logic.js";

const SDK = window.SpeechSDK;
const TOKEN_REFRESH_MS = 9 * 60 * 1000; // Azure tokens last 10 minutes.
const RESUME_AFTER_SPEECH_MS = 350; // let the room echo die down before listening again

const $ = (id) => document.getElementById(id);
const ui = {
  toggle: $("toggle"),
  status: $("status"),
  statusLabel: $("status-label"),
  error: $("error"),
  errorText: $("error-text"),
  settings: $("settings"),
  side: {
    en: { translation: $("en-translation"), original: $("en-original"), live: $("en-live") },
    zh: { translation: $("zh-translation"), original: $("zh-original"), live: $("zh-live") },
  },
};

const INITIAL_TEXT = {
  en: ui.side.en.translation.textContent,
  zh: ui.side.zh.translation.textContent,
};

const STATUS_LABELS = {
  paused: "Paused · 已暂停",
  starting: "Starting… · 启动中",
  listening: "Listening · 正在听",
  translating: "Translating · 翻译中",
  speaking: "Speaking · 播放中",
};

const settings = { dialect: "mandarin", script: "simplified", tts: true };

// ---- session state (memory only) ------------------------------------------
let running = false;
let session = 0; // bumps on every start/stop so stale async work is dropped
let recognizer = null;
let micStream = null;
let tokenTimer = null;
let pendingTranslations = 0;
let speakingQueue = [];
let speaking = false;
let resumeTimer = null;
const context = new RollingContext();
let translationChain = Promise.resolve();

// ---- UI helpers --------------------------------------------------------------
function setStatus(state) {
  ui.status.dataset.state = state;
  ui.statusLabel.textContent = STATUS_LABELS[state];
}

function refreshStatus() {
  if (!running) return setStatus("paused");
  if (speaking) return setStatus("speaking");
  if (pendingTranslations > 0) return setStatus("translating");
  setStatus("listening");
}

function showError(message) {
  ui.errorText.textContent = message;
  ui.error.hidden = false;
}

function clearError() {
  ui.error.hidden = true;
  ui.errorText.textContent = "";
}

function clearScreen() {
  for (const side of ["en", "zh"]) {
    ui.side[side].translation.textContent = INITIAL_TEXT[side];
    ui.side[side].original.textContent = "";
    ui.side[side].live.textContent = "";
  }
}

function setButton() {
  ui.toggle.textContent = running ? "Stop" : "Start conversation";
  ui.toggle.classList.toggle("stop", running);
}

// ---- support checks ------------------------------------------------------------
function unsupportedReason() {
  if (!window.isSecureContext) {
    return "The microphone needs a secure page. Open this app over https:// (or http://localhost). See the README for testing on a phone.";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser can't access the microphone. Use a recent Chrome, Edge or Safari.";
  }
  if (!SDK) {
    return "The speech library didn't load. Run `npm install` on the server and reload the page.";
  }
  return null;
}

// ---- backend calls -------------------------------------------------------------
async function apiError(resp, fallback) {
  try {
    const body = await resp.json();
    if (body?.error) return body.error;
  } catch {
    /* ignore */
  }
  return `${fallback} (${resp.status})`;
}

async function fetchSpeechToken() {
  let resp;
  try {
    resp = await fetch("/api/speech-token", { cache: "no-store" });
  } catch {
    throw new Error("Can't reach the app server. Is it still running?");
  }
  if (!resp.ok) throw new Error(await apiError(resp, "Couldn't get a speech token"));
  return resp.json();
}

async function requestTranslation(text, from) {
  let resp;
  try {
    resp = await fetch("/api/translate", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        from,
        script: settings.script,
        dialect: settings.dialect,
        context: context.snapshot(),
      }),
    });
  } catch {
    throw new Error("Can't reach the app server to translate.");
  }
  if (!resp.ok) throw new Error(await apiError(resp, "Translation failed"));
  return resp.json();
}

// ---- microphone pause/resume ------------------------------------------------------
// Disabling the track makes the recognizer receive silence, so the app never
// hears (and re-translates) its own voice while reading a translation aloud.
function setMicEnabled(enabled) {
  for (const track of micStream?.getAudioTracks() ?? []) track.enabled = enabled;
}

// ---- text-to-speech -------------------------------------------------------------------
function pickVoice(lang) {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const lower = lang.toLowerCase();
  const exact = voices.filter((v) => v.lang.toLowerCase().replace("_", "-") === lower);
  const prefix = voices.filter((v) => v.lang.toLowerCase().startsWith(lower.split("-")[0]));
  const pool = exact.length ? exact : lang.startsWith("zh") ? [] : prefix;
  // Prefer on-device voices so the text isn't sent to another online service.
  return pool.find((v) => v.localService) || pool[0] || null;
}

function speak(text, side) {
  if (!settings.tts || !window.speechSynthesis) return;
  speakingQueue.push({ text, side });
  if (!speaking) speakNext(session);
}

function speakNext(forSession) {
  if (forSession !== session) return;
  const next = speakingQueue.shift();
  if (!next) {
    speaking = false;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      if (forSession === session && !speaking) setMicEnabled(true);
      refreshStatus();
    }, RESUME_AFTER_SPEECH_MS);
    return;
  }

  speaking = true;
  clearTimeout(resumeTimer);
  setMicEnabled(false);
  refreshStatus();

  const lang = ttsLang(next.side, settings.dialect);
  const utterance = new SpeechSynthesisUtterance(next.text);
  utterance.lang = lang;
  const voice = pickVoice(lang);
  if (voice) utterance.voice = voice;

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(safety);
    speakNext(forSession);
  };
  // Some browsers occasionally never fire `end`; don't leave the mic muted.
  const safety = setTimeout(done, 4000 + next.text.length * (next.side === "zh" ? 350 : 120));
  utterance.onend = done;
  utterance.onerror = done;
  window.speechSynthesis.speak(utterance);
}

function stopSpeaking() {
  speakingQueue = [];
  speaking = false;
  clearTimeout(resumeTimer);
  window.speechSynthesis?.cancel();
}

// ---- translation pipeline --------------------------------------------------------
function handlePhrase(text, from) {
  const mySession = session;
  const to = otherSide(from);
  pendingTranslations++;
  refreshStatus();

  // Chain requests so translations appear (and are spoken) in the order spoken,
  // and each one sees the previous turns as context.
  translationChain = translationChain.then(async () => {
    if (mySession !== session) return;
    try {
      const { translation } = await requestTranslation(text, from);
      if (mySession !== session || !translation) return;
      ui.side[to].translation.textContent = translation;
      ui.side[to].original.textContent = text;
      context.add({ from, text, translation });
      speak(translation, to);
    } catch (err) {
      if (mySession === session) showError(err.message);
    } finally {
      if (mySession === session) {
        pendingTranslations = Math.max(0, pendingTranslations - 1);
        refreshStatus();
      }
    }
  });
}

// ---- speech recognition ------------------------------------------------------------
function detectedSide(result) {
  try {
    return sideForLocale(SDK.AutoDetectSourceLanguageResult.fromResult(result).language);
  } catch {
    return null;
  }
}

function buildRecognizer({ token, region }) {
  const speechConfig = SDK.SpeechConfig.fromAuthorizationToken(token, region);
  speechConfig.outputFormat = SDK.OutputFormat.Detailed; // gives us confidence scores
  // How long a pause ends a phrase.
  speechConfig.setProperty(SDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, "700");

  const autoDetect = SDK.AutoDetectSourceLanguageConfig.fromLanguages(candidateLanguages(settings.dialect));
  autoDetect.mode = SDK.LanguageIdMode.Continuous;

  const audioConfig = SDK.AudioConfig.fromStreamInput(micStream);
  const rec = SDK.SpeechRecognizer.FromConfig(speechConfig, autoDetect, audioConfig);
  const mySession = session;

  rec.recognizing = (_s, e) => {
    if (mySession !== session || speaking) return;
    const side = detectedSide(e.result);
    if (!side) return;
    ui.side[side].live.textContent = e.result.text;
    ui.side[otherSide(side)].live.textContent = "";
  };

  rec.recognized = (_s, e) => {
    if (mySession !== session) return;
    if (e.result.reason !== SDK.ResultReason.RecognizedSpeech) return;
    const side = detectedSide(e.result);
    const text = (e.result.text || "").trim();
    if (side) ui.side[side].live.textContent = "";
    if (speaking) return; // mic is muted while speaking; drop any tail
    const confidence = confidenceFromJson(e.result.properties?.getProperty(SDK.PropertyId.SpeechServiceResponse_JsonResult));
    if (shouldIgnore({ text, side, confidence })) return;
    handlePhrase(text, side);
  };

  rec.canceled = (_s, e) => {
    if (mySession !== session) return;
    if (e.reason !== SDK.CancellationReason.Error) return;
    const code = e.errorCode;
    let message = `Speech recognition stopped: ${e.errorDetails || "unknown error"}`;
    if (code === SDK.CancellationErrorCode.AuthenticationFailure || code === SDK.CancellationErrorCode.Forbidden) {
      message = "Azure Speech rejected the credentials. Check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION on the server.";
    } else if (code === SDK.CancellationErrorCode.ConnectionFailure) {
      message = "Lost the connection to Azure Speech. Check your internet connection and press Start again.";
    } else if (code === SDK.CancellationErrorCode.TooManyRequests) {
      message = "Azure Speech is rate-limiting this key (the free tier allows one session at a time). Try again shortly.";
    }
    stop({ keepError: true });
    showError(message);
  };

  return rec;
}

// ---- start / stop -----------------------------------------------------------------------
async function start() {
  clearError();
  const reason = unsupportedReason();
  if (reason) return showError(reason);

  // iOS only allows speech synthesis after a user gesture: prime it now.
  if (settings.tts && window.speechSynthesis) {
    const primer = new SpeechSynthesisUtterance("");
    primer.volume = 0;
    window.speechSynthesis.speak(primer);
  }

  session++;
  const mySession = session;
  running = true;
  setButton();
  setStatus("starting");

  try {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (err) {
      if (err.name === "NotAllowedError" || err.name === "SecurityError") {
        throw new Error("Microphone access is blocked. Allow the microphone for this site in your browser settings, then press Start again.");
      }
      if (err.name === "NotFoundError" || err.name === "OverconstrainedError") {
        throw new Error("No microphone was found on this device.");
      }
      if (err.name === "NotReadableError") {
        throw new Error("The microphone is being used by another app. Close it and try again.");
      }
      throw new Error(`Couldn't open the microphone (${err.name}).`);
    }
    if (mySession !== session) return;

    const credentials = await fetchSpeechToken();
    if (mySession !== session) return;

    recognizer = buildRecognizer(credentials);
    await new Promise((resolve, reject) =>
      recognizer.startContinuousRecognitionAsync(resolve, (e) => reject(new Error(`Couldn't start speech recognition: ${e}`))),
    );
    if (mySession !== session) return;

    tokenTimer = setInterval(async () => {
      try {
        const fresh = await fetchSpeechToken();
        if (mySession === session && recognizer) recognizer.authorizationToken = fresh.token;
      } catch (err) {
        if (mySession === session) showError(err.message);
      }
    }, TOKEN_REFRESH_MS);

    refreshStatus();
  } catch (err) {
    if (mySession !== session) return;
    stop({ keepError: true });
    showError(err.message);
  }
}

function stop({ keepError = false } = {}) {
  session++;
  running = false;
  clearInterval(tokenTimer);
  tokenTimer = null;
  stopSpeaking();

  const rec = recognizer;
  recognizer = null;
  if (rec) {
    rec.stopContinuousRecognitionAsync(
      () => rec.close(),
      () => rec.close(),
    );
  }
  for (const track of micStream?.getTracks() ?? []) track.stop();
  micStream = null;

  // Wipe the conversation from memory and from the screen.
  context.clear();
  pendingTranslations = 0;
  translationChain = Promise.resolve();
  clearScreen();
  if (!keepError) clearError();

  setButton();
  refreshStatus();
}

// ---- settings ---------------------------------------------------------------------------
function readSettings() {
  const form = ui.settings.querySelector("form");
  const data = new FormData(form);
  const previousDialect = settings.dialect;
  settings.dialect = data.get("dialect") === "cantonese" ? "cantonese" : "mandarin";
  settings.script = data.get("script") === "traditional" ? "traditional" : "simplified";
  settings.tts = form.elements.tts.checked;
  if (!settings.tts) {
    stopSpeaking();
    setMicEnabled(true);
    refreshStatus();
  }
  // The candidate languages are fixed when the recognizer is built, so restart it.
  if (running && previousDialect !== settings.dialect) {
    stop();
    start();
  }
}

// ---- wiring ---------------------------------------------------------------------------------
ui.toggle.addEventListener("click", () => (running ? stop() : start()));
$("open-settings").addEventListener("click", () => ui.settings.showModal());
ui.settings.addEventListener("close", readSettings);
$("error-close").addEventListener("click", clearError);
window.addEventListener("pagehide", () => stop());
window.speechSynthesis?.addEventListener?.("voiceschanged", () => {}); // warm up the voice list

const reason = unsupportedReason();
if (reason) showError(reason);
refreshStatus();
