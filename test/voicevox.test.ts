import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSpeaker,
  resolveTimeoutMs,
  synthesizeJoinNotice,
} from "../src/voicevox.ts";

// VOICEVOX を呼ばずに合成させ、リクエスト先と返した WAV を確認する
async function synthesizeWith(
  fetchStub: typeof globalThis.fetch,
): Promise<Buffer | null> {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = fetchStub;
  console.error = () => {};
  try {
    return await synthesizeJoinNotice("アステル");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
}

test("話者IDのデフォルトは冥鳴ひまり（14）", () => {
  assert.equal(resolveSpeaker(undefined), 14);
  assert.equal(resolveSpeaker(""), 14);
  assert.equal(resolveSpeaker("0"), 0);
  assert.equal(resolveSpeaker("47"), 47);
});

test("不正な話者IDを拒否する", () => {
  assert.throws(() => resolveSpeaker("-1"), /0 以上の整数/);
  assert.throws(() => resolveSpeaker("1.5"), /0 以上の整数/);
  assert.throws(() => resolveSpeaker("zundamon"), /0 以上の整数/);
});

test("タイムアウトのデフォルトは10秒", () => {
  assert.equal(resolveTimeoutMs(undefined), 10_000);
  assert.equal(resolveTimeoutMs(""), 10_000);
  assert.equal(resolveTimeoutMs("500"), 500);
});

test("不正なタイムアウトを拒否する", () => {
  assert.throws(() => resolveTimeoutMs("0"), /1 以上の整数/);
  assert.throws(() => resolveTimeoutMs("-1"), /1 以上の整数/);
  assert.throws(() => resolveTimeoutMs("soon"), /1 以上の整数/);
});

test("表示名から入室案内のWAVを合成する", async () => {
  const urls: string[] = [];
  const bodies: string[] = [];

  const wav = await synthesizeWith(async (input, init) => {
    urls.push(String(input));
    if (init?.body) bodies.push(String(init.body));
    return String(input).includes("/audio_query")
      ? new Response('{"accent_phrases":[]}')
      : new Response(Buffer.from("RIFF-fake-wav"));
  });

  assert.equal(wav?.toString(), "RIFF-fake-wav");
  // audio_query の結果をそのまま synthesis へ渡す 2 段構成
  assert.match(urls[0], /\/audio_query\?text=.*&speaker=14$/);
  assert.ok(urls[0].includes(encodeURIComponent("アステルさんが入室しました")));
  assert.match(urls[1], /\/synthesis\?speaker=14$/);
  assert.deepEqual(bodies, ['{"accent_phrases":[]}']);
});

test("audio_queryが失敗したら合成しない", async () => {
  const urls: string[] = [];

  const wav = await synthesizeWith(async (input) => {
    urls.push(String(input));
    return new Response("boom", { status: 500 });
  });

  assert.equal(wav, null);
  assert.equal(urls.length, 1, "synthesis は呼ばない");
});

test("synthesisが失敗したらnullを返す", async () => {
  const wav = await synthesizeWith(async (input) =>
    String(input).includes("/audio_query")
      ? new Response('{"accent_phrases":[]}')
      : new Response("boom", { status: 500 }),
  );

  assert.equal(wav, null);
});

test("VOICEVOXへ接続できなくてもthrowしない", async () => {
  const wav = await synthesizeWith(async () => {
    throw new Error("ECONNREFUSED");
  });

  assert.equal(wav, null);
});
