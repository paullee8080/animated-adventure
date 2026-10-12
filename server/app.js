// Express app: serves the frontend, issues short-lived Azure Speech tokens and
// proxies translation requests to Claude.
//
// Privacy rules enforced here:
// - No request-logging middleware (no morgan etc.) is installed.
// - The error handler never prints request bodies or error messages that could
//   contain user text (e.g. JSON parse errors quote the offending input).
// - API responses are sent with `Cache-Control: no-store`.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { parseTranslateRequest, ValidationError, RefusalError } from "./translate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const speechSdkDir = path.join(
  here,
  "..",
  "node_modules",
  "microsoft-cognitiveservices-speech-sdk",
  "distrib",
  "browser",
);

/** Tiny fixed-window rate limiter kept in memory (IP -> counter). Nothing is persisted. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const key = req.ip;
    const count = (hits.get(key) || 0) + 1;
    hits.set(key, count);
    if (count > max) return res.status(429).json({ error: "Too many requests - slow down a little." });
    next();
  };
}

/**
 * @param {object} deps
 * @param {(req: object) => Promise<{translation: string, to: string}>} deps.translate
 * @param {() => Promise<{token: string, region: string}>} deps.issueSpeechToken
 */
export function createApp({ translate, issueSpeechToken }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");

  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "microphone=(self)",
    });
    next();
  });

  app.use("/vendor", express.static(speechSdkDir, { index: false }));
  app.use(express.static(publicDir));

  const api = express.Router();
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  api.use(express.json({ limit: "32kb" }));
  api.use(rateLimit({ windowMs: 60_000, max: 120 }));

  api.get("/health", (req, res) => res.json({ ok: true }));

  api.get("/speech-token", async (req, res, next) => {
    try {
      res.json(await issueSpeechToken());
    } catch (err) {
      next(err);
    }
  });

  api.post("/translate", async (req, res, next) => {
    try {
      const request = parseTranslateRequest(req.body);
      res.json(await translate(request));
    } catch (err) {
      next(err);
    }
  });

  app.use("/api", api);

  // Error handler: respond with a safe message and log only the error class /
  // status - never the request body or an error message that may quote it.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = 500;
    let error = "Something went wrong on the server.";

    if (err instanceof ValidationError) {
      status = 400;
      error = err.message;
    } else if (err.type === "entity.parse.failed") {
      status = 400;
      error = "Request body is not valid JSON.";
    } else if (err.type === "entity.too.large") {
      status = 413;
      error = "Request body is too large.";
    } else if (err instanceof RefusalError) {
      status = 422;
      error = err.message;
    } else if (err instanceof Anthropic.AuthenticationError) {
      status = 502;
      error = "Translation service rejected the API key. Check ANTHROPIC_API_KEY on the server.";
    } else if (err instanceof Anthropic.RateLimitError) {
      status = 503;
      error = "Translation service is rate-limited. Try again in a moment.";
    } else if (err instanceof Anthropic.APIConnectionError) {
      status = 502;
      error = "Could not reach the translation service.";
    } else if (err instanceof Anthropic.APIError) {
      status = 502;
      error = `Translation service error (${err.status ?? "unknown"}).`;
    } else if (err.expose && typeof err.publicMessage === "string") {
      status = err.status || 500;
      error = err.publicMessage;
    }

    if (status >= 500) {
      console.error(`[${req.method} ${req.path}] ${status} ${err.name}${err.status ? ` (${err.status})` : ""}`);
    }
    res.status(status).json({ error });
  });

  return app;
}

/** Exchange the Azure Speech key for a 10-minute authorization token. */
export function createSpeechTokenIssuer({ key, region, fetchImpl = fetch }) {
  return async function issueSpeechToken() {
    if (!key || !region) {
      const err = new Error("Azure Speech not configured");
      err.expose = true;
      err.status = 500;
      err.publicMessage = "Azure Speech is not configured. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in .env.";
      throw err;
    }
    const resp = await fetchImpl(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": key, "Content-Length": "0" },
    });
    if (!resp.ok) {
      const err = new Error(`Azure token request failed: ${resp.status}`);
      err.expose = true;
      err.status = 502;
      err.publicMessage =
        resp.status === 401 || resp.status === 403
          ? "Azure rejected the Speech key. Check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION."
          : `Could not get a speech token from Azure (${resp.status}).`;
      throw err;
    }
    return { token: await resp.text(), region };
  };
}
