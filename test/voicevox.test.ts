import assert from "node:assert/strict";
import test from "node:test";
import type { NoticeKind } from "../src/voicevox.ts";

// 1 体目はひまり（14）、2 体目は猫使ビィ（58）
process.env.VOICEVOX_SPEAKER = "14,58";
const { assignSpeaker, resolveSpeakers, resolveTimeoutMs, synthesizeNotice } =
  await import("../src/voicevox.ts");

// VOICEVOX を呼ばずに合成させ、リクエスト先と返した WAV を確認する
async function synthesizeWith(
  fetchStub: typeof globalThis.fetch,
  kind: NoticeKind = "join",
  botId = "bot-1",
): Promise<Buffer | null> {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = fetchStub;
  console.error = () => {};
  try {
    return await synthesizeNotice("アステル", kind, botId);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
}

test("話者IDのデフォルトは冥鳴ひまり（14）", () => {
  assert.deepEqual(resolveSpeakers(undefined), [14]);
  assert.deepEqual(resolveSpeakers(""), [14]);
  assert.deepEqual(resolveSpeakers("0"), [0]);
  assert.deepEqual(resolveSpeakers("47"), [47]);
});

test("話者IDをカンマ区切りでBotごとに指定できる", () => {
  assert.deepEqual(resolveSpeakers("14,58"), [14, 58]);
  assert.deepEqual(resolveSpeakers(" 14 , 58 "), [14, 58]);
});

test("不正な話者IDを拒否する", () => {
  assert.throws(() => resolveSpeakers("-1"), /0 以上の整数/);
  assert.throws(() => resolveSpeakers("1.5"), /0 以上の整数/);
  assert.throws(() => resolveSpeakers("zundamon"), /0 以上の整数/);
  assert.throws(() => resolveSpeakers("14,"), /0 以上の整数/);
  assert.throws(() => resolveSpeakers("14,,58"), /0 以上の整数/);
});

// VOICEVOX へ送った話者 ID を返す
async function speakerFor(botId: string): Promise<string | undefined> {
  const urls: string[] = [];
  await synthesizeWith(async (input) => {
    urls.push(String(input));
    return String(input).includes("/audio_query")
      ? new Response('{"accent_phrases":[]}')
      : new Response(Buffer.from("RIFF-fake-wav"));
  }, "join", botId);
  return urls[0].match(/speaker=(\d+)$/)?.[1];
}

test("Botごとに割り当てた話者で読む", async () => {
  assignSpeaker("bot-a", 0);
  assignSpeaker("bot-b", 1);
  assert.equal(await speakerFor("bot-a"), "14");
  assert.equal(await speakerFor("bot-b"), "58");
});

test("話者の指定が足りないBotと割り当てのないBotは1つ目の話者で読む", async () => {
  assignSpeaker("bot-c", 2);
  assert.equal(await speakerFor("bot-c"), "14");
  assert.equal(await speakerFor("unknown-bot"), "14");
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
  assert.ok(urls[0].includes(encodeURIComponent("アステルが入室しました")));
  assert.match(urls[1], /\/synthesis\?speaker=14$/);
  assert.deepEqual(bodies, ['{"accent_phrases":[]}']);
});

test("表示名から退室案内のWAVを合成する", async () => {
  const urls: string[] = [];

  const wav = await synthesizeWith(async (input) => {
    urls.push(String(input));
    return String(input).includes("/audio_query")
      ? new Response('{"accent_phrases":[]}')
      : new Response(Buffer.from("RIFF-fake-wav"));
  }, "leave");

  assert.equal(wav?.toString(), "RIFF-fake-wav");
  assert.ok(urls[0].includes(encodeURIComponent("アステルが退室しました")));
});

test("表示名から移動案内のWAVを合成する", async () => {
  const urls: string[] = [];

  const wav = await synthesizeWith(async (input) => {
    urls.push(String(input));
    return String(input).includes("/audio_query")
      ? new Response('{"accent_phrases":[]}')
      : new Response(Buffer.from("RIFF-fake-wav"));
  }, "move");

  assert.equal(wav?.toString(), "RIFF-fake-wav");
  assert.ok(urls[0].includes(encodeURIComponent("アステルがチャンネルを移動しました")));
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
