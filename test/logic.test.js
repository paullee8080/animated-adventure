import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateLanguages,
  confidenceFromJson,
  otherSide,
  RollingContext,
  shouldIgnore,
  sideForLocale,
  ttsLang,
} from "../public/js/logic.js";

test("candidate languages follow the Chinese dialect setting", () => {
  assert.deepEqual(candidateLanguages("mandarin"), ["en-US", "zh-CN"]);
  assert.deepEqual(candidateLanguages("cantonese"), ["en-US", "zh-HK"]);
});

test("detected locales map to the right speaker", () => {
  assert.equal(sideForLocale("en-US"), "en");
  assert.equal(sideForLocale("zh-CN"), "zh");
  assert.equal(sideForLocale("zh-HK"), "zh");
  assert.equal(sideForLocale("Unknown"), null);
  assert.equal(sideForLocale(undefined), null);
  assert.equal(otherSide("en"), "zh");
  assert.equal(otherSide("zh"), "en");
});

test("confidence is read from Azure's detailed JSON", () => {
  assert.equal(confidenceFromJson(JSON.stringify({ NBest: [{ Confidence: 0.83 }] })), 0.83);
  assert.equal(confidenceFromJson('{"DisplayText":"hi"}'), null);
  assert.equal(confidenceFromJson("not json"), null);
  assert.equal(confidenceFromJson(undefined), null);
});

test("noise, fillers and low-confidence phrases are ignored", () => {
  assert.equal(shouldIgnore({ text: "", side: "en" }), true);
  assert.equal(shouldIgnore({ text: "Um.", side: "en" }), true);
  assert.equal(shouldIgnore({ text: "嗯。", side: "zh" }), true);
  assert.equal(shouldIgnore({ text: "A.", side: "en" }), true);
  assert.equal(shouldIgnore({ text: "Where is the station?", side: "en", confidence: 0.2 }), true);
  assert.equal(shouldIgnore({ text: "Hello", side: null }), true);

  assert.equal(shouldIgnore({ text: "Where is the station?", side: "en", confidence: 0.9 }), false);
  assert.equal(shouldIgnore({ text: "好。", side: "zh" }), false); // a real one-word answer
  assert.equal(shouldIgnore({ text: "No.", side: "en" }), false);
});

test("rolling context keeps only the last 6 turns", () => {
  const ctx = new RollingContext();
  for (let i = 0; i < 9; i++) ctx.add({ from: "en", text: `t${i}`, translation: `x${i}` });
  const snap = ctx.snapshot();
  assert.equal(snap.length, 6);
  assert.equal(snap[0].text, "t3");
  ctx.clear();
  assert.equal(ctx.snapshot().length, 0);
});

test("TTS language matches the reader", () => {
  assert.equal(ttsLang("en", "mandarin"), "en-US");
  assert.equal(ttsLang("zh", "mandarin"), "zh-CN");
  assert.equal(ttsLang("zh", "cantonese"), "zh-HK");
});
