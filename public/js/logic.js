// Pure helpers shared by the browser app and the Node tests (no DOM, no SDK).

export const CONTEXT_TURNS = 6;
export const MIN_CONFIDENCE = 0.4;

/** Candidate languages for Azure's continuous language identification. */
export function candidateLanguages(dialect) {
  return ["en-US", dialect === "cantonese" ? "zh-HK" : "zh-CN"];
}

/** Map an Azure locale ("en-US", "zh-CN", "zh-HK", ...) to "en" | "zh" | null. */
export function sideForLocale(locale) {
  if (typeof locale !== "string") return null;
  const lower = locale.toLowerCase();
  if (lower.startsWith("en")) return "en";
  if (lower.startsWith("zh") || lower.startsWith("yue")) return "zh";
  return null;
}

/** The other person's language. */
export function otherSide(side) {
  return side === "en" ? "zh" : "en";
}

/**
 * Read the top hypothesis confidence from Azure's detailed JSON result.
 * Returns null when the service did not report one.
 */
export function confidenceFromJson(json) {
  if (!json) return null;
  try {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    const best = parsed?.NBest?.[0];
    return typeof best?.Confidence === "number" ? best.Confidence : null;
  } catch {
    return null;
  }
}

const FILLERS = new Set([
  "uh", "um", "umm", "uhm", "hmm", "hm", "mm", "mhm", "ah", "eh", "er", "oh", "huh",
  "嗯", "啊", "呃", "哦", "噢", "唔", "哎", "诶", "欸", "嗯嗯", "啊啊", "呃呃", "哈",
]);

/** Strip whitespace and punctuation (ASCII + CJK). */
function core(text) {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * Decide whether a finished phrase is noise that should not be translated:
 * empty, a lone filler sound, a stray English letter, or low confidence.
 */
export function shouldIgnore({ text, side, confidence }) {
  if (!side) return true;
  if (typeof text !== "string") return true;
  const c = core(text);
  if (!c) return true;
  if (FILLERS.has(c)) return true;
  if (side === "en" && c.length < 2 && c !== "i") return true;
  if (typeof confidence === "number" && confidence < MIN_CONFIDENCE) return true;
  return false;
}

/** In-memory rolling window of the last few turns, sent as translation context. */
export class RollingContext {
  constructor(max = CONTEXT_TURNS) {
    this.max = max;
    this.turns = [];
  }
  add(turn) {
    this.turns.push(turn);
    if (this.turns.length > this.max) this.turns.splice(0, this.turns.length - this.max);
  }
  snapshot() {
    return this.turns.map((t) => ({ ...t }));
  }
  clear() {
    this.turns.length = 0;
  }
}

/** BCP-47 tag for reading a translation aloud. */
export function ttsLang(side, dialect) {
  if (side === "en") return "en-US";
  return dialect === "cantonese" ? "zh-HK" : "zh-CN";
}
