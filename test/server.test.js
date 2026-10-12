import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { createApp, createSpeechTokenIssuer } from "../server/app.js";
import { createTranslator, parseTranslateRequest, buildUserMessage, ValidationError } from "../server/translate.js";

// Fake Anthropic client: records requests and returns canned responses.
function fakeClient(respond) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (params) => { calls.push(params); return respond(params); } } },
  };
}
const textResponse = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });

let server, base, client;
const errors = [];
const origError = console.error;

before(async () => {
  console.error = (...args) => errors.push(args.join(" "));
  client = fakeClient((params) => {
    const msg = params.messages[0].content;
    if (msg.includes("REFUSE_ME")) return { stop_reason: "refusal", content: [] };
    if (msg.includes("BOOM")) throw new Anthropic.APIConnectionError({ message: "down" });
    return textResponse(msg.includes("Chinese phrase") ? "Where is the train station?" : "火车站在哪里？");
  });
  const app = createApp({
    translate: createTranslator({ client }),
    issueSpeechToken: createSpeechTokenIssuer({
      key: "k",
      region: "eastus",
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://eastus.api.cognitive.microsoft.com/sts/v1.0/issueToken");
        assert.equal(init.headers["Ocp-Apim-Subscription-Key"], "k");
        return new Response("TOKEN123", { status: 200 });
      },
    }),
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  console.error = origError;
  server.close();
});

const post = (body, raw = false) =>
  fetch(`${base}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });

test("English -> Chinese translation", async () => {
  const resp = await post({ text: "Where is the train station?", from: "en" });
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("cache-control"), "no-store");
  assert.deepEqual(await resp.json(), { translation: "火车站在哪里？", to: "zh" });

  const req = client.calls.at(-1);
  assert.equal(req.model, "claude-opus-5-5");
  assert.deepEqual(req.output_config, { effort: "low" });
  assert.equal(req.fallbacks, "default");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(req.thinking, undefined);
  assert.match(req.system, /Simplified Chinese/);
});

test("Chinese -> English translation with Traditional/Cantonese settings and context", async () => {
  const context = Array.from({ length: 9 }, (_, i) => ({ from: "en", text: `turn ${i}`, translation: `第${i}` }));
  const resp = await post({ text: "火車站喺邊度？", from: "zh", script: "traditional", dialect: "cantonese", context });
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { translation: "Where is the train station?", to: "en" });

  const req = client.calls.at(-1);
  assert.match(req.system, /Cantonese/);
  assert.match(req.system, /Traditional Chinese/);
  const msg = req.messages[0].content;
  assert.match(msg, /Translate this Chinese phrase into English/);
  assert.doesNotMatch(msg, /turn 2\b/); // only the last 6 turns are sent
  assert.match(msg, /turn 3/);
  assert.match(msg, /turn 8/);
});

test("validation errors return 400", async () => {
  assert.equal((await post({ text: "", from: "en" })).status, 400);
  assert.equal((await post({ text: "hi", from: "fr" })).status, 400);
  assert.equal((await post({ text: "hi", from: "en", script: "pinyin" })).status, 400);
  assert.equal((await post({ text: "x".repeat(1001), from: "en" })).status, 400);
});

test("refusals and upstream errors map to safe messages", async () => {
  const refused = await post({ text: "REFUSE_ME", from: "en" });
  assert.equal(refused.status, 422);
  const down = await post({ text: "BOOM", from: "en" });
  assert.equal(down.status, 502);
  assert.equal((await down.json()).error, "Could not reach the translation service.");
});

test("server never logs conversation text", async () => {
  errors.length = 0;
  const secret = "my secret sentence 12345";
  const bad = await post(`{"text": "${secret}", oops`, true);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "Request body is not valid JSON.");
  await post({ text: `BOOM ${secret}`, from: "en" });
  assert.ok(errors.length > 0, "5xx errors are logged (without content)");
  for (const line of errors) assert.ok(!line.includes(secret), `log leaked content: ${line}`);
});

test("speech token endpoint returns a short-lived token, never the key", async () => {
  const resp = await fetch(`${base}/api/speech-token`);
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { token: "TOKEN123", region: "eastus" });
});

test("missing Azure config gives a clear error", async () => {
  const issue = createSpeechTokenIssuer({ key: "", region: "" });
  await assert.rejects(issue(), (err) => err.publicMessage.includes("AZURE_SPEECH_KEY"));
});

test("frontend and speech SDK are served", async () => {
  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200);
  const sdk = await fetch(`${base}/vendor/microsoft.cognitiveservices.speech.sdk.bundle-min.js`);
  assert.equal(sdk.status, 200);
});

test("parseTranslateRequest normalises input", () => {
  const r = parseTranslateRequest({ text: "  hi there ", from: "en" });
  assert.deepEqual(r, { text: "hi there", from: "en", to: "zh", script: "simplified", dialect: "mandarin", context: [] });
  assert.throws(() => parseTranslateRequest(null), ValidationError);
  assert.match(buildUserMessage(r), /<phrase>\nhi there\n<\/phrase>/);
});
