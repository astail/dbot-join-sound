import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TranslationIndex } from "../src/translations.ts";

test("元の発言ごとに言語別の翻訳を持つ", () => {
  const index = new TranslationIndex(":memory:");
  index.set("m1", "ko", { translationId: "t1", sourceText: "a" });
  index.set("m1", "ja", { translationId: "t2", sourceText: "a" });
  assert.equal(index.get("m1", "ko")?.translationId, "t1");
  assert.deepEqual(
    index.entries("m1").map(([lang, entry]) => [lang, entry.translationId]),
    [
      ["ja", "t2"],
      ["ko", "t1"],
    ],
  );
});

test("翻訳メッセージが消えたら対応を忘れる（付け直せばまた投稿できる）", () => {
  const index = new TranslationIndex(":memory:");
  index.set("m1", "ko", { translationId: "t1", sourceText: "a" });
  index.forgetTranslation("t1");
  assert.equal(index.get("m1", "ko"), undefined);
  index.forgetTranslation("unknown"); // 関係のない ID は無視する
});

test("上限を超えたら古い発言から忘れる", () => {
  const index = new TranslationIndex(":memory:", 2);
  index.set("m1", "ko", { translationId: "t1", sourceText: "a" });
  index.set("m2", "ko", { translationId: "t2", sourceText: "a" });
  index.set("m3", "ko", { translationId: "t3", sourceText: "a" });
  assert.equal(index.get("m1", "ko"), undefined);
  assert.equal(index.get("m2", "ko")?.translationId, "t2");
  assert.equal(index.get("m3", "ko")?.translationId, "t3");
});

test("編集に合わせて元の本文を差し替えられる", () => {
  const index = new TranslationIndex(":memory:");
  index.set("m1", "ja", { translationId: "t1", sourceText: "before" });
  index.updateSource("m1", "ja", "after");
  assert.deepEqual(index.get("m1", "ja"), { translationId: "t1", sourceText: "after" });
});

test("同じ本文の訳文をキャッシュから取り出す", () => {
  const index = new TranslationIndex(":memory:");
  index.cacheTranslation("m1", "ko", "こんにちは", "안녕하세요");
  assert.equal(index.cachedTranslation("m1", "ko", "こんにちは"), "안녕하세요");
  assert.equal(index.cachedTranslation("m1", "ko", "こんばんは"), undefined);
  assert.equal(index.cachedTranslation("m1", "ja", "こんにちは"), undefined);
});

test("開き直しても（再起動しても）対応が残っている", () => {
  const dir = mkdtempSync(join(tmpdir(), "translations-"));
  try {
    const path = join(dir, "translations.db");
    const index = new TranslationIndex(path);
    index.set("m1", "ko", { translationId: "t1", sourceText: "こんにちは" });
    index.close();

    const reopened = new TranslationIndex(path);
    assert.deepEqual(reopened.get("m1", "ko"), {
      translationId: "t1",
      sourceText: "こんにちは",
    });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
