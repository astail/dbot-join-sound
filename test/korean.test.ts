import assert from "node:assert/strict";
import test from "node:test";
import { splitKorean, synthesizeKorean } from "../src/korean.ts";

test("ハングルがなければ文をそのまま返す", () => {
  assert.deepEqual(splitKorean("こんにちは!!"), [{ korean: false, text: "こんにちは!!" }]);
  assert.deepEqual(splitKorean("🎉"), [{ korean: false, text: "🎉" }]);
});

test("韓国語だけの文は1つにまとめる", () => {
  assert.deepEqual(splitKorean("오늘 날씨가 정말 좋네요. 같이 게임할 사람 있어요?"), [
    { korean: true, text: "오늘 날씨가 정말 좋네요. 같이 게임할 사람 있어요?" },
  ]);
});

test("日本語に挟まれた韓国語を分ける", () => {
  assert.deepEqual(splitKorean("今日は 안녕하세요 でした"), [
    { korean: false, text: "今日は" },
    { korean: true, text: "안녕하세요" },
    { korean: false, text: "でした" },
  ]);
});

test("入退室案内の韓国語の名前を分ける", () => {
  assert.deepEqual(splitKorean("김철수が入室しました"), [
    { korean: true, text: "김철수" },
    { korean: false, text: "が入室しました" },
  ]);
});

test("韓国語の直前の数字と直後の句読点は韓国語に含める", () => {
  assert.deepEqual(splitKorean("100원!、画像がアップロードされました"), [
    { korean: true, text: "100원!、" },
    { korean: false, text: "画像がアップロードされました" },
  ]);
});

test("子音だけの表現も韓国語として扱う", () => {
  assert.deepEqual(splitKorean("ㅋㅋㅋ 진짜 웃기다"), [
    { korean: true, text: "ㅋㅋㅋ 진짜 웃기다" },
  ]);
});

test("記号だけの切れ端は読まない", () => {
  assert.deepEqual(splitKorean("안녕 🎉 「잘가」"), [
    { korean: true, text: "안녕" },
    { korean: true, text: "잘가" },
  ]);
});

async function synthesizeWith(fetchStub: typeof globalThis.fetch) {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = fetchStub;
  console.error = () => {};
  try {
    return await synthesizeKorean("안녕하세요", 1000);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
}

test("Piperへ文を送ってWAVを受け取る", async () => {
  const requests: { url: string; body: string }[] = [];
  const wav = await synthesizeWith(async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body) });
    return new Response(Buffer.from("RIFF-fake-wav"));
  });

  assert.equal(wav?.toString(), "RIFF-fake-wav");
  assert.deepEqual(requests, [
    { url: "http://piper:5000/synthesize", body: '{"text":"안녕하세요"}' },
  ]);
});

test("Piperが失敗してもthrowせずnullを返す", async () => {
  assert.equal(await synthesizeWith(async () => new Response("boom", { status: 500 })), null);
  assert.equal(
    await synthesizeWith(async () => {
      throw new Error("ECONNREFUSED");
    }),
    null,
  );
});
