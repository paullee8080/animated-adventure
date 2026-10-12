import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { createApp, createSpeechTokenIssuer } from "./app.js";
import { createTranslator } from "./translate.js";

const port = Number(process.env.PORT) || 3000;

const missing = ["ANTHROPIC_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"].filter((name) => !process.env[name]);
if (missing.length) {
  console.warn(`Warning: missing ${missing.join(", ")} in .env - the app will start but those features will fail.`);
}

const app = createApp({
  translate: createTranslator({
    client: new Anthropic({ maxRetries: 1, timeout: 30_000 }),
    model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
    effort: process.env.CLAUDE_EFFORT || "low",
  }),
  issueSpeechToken: createSpeechTokenIssuer({
    key: process.env.AZURE_SPEECH_KEY,
    region: process.env.AZURE_SPEECH_REGION,
  }),
});

// Optional HTTPS so phones on the local network can use the microphone.
const keyPath = process.env.HTTPS_KEY;
const certPath = process.env.HTTPS_CERT;
const useHttps = Boolean(keyPath && certPath);
const server = useHttps
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
  : http.createServer(app);

server.listen(port, () => {
  const scheme = useHttps ? "https" : "http";
  console.log(`Translator running at ${scheme}://localhost:${port}`);
  if (useHttps) {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === "IPv4" && !a.internal) console.log(`  On your network: ${scheme}://${a.address}:${port}`);
      }
    }
  } else {
    console.log("  (Phones need HTTPS for the microphone - see README, 'Testing on a phone'.)");
  }
});
