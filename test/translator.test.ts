import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator, resolveProvider } from "../src/translator.ts";

test("MT_PROVIDER は deepl か anthropic、未指定なら deepl", () => {
  assert.equal(resolveProvider(undefined), "deepl");
  assert.equal(resolveProvider(""), "deepl");
  assert.equal(resolveProvider("DeepL"), "deepl");
  assert.equal(resolveProvider(" anthropic "), "anthropic");
  assert.throws(() => resolveProvider("google"), /MT_PROVIDER/);
});

test("使うエンジンの API キーがなければ翻訳を止める（null）", () => {
  assert.equal(createTranslator({}), null);
  assert.equal(createTranslator({ DEEPL_API_KEY: " " }), null);
  // もう一方のキーだけあっても使わない
  assert.equal(createTranslator({ MT_PROVIDER: "anthropic", DEEPL_API_KEY: "key:fx" }), null);
  assert.equal(createTranslator({ ANTHROPIC_API_KEY: "sk-ant-test" }), null);
});

test("キーがあれば選んだエンジンで翻訳する。Claude の既定のモデルは claude-haiku-5-5", () => {
  assert.equal(createTranslator({ DEEPL_API_KEY: "key:fx" })?.name, "DeepL");
  assert.equal(
    createTranslator({ MT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test" })?.name,
    "Claude (claude-haiku-5-5)",
  );
  assert.equal(
    createTranslator({
      MT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_MODEL: "claude-opus-5-5",
    })?.name,
    "Claude (claude-opus-5-5)",
  );
});
