import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach, mock } from "node:test";
import type { NoticeKind } from "../src/voicevox.ts";

// 入退室案内の保存先を一時ディレクトリにし、テストごとに空にする
const soundsDir = mkdtempSync(join(tmpdir(), "voicevox-test-"));
const noticeCacheDir = join(soundsDir, "notice-cache");
mock.module("../src/sounds.ts", { namedExports: { soundsDir } });
beforeEach(() => rmSync(noticeCacheDir, { recursive: true, force: true }));
after(() => rmSync(soundsDir, { recursive: true, force: true }));

// 1 体目はひまり（14）、2 体目は猫使ビィ（58）
process.env.VOICEVOX_SPEAKER = "14,58";
const {
  assignSpeaker,
  concatWav,
  resolveSpeakers,
  resolveTimeoutMs,
  scaleWav,
  synthesize,
  synthesizeNotice,
} = await import("../src/voicevox.ts");

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
  // 同じ話者の案内を続けて合成すると保存済みの WAV が返り、VOICEVOX を呼ばないため
  rmSync(noticeCacheDir, { recursive: true, force: true });
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

// 16bit モノラルの WAV。サンプル値をそのまま並べる
function makeWav(sampleRate: number, samples: number[]): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => data.writeInt16LE(sample, i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("同じ形式のWAVをつなぐ", () => {
  const wav = concatWav([makeWav(22050, [1, 2]), makeWav(22050, [3])]);
  assert.deepEqual(wav, makeWav(22050, [1, 2, 3]));
});

test("data より前に別のチャンクがあるWAVもつなげる", () => {
  const plain = makeWav(22050, [1]);
  // fmt と data の間に奇数長の LIST チャンクを挟む（偶数境界に 1 バイト詰める）
  const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc\0")]);
  const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
  assert.deepEqual(concatWav([withList, makeWav(22050, [2])]), makeWav(22050, [1, 2]));
});

test("WAVの音量を指定の倍率にする", () => {
  const original = makeWav(22050, [1000, -1000, 3]);
  assert.deepEqual(scaleWav(original, 0.5), makeWav(22050, [500, -500, 2]));
  // 元の WAV は書き換えない
  assert.deepEqual(original, makeWav(22050, [1000, -1000, 3]));
});

test("形式の違うWAVはつながない", () => {
  assert.throws(
    () => concatWav([makeWav(24000, [1]), makeWav(22050, [2])]),
    /形式が揃っていません/,
  );
});

// 日本語は VOICEVOX、韓国語は Piper が受け取ったものとして返す
function mixedFetch(requests: string[], piperOk = true): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/audio_query")) {
      requests.push(`query:${decodeURIComponent(url.match(/text=([^&]*)/)![1])}`);
      return new Response('{"accent_phrases":[],"outputSamplingRate":24000}');
    }
    if (url.includes("/synthesis")) {
      requests.push(`synthesis:${String(init?.body)}`);
      return new Response(makeWav(22050, [1]));
    }
    requests.push(`piper:${String(init?.body)}`);
    return piperOk ? new Response(makeWav(22050, [2000])) : new Response("boom", { status: 500 });
  };
}

test("韓国語の名前はPiper、残りはVOICEVOXで合成してつなぐ", async () => {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mixedFetch(requests);
  try {
    const wav = await synthesizeNotice("김철수", "join", "bot-1");
    // 名前（韓国語）が先、「が入室しました」が後。韓国語は日本語の音量に合わせて下げる
    assert.deepEqual(wav, makeWav(22050, [700, 1]));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests.sort(), [
    'piper:{"text":"김철수"}',
    "query:が入室しました",
    // つなぐため、VOICEVOX の出力を Piper と同じサンプリングレートにする
    'synthesis:{"accent_phrases":[],"outputSamplingRate":22050}',
  ]);
});

test("日本語・韓国語・日本語の文を順につなぐ", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mixedFetch([]);
  try {
    const wav = await synthesize("今日は 안녕하세요 でした", "bot-1");
    assert.deepEqual(wav, makeWav(22050, [1, 700, 1]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Piperが落ちていたら日本語の部分だけ読む", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = mixedFetch([], false);
  console.error = () => {};
  try {
    const wav = await synthesize("今日は 안녕하세요 でした", "bot-1");
    assert.deepEqual(wav, makeWav(22050, [1, 1]));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("韓国語だけの文もPiperの音量を下げる", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mixedFetch([]);
  try {
    assert.deepEqual(await synthesize("안녕하세요", "bot-1"), makeWav(22050, [700]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 呼ばれた回数を数えながら、日本語だけの案内を合成したものとして返す
function countingFetch(calls: string[]): typeof globalThis.fetch {
  return async (input) => {
    calls.push(String(input));
    return String(input).includes("/audio_query")
      ? new Response('{"accent_phrases":[]}')
      : new Response(Buffer.from("RIFF-fake-wav"));
  };
}

test("同じ入退室案内は2回目からVOICEVOXを呼ばずに保存済みのWAVを返す", async () => {
  const calls: string[] = [];
  assert.equal((await synthesizeWith(countingFetch(calls)))?.toString(), "RIFF-fake-wav");
  assert.equal(calls.length, 2);

  assert.equal((await synthesizeWith(countingFetch(calls)))?.toString(), "RIFF-fake-wav");
  assert.equal(calls.length, 2, "2 回目は合成しない");
  assert.equal(readdirSync(noticeCacheDir).length, 1);
});

test("案内の種類か話者が違えば別に合成する", async () => {
  assignSpeaker("bot-a", 0);
  assignSpeaker("bot-b", 1);
  const calls: string[] = [];
  await synthesizeWith(countingFetch(calls), "join", "bot-a");
  await synthesizeWith(countingFetch(calls), "leave", "bot-a");
  await synthesizeWith(countingFetch(calls), "join", "bot-b");
  assert.equal(calls.length, 6);
  assert.equal(readdirSync(noticeCacheDir).length, 3);
});

test("合成に失敗した入退室案内は保存しない", async () => {
  await synthesizeWith(async () => new Response("boom", { status: 500 }));
  const calls: string[] = [];
  assert.equal((await synthesizeWith(countingFetch(calls)))?.toString(), "RIFF-fake-wav");
  assert.equal(calls.length, 2, "前回の失敗を使い回さず合成し直す");
});

test("Piperが落ちて日本語だけ読めた入退室案内は保存しない", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    globalThis.fetch = mixedFetch([], false);
    assert.deepEqual(await synthesizeNotice("김철수", "join", "bot-1"), makeWav(22050, [1]));

    const requests: string[] = [];
    globalThis.fetch = mixedFetch(requests);
    assert.deepEqual(await synthesizeNotice("김철수", "join", "bot-1"), makeWav(22050, [700, 1]));
    assert.equal(requests.length, 3, "名前まで読めた音声を合成し直す");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("チャットの読み上げは保存しない", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = countingFetch([]);
  try {
    await synthesize("こんにちは", "bot-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(readdirSync(soundsDir), []);
});
