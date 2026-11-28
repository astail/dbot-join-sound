import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import test, { afterEach, beforeEach, mock } from "node:test";
import type { Interaction } from "discord.js";
import { soundsDir } from "../src/sounds.ts";
import type { TranslateOptions, Translator } from "../src/translator.ts";

// コマンドは Bot が通話にいるときだけ動く。通話の中身はここでは関係ないのでモックする
let inCall = true;
mock.module("../src/voice.ts", {
  namedExports: {
    getSession: () => undefined,
    hasSessionInGuild: () => inCall,
    enqueueText: () => {},
  },
});

const {
  VoicePipeline,
  captureUtterance,
  configureVoiceTranslation,
  listenForSpeech,
  readSpeakers,
  readTriggers,
  voiceTranslation,
  writeSpeakers,
  writeTriggers,
} = await import("../src/k2j.ts");
const { handleInteraction } = await import("../src/commands.ts");

// 話者の一覧は sounds/k2j.json、字幕の条件は sounds/k2j-triggers.json ひとつずつを共有するので、
// 触るテストはこのファイルにまとめて毎回消す
const speakersPath = join(soundsDir, "k2j.json");
const triggersPath = join(soundsDir, "k2j-triggers.json");

beforeEach(() => {
  inCall = true;
  configureVoiceTranslation(null, {});
});

afterEach(async () => {
  // 一覧はメモリにも持つので、ファイルを消す前に空にしておく
  await writeSpeakers({});
  await unlink(speakersPath).catch(() => {});
  await writeTriggers([]);
  await unlink(triggersPath).catch(() => {});
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

// 48kHz ステレオの s16le PCM（左右とも value）。既定は 0.5 秒・字幕にする大きさ
function speech(seconds = 0.5, value = 1000): Buffer {
  const frames = Math.round(48_000 * seconds);
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(value, i * 4);
    buf.writeInt16LE(value, i * 4 + 2);
  }
  return buf;
}

function fakeTranslator(translate: (text: string) => Promise<string> = async (t) => `訳:${t}`) {
  const calls: { text: string; options: TranslateOptions }[] = [];
  const translator: Translator = {
    name: "fake",
    translate: async (text, options) => {
      calls.push({ text, options });
      return translate(text);
    },
  };
  return { translator, calls };
}

function fakeOutput() {
  const posts: string[] = [];
  const errors: string[] = [];
  return {
    posts,
    errors,
    out: {
      post: async (userId: string, original: string, translated: string, to: string) => {
        posts.push(`${userId}|${original}|${translated}|${to}`);
        return true;
      },
      notifyError: (message: string) => {
        errors.push(message);
      },
    },
  };
}

test("韓国語話者の発話を韓国語で文字起こしして日本語に訳し、字幕にする", async () => {
  const wavs: Buffer[] = [];
  const languages: string[] = [];
  const { translator, calls } = fakeTranslator();
  const pipeline = new VoicePipeline(async (wav, language) => {
    wavs.push(wav);
    languages.push(language);
    return "오늘 뭐 해?";
  }, translator);
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
  await flush();

  // 文字起こしには 16kHz モノラルの WAV と話者の言語を渡す
  assert.equal(wavs.length, 1);
  assert.equal(wavs[0]!.readUInt32LE(24), 16_000);
  assert.deepEqual(languages, ["ko"]);
  assert.deepEqual(calls, [
    { text: "오늘 뭐 해?", options: { from: "ko", to: "ja", speech: true } },
  ]);
  assert.deepEqual(posts, ["u1|오늘 뭐 해?|訳:오늘 뭐 해?|ja"]);
  const stats = pipeline.statsFor("g1");
  assert.equal(stats.processed, 1);
  assert.notEqual(stats.lastLatencyMs, null);
});

test("日本語話者の発話は日本語で文字起こしして韓国語に訳す", async () => {
  const languages: string[] = [];
  const { translator, calls } = fakeTranslator();
  const pipeline = new VoicePipeline(async (_wav, language) => {
    languages.push(language);
    return "明日も一緒にやろう";
  }, translator);
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(), "ja", out);
  await flush();

  assert.deepEqual(languages, ["ja"]);
  assert.deepEqual(calls, [
    { text: "明日も一緒にやろう", options: { from: "ja", to: "ko", speech: true } },
  ]);
  assert.deepEqual(posts, ["u1|明日も一緒にやろう|訳:明日も一緒にやろう|ko"]);
});

test("日本語話者の相槌も訳さない", async () => {
  const { translator, calls } = fakeTranslator();
  const pipeline = new VoicePipeline(async () => "うんうん、なるほど", translator);
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(), "ja", out);
  await flush();

  assert.equal(calls.length, 0);
  assert.deepEqual(posts, []);
});

test("短すぎる発話と音量の小さい発話は文字起こしに回さない", async () => {
  let transcribed = 0;
  const pipeline = new VoicePipeline(async () => {
    transcribed++;
    return "오늘 뭐 해?";
  }, fakeTranslator().translator);
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(0.3), "ko", out);
  pipeline.handleUtterance("g1", "u1", speech(0.5, 100), "ko", out);
  await flush();

  assert.equal(transcribed, 0);
  assert.deepEqual(posts, []);
  assert.equal(pipeline.statsFor("g1").dropped, 2);
});

test("相槌だけの発話は訳さない", async () => {
  const { translator, calls } = fakeTranslator();
  const pipeline = new VoicePipeline(async () => "네, 네", translator);
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
  await flush();

  assert.equal(calls.length, 0);
  assert.deepEqual(posts, []);
  assert.equal(pipeline.statsFor("g1").dropped, 1);
});

test("同じ人の同じ文が続けて届いたら 2 回目は捨てる", async () => {
  const pipeline = new VoicePipeline(async () => "오늘 뭐 해?", fakeTranslator().translator);
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
  pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
  // 別の人なら同じ文でも字幕にする
  pipeline.handleUtterance("g1", "u2", speech(), "ko", out);
  await flush();

  assert.deepEqual(posts, ["u1|오늘 뭐 해?|訳:오늘 뭐 해?|ja", "u2|오늘 뭐 해?|訳:오늘 뭐 해?|ja"]);
  assert.equal(pipeline.statsFor("g1").dropped, 1);
});

test("同じ人の発話は、文字起こしが前後しても話した順に字幕にする", async () => {
  const resolvers: ((text: string) => void)[] = [];
  const pipeline = new VoicePipeline(
    () => new Promise((resolve) => resolvers.push(resolve)),
    fakeTranslator().translator,
  );
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
  pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
  await flush();
  // 2 つ目は 1 つ目が終わるまで文字起こしに回らない
  assert.equal(resolvers.length, 1);
  resolvers[0]!("첫 번째 말");
  await flush();
  resolvers[1]!("두 번째 말");
  await flush();

  assert.deepEqual(posts, ["u1|첫 번째 말|訳:첫 번째 말|ja", "u1|두 번째 말|訳:두 번째 말|ja"]);
});

test("文字起こしは全体で 2 件までしか同時に投げない", async () => {
  const resolvers: ((text: string) => void)[] = [];
  const pipeline = new VoicePipeline(
    () => new Promise((resolve) => resolvers.push(resolve)),
    fakeTranslator().translator,
  );
  const { out, posts } = fakeOutput();

  for (const user of ["u1", "u2", "u3"]) pipeline.handleUtterance("g1", user, speech(), "ko", out);
  await flush();
  assert.equal(resolvers.length, 2);
  resolvers[0]!("첫 번째 말");
  await flush();
  assert.equal(resolvers.length, 3);
  resolvers[1]!("두 번째 말");
  resolvers[2]!("세 번째 말");
  await flush();
  assert.equal(posts.length, 3);
});

test("失敗したら数えてチャットに知らせ、次の発話は続けて処理する", async () => {
  let fail = true;
  const pipeline = new VoicePipeline(async () => {
    if (fail) throw new Error("OpenAI STT 401: invalid key");
    return "오늘 뭐 해?";
  }, fakeTranslator().translator);
  const { out, posts, errors } = fakeOutput();
  const error = mock.method(console, "error", () => {});
  try {
    pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
    await flush();
    fail = false;
    pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
    await flush();
  } finally {
    error.mock.restore();
  }

  // エラーの本文（API キーの一部が入ることがある）はチャットに出さない
  assert.deepEqual(errors, [
    "字幕を作れませんでした。`docker compose logs bot` で原因を確認してください。",
  ]);
  assert.equal(pipeline.statsFor("g1").errors, 1);
  assert.deepEqual(posts, ["u1|오늘 뭐 해?|訳:오늘 뭐 해?|ja"]);
});

test("音声翻訳は OpenAI の API キーと翻訳エンジンの両方があるときだけ有効になる", () => {
  const { translator } = fakeTranslator();
  assert.equal(configureVoiceTranslation(null, { OPENAI_API_KEY: "sk-test" }), false);
  assert.equal(voiceTranslation(), null);
  assert.equal(configureVoiceTranslation(translator, {}), false);
  assert.equal(configureVoiceTranslation(translator, { OPENAI_API_KEY: " " }), false);
  assert.equal(voiceTranslation(), null);

  assert.equal(configureVoiceTranslation(translator, { OPENAI_API_KEY: "sk-test" }), true);
  assert.equal(voiceTranslation()?.sttModel, "gpt-4o-mini-transcribe");
  configureVoiceTranslation(translator, { OPENAI_API_KEY: "sk-test", STT_MODEL: "whisper-1" });
  assert.equal(voiceTranslation()?.sttModel, "whisper-1");
});

test("話者の一覧（人ごとの言語）を保存して読み出す", async () => {
  assert.deepEqual(readSpeakers(), {});
  await writeSpeakers({ "1": "ko", "2": "ja" });
  assert.deepEqual(readSpeakers(), { "1": "ko", "2": "ja" });
});

type Reply = { content: string; allowedMentions?: unknown };

// /k2j を処理させて、返信（deferReply 後の editReply を含む）を返す
async function runK2j(
  subcommand: string,
  user: { id: string; bot?: boolean } = { id: "100" },
  lang: string | null = null,
): Promise<Reply[]> {
  const replies: Reply[] = [];
  const record = async (reply: string | Reply) => {
    replies.push(typeof reply === "string" ? { content: reply } : reply);
  };
  const interaction = {
    isChatInputCommand: () => true,
    commandName: "k2j",
    guildId: "g1",
    channelId: "c1",
    options: {
      getSubcommand: () => subcommand,
      getUser: () => ({ bot: false, ...user }),
      getString: () => lang,
    },
    reply: record,
    deferReply: async () => {},
    editReply: record,
  } as unknown as Interaction;
  await handleInteraction(interaction);
  return replies;
}

test("/k2j add は言語を省略すると韓国語話者にし、通知は飛ばさない", async () => {
  const [reply] = await runK2j("add", { id: "100" });
  assert.match(reply!.content, /<@100> を韓国語話者にしました。.*日本語の字幕にします/);
  assert.match(reply!.content, /現在: 韓国語話者 1 人 \/ 日本語話者 0 人/);
  assert.deepEqual(reply!.allowedMentions, { parse: [] });
  assert.deepEqual(readSpeakers(), { "100": "ko" });

  const [again] = await runK2j("add", { id: "100" });
  assert.match(again!.content, /すでに韓国語話者です/);
});

test("/k2j add は字幕の条件にしている人がいなければ、字幕が出ないことも伝える", async () => {
  const [none] = await runK2j("add", { id: "100" });
  assert.match(none!.content, /字幕の条件にしている人がいないので、字幕は出しません/);

  await writeTriggers(["300"]);
  const [some] = await runK2j("add", { id: "101" });
  assert.doesNotMatch(some!.content, /字幕は出しません/);
});

test("/k2j trigger-add と trigger-remove で字幕の条件にする人を指定・解除する", async () => {
  const [added] = await runK2j("trigger-add", { id: "300" });
  assert.match(added!.content, /<@300> を字幕の条件にしました。.*（現在 1 人）/);
  assert.deepEqual(added!.allowedMentions, { parse: [] });
  assert.deepEqual(readTriggers(), ["300"]);

  const [again] = await runK2j("trigger-add", { id: "300" });
  assert.match(again!.content, /すでに字幕の条件にしています/);
  await runK2j("trigger-add", { id: "301" });
  assert.deepEqual(readTriggers(), ["300", "301"]);

  const [removed] = await runK2j("trigger-remove", { id: "300" });
  assert.equal(removed!.content, "<@300> を字幕の条件から外しました（現在 1 人）。");
  const [last] = await runK2j("trigger-remove", { id: "301" });
  assert.match(last!.content, /（現在 0 人）。\n字幕の条件にしている人がいないので、字幕は出しません/);
  assert.deepEqual(readTriggers(), []);

  const [missing] = await runK2j("trigger-remove", { id: "999" });
  assert.match(missing!.content, /字幕の条件にしていません/);
});

test("/k2j trigger-add で Bot は指定できない", async () => {
  const [reply] = await runK2j("trigger-add", { id: "200", bot: true });
  assert.match(reply!.content, /Bot は字幕の条件にできません/);
  assert.deepEqual(readTriggers(), []);
});

test("字幕の条件にする人の一覧を保存して読み出す", async () => {
  assert.deepEqual(readTriggers(), []);
  await writeTriggers(["300", "301"]);
  assert.deepEqual(readTriggers(), ["300", "301"]);
  // 渡した一覧を書き換えても、持っている一覧は変わらない
  readTriggers().push("302");
  assert.deepEqual(readTriggers(), ["300", "301"]);
});

test("/k2j add lang:ja で日本語話者にし、別の言語の指定は置き換える", async () => {
  const [reply] = await runK2j("add", { id: "100" }, "ja");
  assert.match(reply!.content, /<@100> を日本語話者にしました。.*韓国語の字幕にします/);
  assert.deepEqual(readSpeakers(), { "100": "ja" });

  const [changed] = await runK2j("add", { id: "100" }, "ko");
  assert.match(changed!.content, /韓国語話者にしました（日本語話者から変更）/);
  assert.deepEqual(readSpeakers(), { "100": "ko" });
});

test("/k2j add で Bot は指定できない", async () => {
  const [reply] = await runK2j("add", { id: "200", bot: true });
  assert.match(reply!.content, /Bot は話者に指定できません/);
  assert.deepEqual(readSpeakers(), {});
});

test("/k2j remove で指定を外す", async () => {
  await writeSpeakers({ "100": "ko", "101": "ja" });
  const [reply] = await runK2j("remove", { id: "100" });
  assert.match(reply!.content, /<@100> の指定を外しました（現在: 韓国語話者 0 人 \/ 日本語話者 1 人）/);
  assert.deepEqual(readSpeakers(), { "101": "ja" });

  const [missing] = await runK2j("remove", { id: "999" });
  assert.match(missing!.content, /指定されていません/);
});

test("/k2j list で言語ごとに話者の一覧と、字幕の条件にしている人を出す", async () => {
  const [empty] = await runK2j("list");
  assert.equal(
    empty!.content,
    [
      "話者はまだ指定されていません。",
      "字幕の条件にしている人がいないので、字幕は出しません（`/k2j trigger-add` で指定）。",
    ].join("\n"),
  );

  await writeSpeakers({ "100": "ko", "101": "ja", "102": "ko" });
  await writeTriggers(["300"]);
  const [reply] = await runK2j("list");
  assert.equal(
    reply!.content,
    [
      "韓国語話者 → 日本語（2 人）:",
      "- <@100>",
      "- <@102>",
      "日本語話者 → 韓国語（1 人）:",
      "- <@101>",
      "字幕の条件（誰かが Bot と同じ通話にいるときだけ字幕を出す、1 人）:",
      "- <@300>",
    ].join("\n"),
  );
  assert.deepEqual(reply!.allowedMentions, { parse: [] });
});

test("/k2j list は 2000 文字の上限に収まらない分を省略する", async () => {
  const speakers: Record<string, "ko"> = {};
  for (let i = 0; i < 100; i++) speakers[`1000000000000000${String(i).padStart(2, "0")}`] = "ko";
  await writeSpeakers(speakers);
  const [reply] = await runK2j("list");
  assert.ok(reply!.content.length <= 2000);
  assert.match(reply!.content, /\nほか \d+ 行は長さの都合で省略しました。$/);
});

test("/k2j status は無効なら理由を、有効なら設定と件数を出す", async () => {
  const [disabled] = await runK2j("status");
  assert.match(disabled!.content, /止まっています/);

  const translator: Translator = {
    name: "DeepL",
    translate: async (text) => text,
    usage: async () => "DeepL の使用量: 10 / 500,000 文字",
  };
  configureVoiceTranslation(translator, { OPENAI_API_KEY: "sk-test" });
  await writeSpeakers({ "100": "ko" });
  const [reply] = await runK2j("status");
  assert.equal(
    reply!.content,
    [
      "翻訳: DeepL / 文字起こし: OpenAI (gpt-4o-mini-transcribe)",
      "話者: 韓国語話者 1 人 / 日本語話者 0 人",
      "字幕の条件: なし（字幕は出しません）",
      "このサーバー: 字幕 0 件 / 捨てた発話 0 件 / 失敗 0 件",
      "DeepL の使用量: 10 / 500,000 文字",
    ].join("\n"),
  );

  await writeTriggers(["300", "301"]);
  const [withTriggers] = await runK2j("status");
  assert.match(withTriggers!.content, /\n字幕の条件: 2 人\n/);
});

test("Bot が通話にいないときは /k2j も使えない", async () => {
  inCall = false;
  const replies: unknown[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    commandName: "k2j",
    guildId: "g1",
    options: { getSubcommand: () => "add" },
    reply: async (reply: unknown) => {
      replies.push(reply);
    },
  } as unknown as Interaction;
  await handleInteraction(interaction);
  assert.equal(replies.length, 1);
  assert.deepEqual(readSpeakers(), {});
});

test("翻訳に失敗した文を言い直したら、重複として捨てずに字幕にする", async () => {
  let failures = 1;
  const { translator, calls } = fakeTranslator(async (text) => {
    if (failures-- > 0) throw new Error("429 Too Many Requests");
    return `訳:${text}`;
  });
  const pipeline = new VoicePipeline(async () => "오늘 뭐 해?", translator);
  const { out, posts } = fakeOutput();
  const error = mock.method(console, "error", () => {});
  try {
    pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
    await flush();
    pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
    await flush();
  } finally {
    error.mock.restore();
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(posts, ["u1|오늘 뭐 해?|訳:오늘 뭐 해?|ja"]);
});

test("字幕を投稿できなかったときは「字幕」に数えず、投稿の失敗は「失敗」に数える", async () => {
  const pipeline = new VoicePipeline(async () => "오늘 뭐 해?", fakeTranslator().translator);
  const error = mock.method(console, "error", () => {});
  try {
    // Bot が抜けた・送れるチャンネルがない
    pipeline.handleUtterance("g1", "u1", speech(), "ko", {
      post: async () => false,
      notifyError: () => {},
    });
    await flush();
    // 送ろうとして失敗した
    pipeline.handleUtterance("g1", "u2", speech(), "ko", {
      post: async () => {
        throw new Error("Missing Permissions");
      },
      notifyError: () => {},
    });
    await flush();
  } finally {
    error.mock.restore();
  }
  const stats = pipeline.statsFor("g1");
  assert.equal(stats.processed, 0);
  assert.equal(stats.dropped, 1);
  assert.equal(stats.errors, 1);
  assert.equal(stats.lastLatencyMs, null);
});

test("直近の遅延は、同じ人の前の発話を待った時間も含めて受け取った時点から測る", async () => {
  mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    const resolvers: ((text: string) => void)[] = [];
    const pipeline = new VoicePipeline(
      () => new Promise((resolve) => resolvers.push(resolve)),
      fakeTranslator().translator,
    );
    const { out } = fakeOutput();
    pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
    pipeline.handleUtterance("g1", "u1", speech(), "ko", out);
    await flush();
    mock.timers.tick(1000);
    resolvers[0]!("첫 번째 말");
    await flush();
    mock.timers.tick(500);
    resolvers[1]!("두 번째 말");
    await flush();
    assert.equal(pipeline.statsFor("g1").lastLatencyMs, 1500);
  } finally {
    mock.timers.reset();
  }
});

test("話者の一覧は一度読んだらメモリに持ち、話し出すたびにファイルを読み直さない", async () => {
  await writeSpeakers({ "100": "ko" });
  await writeFile(speakersPath, "{ 壊れた JSON");
  const error = mock.method(console, "error", () => {});
  try {
    assert.deepEqual(readSpeakers(), { "100": "ko" });
    assert.equal(error.mock.callCount(), 0);
  } finally {
    error.mock.restore();
  }
  // 渡した一覧を書き換えても、持っている一覧は変わらない
  const speakers = readSpeakers();
  speakers["200"] = "ja";
  assert.deepEqual(readSpeakers(), { "100": "ko" });
});

// 本物の Opus パケット（20ms・48kHz ステレオ・字幕にする大きさの音）
const prism = (await import("prism-media")).default;
const opusPacket: Buffer = await new Promise((resolve) => {
  const encoder = new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: 960 });
  encoder.once("data", (packet: Buffer) => {
    encoder.destroy();
    resolve(packet);
  });
  const pcm = Buffer.alloc(960 * 4);
  for (let i = 0; i < 960; i++) {
    const value = Math.round(8000 * Math.sin(i / 10));
    pcm.writeInt16LE(value, i * 4);
    pcm.writeInt16LE(value, i * 4 + 2);
  }
  encoder.write(pcm);
});

// @discordjs/voice の AudioReceiveStream の代わり。パケットを 1 つずつ流す
function receiveStream(): Readable {
  return new Readable({ objectMode: true, read() {} });
}

async function settle<T>(promise: Promise<T>, ms = 2000): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
}

test("話している途中に接続が破棄されても（close だけで終わっても）、受け取れた分を返して終わる", async () => {
  const stream = receiveStream();
  const capture = captureUtterance({ subscribe: () => stream as never }, "u1");
  for (let i = 0; i < 5; i++) stream.push(opusPacket);
  await flush();
  // @discordjs/voice は接続を破棄するとき、受信中のストリームをエラーなしで destroy する
  stream.destroy();
  const result = await settle(capture);
  assert.notEqual(result, "timeout", "close だけで終わったときに Promise が終わらない");
  if (result === "timeout") return;
  assert.equal(result.truncated, false);
  assert.equal(result.pcm.length, 5 * 960 * 4);
});

test("受け取っている間に keep が false になったら、その発話を捨てて受信を終える", async () => {
  const stream = receiveStream();
  let keep = true;
  const capture = captureUtterance({ subscribe: () => stream as never }, "u1", () => keep);
  for (let i = 0; i < 5; i++) stream.push(opusPacket);
  await flush();
  keep = false;
  stream.push(opusPacket);
  const result = await settle(capture);
  assert.notEqual(result, "timeout");
  if (result === "timeout") return;
  assert.equal(result.pcm.length, 0);
  assert.equal(result.truncated, false);
  assert.equal(stream.destroyed, true);
});

test("受信が失敗して何も受け取れていなければ、失敗として返す", async () => {
  const stream = receiveStream();
  const capture = captureUtterance({ subscribe: () => stream as never }, "u1");
  stream.destroy(new Error("Failed to decrypt"));
  await assert.rejects(capture, /Failed to decrypt/);
});

test("30 秒を超えて話し続けたら、そこで区切ったことを知らせる", async () => {
  const stream = receiveStream();
  const capture = captureUtterance({ subscribe: () => stream as never }, "u1");
  for (let i = 0; i < 1501; i++) stream.push(opusPacket);
  const result = await settle(capture, 10_000);
  assert.notEqual(result, "timeout");
  if (result === "timeout") return;
  assert.equal(result.truncated, true);
  assert.equal(stream.destroyed, true);
});

// listenForSpeech に渡す接続・サーバー・セッションの代わり
function fakeCall() {
  const streams: Readable[] = [];
  const speaking = Object.assign(new EventEmitter(), { users: new Map<string, number>() });
  const connection = {
    receiver: {
      speaking,
      subscribe: mock.fn(() => {
        const stream = receiveStream();
        streams.push(stream);
        return stream;
      }),
    },
  };
  // 通話にいる人（ユーザー ID → いる VC）。既定では host が Bot と同じ vc-1 にいる
  const voiceStates = new Map<string, { channelId: string | null }>([
    ["host", { channelId: "vc-1" }],
  ]);
  const guild = {
    id: "g1",
    channels: { cache: { get: () => undefined } },
    voiceStates: { cache: voiceStates },
  };
  const session = { channelId: "vc-1", destroyed: false };
  return { connection, guild, session, speaking, streams, voiceStates };
}

// 文字起こしの API（OpenAI）を呼ばないよう、空の結果を返させる。run には呼ばれた回数を数えるモックを渡す
async function withSilentTranscription(
  run: (transcribe: { mock: { callCount(): number } }) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const transcribe = mock.fn(
    async () =>
      new Response(JSON.stringify({ text: "" }), {
        headers: { "content-type": "application/json" },
      }),
  );
  globalThis.fetch = transcribe as unknown as typeof fetch;
  try {
    await run(transcribe);
  } finally {
    globalThis.fetch = original;
  }
}

// 文字起こしがもう 1 回呼ばれるまで最大 1 秒待つ（呼ばれないほうを確かめるときは 1 秒待ちきる）
async function waitForTranscription(transcribe: { mock: { callCount(): number } }): Promise<void> {
  const before = transcribe.mock.callCount();
  for (let i = 0; i < 100 && transcribe.mock.callCount() === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("受信が失敗したら、話し続けていてもすぐには拾い直さず、ログも人ごとに間引く", async () => {
  configureVoiceTranslation(fakeTranslator().translator, { OPENAI_API_KEY: "sk-test" });
  await writeSpeakers({ u1: "ko" });
  await writeTriggers(["host"]);
  const call = fakeCall();
  listenForSpeech(call.connection as never, call.guild as never, call.session);
  const error = mock.method(console, "error", () => {});
  try {
    call.speaking.users.set("u1", 1);
    call.speaking.emit("start", "u1");
    call.streams[0]!.destroy(new Error("Failed to decrypt"));
    await flush();
    // 話し続けていても、失敗で終わったときは次に話し始めるまで待つ
    assert.equal(call.connection.receiver.subscribe.mock.callCount(), 1);
    assert.equal(error.mock.callCount(), 1);

    call.speaking.emit("start", "u1");
    call.streams[1]!.destroy(new Error("Failed to decrypt"));
    await flush();
    assert.equal(call.connection.receiver.subscribe.mock.callCount(), 2);
    assert.equal(error.mock.callCount(), 1);
  } finally {
    error.mock.restore();
  }
});

test("30 秒で区切ったあとも話し続けていれば、続きを拾う", async () => {
  configureVoiceTranslation(fakeTranslator().translator, { OPENAI_API_KEY: "sk-test" });
  await writeSpeakers({ u1: "ko" });
  await writeTriggers(["host"]);
  const call = fakeCall();
  listenForSpeech(call.connection as never, call.guild as never, call.session);
  await withSilentTranscription(async () => {
    call.speaking.users.set("u1", 1);
    call.speaking.emit("start", "u1");
    for (let i = 0; i < 1501; i++) call.streams[0]!.push(opusPacket);
    for (let i = 0; i < 500 && call.connection.receiver.subscribe.mock.callCount() < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(call.connection.receiver.subscribe.mock.callCount(), 2);
    call.speaking.users.delete("u1");
    call.streams[1]!.destroy();
    await flush();
  });
});

test("話者に指定していない人の声は受け取らない", async () => {
  configureVoiceTranslation(fakeTranslator().translator, { OPENAI_API_KEY: "sk-test" });
  await writeSpeakers({ u1: "ko" });
  await writeTriggers(["host"]);
  const call = fakeCall();
  listenForSpeech(call.connection as never, call.guild as never, call.session);
  call.speaking.emit("start", "u2");
  await flush();
  assert.equal(call.connection.receiver.subscribe.mock.callCount(), 0);
});

test("字幕の条件にしている人がいなければ、話者の声も受け取らない", async () => {
  configureVoiceTranslation(fakeTranslator().translator, { OPENAI_API_KEY: "sk-test" });
  await writeSpeakers({ u1: "ko" });
  const call = fakeCall();
  listenForSpeech(call.connection as never, call.guild as never, call.session);
  call.speaking.emit("start", "u1");
  await flush();
  assert.equal(call.connection.receiver.subscribe.mock.callCount(), 0);
});

test("字幕の条件にした人の誰かが Bot と同じ通話にいるときだけ、話者の声を受け取る", async () => {
  configureVoiceTranslation(fakeTranslator().translator, { OPENAI_API_KEY: "sk-test" });
  await writeSpeakers({ u1: "ko" });
  await writeTriggers(["t1", "t2"]);
  const call = fakeCall();
  listenForSpeech(call.connection as never, call.guild as never, call.session);
  const subscribed = () => call.connection.receiver.subscribe.mock.callCount();

  // 条件にしていない人（host）しかいない・条件の人が別の VC にいる・通話にいない
  call.voiceStates.set("t1", { channelId: "vc-2" });
  call.voiceStates.set("t2", { channelId: null });
  call.speaking.emit("start", "u1");
  await flush();
  assert.equal(subscribed(), 0);

  // 条件の人のうち 1 人が Bot と同じ VC に来たら受け取る
  call.voiceStates.set("t2", { channelId: "vc-1" });
  call.speaking.emit("start", "u1");
  await flush();
  assert.equal(subscribed(), 1);
  call.streams[0]!.destroy();
  await flush();

  // Bot が vc-2 へ移されたら、移動先にいる人で判断する
  call.voiceStates.delete("t2");
  call.session.channelId = "vc-2";
  call.speaking.emit("start", "u1");
  await flush();
  assert.equal(subscribed(), 2);
  call.streams[1]!.destroy();
  await flush();
});

test("字幕の条件にした人が、話している間に通話を抜けたら、その発話は文字起こしに回さない", async () => {
  configureVoiceTranslation(fakeTranslator().translator, { OPENAI_API_KEY: "sk-test" });
  await writeSpeakers({ u1: "ko" });
  await writeTriggers(["host"]);
  const call = fakeCall();
  listenForSpeech(call.connection as never, call.guild as never, call.session);
  await withSilentTranscription(async (transcribe) => {
    // 0.6 秒話して黙る（leave を渡すと、声が届き終えてから黙り終えるまでの間にその人を抜けさせる）
    const speak = async (stream: Readable, leave?: string) => {
      for (let i = 0; i < 30; i++) stream.push(opusPacket);
      await flush();
      if (leave) call.voiceStates.delete(leave);
      stream.push(null);
      await waitForTranscription(transcribe);
    };
    call.speaking.emit("start", "u1");
    await speak(call.streams[0]!);
    assert.equal(transcribe.mock.callCount(), 1);

    call.speaking.emit("start", "u1");
    await speak(call.streams[1]!, "host");
    assert.equal(transcribe.mock.callCount(), 1);
  });
});

test("字幕の条件にした人が話の途中で抜けたら、話し終える前に戻ってきても、その発話は文字起こしに回さない", async () => {
  configureVoiceTranslation(fakeTranslator().translator, { OPENAI_API_KEY: "sk-test" });
  await writeSpeakers({ u1: "ko" });
  await writeTriggers(["host"]);
  const call = fakeCall();
  listenForSpeech(call.connection as never, call.guild as never, call.session);
  await withSilentTranscription(async (transcribe) => {
    call.speaking.emit("start", "u1");
    const stream = call.streams[0]!;
    for (let i = 0; i < 30; i++) stream.push(opusPacket);
    await flush();
    call.voiceStates.delete("host");
    stream.push(opusPacket);
    await flush();
    // いなくなった時点で受信も終える
    assert.equal(stream.destroyed, true);
    call.voiceStates.set("host", { channelId: "vc-1" });
    await waitForTranscription(transcribe);
    assert.equal(transcribe.mock.callCount(), 0);
  });
});

test("30 秒で区切った時点で字幕の条件にした人がいなければ、区切った分も回さず、続きも拾わない", async () => {
  configureVoiceTranslation(fakeTranslator().translator, { OPENAI_API_KEY: "sk-test" });
  await writeSpeakers({ u1: "ko" });
  await writeTriggers(["host"]);
  const call = fakeCall();
  listenForSpeech(call.connection as never, call.guild as never, call.session);
  await withSilentTranscription(async (transcribe) => {
    call.speaking.users.set("u1", 1);
    call.speaking.emit("start", "u1");
    const stream = call.streams[0]!;
    // 30 秒分を受け取り終えて受信を閉じる瞬間に、条件の人が抜けたことにする
    const destroy = stream.destroy.bind(stream);
    stream.destroy = ((err?: Error) => {
      call.voiceStates.delete("host");
      return destroy(err);
    }) as typeof stream.destroy;
    for (let i = 0; i < 1501; i++) stream.push(opusPacket);
    for (let i = 0; i < 500 && !stream.destroyed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(stream.destroyed, true);
    await waitForTranscription(transcribe);
    assert.equal(transcribe.mock.callCount(), 0);
    assert.equal(call.connection.receiver.subscribe.mock.callCount(), 1);
    call.speaking.users.delete("u1");
  });
});
