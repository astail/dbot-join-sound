import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
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
  configureVoiceTranslation,
  readSpeakers,
  voiceTranslation,
  writeSpeakers,
} = await import("../src/k2j.ts");
const { handleInteraction } = await import("../src/commands.ts");

// 話者の一覧は sounds/k2j.json ひとつを共有するので、触るテストはこのファイルにまとめて毎回消す
const speakersPath = join(soundsDir, "k2j.json");

beforeEach(() => {
  inCall = true;
  configureVoiceTranslation(null, {});
});

afterEach(async () => {
  await unlink(speakersPath).catch(() => {});
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
      post: async (userId: string, ko: string, ja: string) => {
        posts.push(`${userId}|${ko}|${ja}`);
      },
      notifyError: (message: string) => {
        errors.push(message);
      },
    },
  };
}

test("発話を文字起こしして訳し、字幕にする", async () => {
  const wavs: Buffer[] = [];
  const { translator, calls } = fakeTranslator();
  const pipeline = new VoicePipeline(async (wav) => {
    wavs.push(wav);
    return "오늘 뭐 해?";
  }, translator);
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(), out);
  await flush();

  // 文字起こしには 16kHz モノラルの WAV を渡す
  assert.equal(wavs.length, 1);
  assert.equal(wavs[0]!.readUInt32LE(24), 16_000);
  assert.deepEqual(calls, [
    { text: "오늘 뭐 해?", options: { from: "ko", to: "ja", speech: true } },
  ]);
  assert.deepEqual(posts, ["u1|오늘 뭐 해?|訳:오늘 뭐 해?"]);
  const stats = pipeline.statsFor("g1");
  assert.equal(stats.processed, 1);
  assert.notEqual(stats.lastLatencyMs, null);
});

test("短すぎる発話と音量の小さい発話は文字起こしに回さない", async () => {
  let transcribed = 0;
  const pipeline = new VoicePipeline(async () => {
    transcribed++;
    return "오늘 뭐 해?";
  }, fakeTranslator().translator);
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(0.3), out);
  pipeline.handleUtterance("g1", "u1", speech(0.5, 100), out);
  await flush();

  assert.equal(transcribed, 0);
  assert.deepEqual(posts, []);
  assert.equal(pipeline.statsFor("g1").dropped, 2);
});

test("相槌だけの発話は訳さない", async () => {
  const { translator, calls } = fakeTranslator();
  const pipeline = new VoicePipeline(async () => "네, 네", translator);
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(), out);
  await flush();

  assert.equal(calls.length, 0);
  assert.deepEqual(posts, []);
  assert.equal(pipeline.statsFor("g1").dropped, 1);
});

test("同じ人の同じ文が続けて届いたら 2 回目は捨てる", async () => {
  const pipeline = new VoicePipeline(async () => "오늘 뭐 해?", fakeTranslator().translator);
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(), out);
  pipeline.handleUtterance("g1", "u1", speech(), out);
  // 別の人なら同じ文でも字幕にする
  pipeline.handleUtterance("g1", "u2", speech(), out);
  await flush();

  assert.deepEqual(posts, ["u1|오늘 뭐 해?|訳:오늘 뭐 해?", "u2|오늘 뭐 해?|訳:오늘 뭐 해?"]);
  assert.equal(pipeline.statsFor("g1").dropped, 1);
});

test("同じ人の発話は、文字起こしが前後しても話した順に字幕にする", async () => {
  const resolvers: ((text: string) => void)[] = [];
  const pipeline = new VoicePipeline(
    () => new Promise((resolve) => resolvers.push(resolve)),
    fakeTranslator().translator,
  );
  const { out, posts } = fakeOutput();

  pipeline.handleUtterance("g1", "u1", speech(), out);
  pipeline.handleUtterance("g1", "u1", speech(), out);
  await flush();
  // 2 つ目は 1 つ目が終わるまで文字起こしに回らない
  assert.equal(resolvers.length, 1);
  resolvers[0]!("첫 번째 말");
  await flush();
  resolvers[1]!("두 번째 말");
  await flush();

  assert.deepEqual(posts, ["u1|첫 번째 말|訳:첫 번째 말", "u1|두 번째 말|訳:두 번째 말"]);
});

test("文字起こしは全体で 2 件までしか同時に投げない", async () => {
  const resolvers: ((text: string) => void)[] = [];
  const pipeline = new VoicePipeline(
    () => new Promise((resolve) => resolvers.push(resolve)),
    fakeTranslator().translator,
  );
  const { out, posts } = fakeOutput();

  for (const user of ["u1", "u2", "u3"]) pipeline.handleUtterance("g1", user, speech(), out);
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
    pipeline.handleUtterance("g1", "u1", speech(), out);
    await flush();
    fail = false;
    pipeline.handleUtterance("g1", "u1", speech(), out);
    await flush();
  } finally {
    error.mock.restore();
  }

  // エラーの本文（API キーの一部が入ることがある）はチャットに出さない
  assert.deepEqual(errors, [
    "字幕を作れませんでした。`docker compose logs bot` で原因を確認してください。",
  ]);
  assert.equal(pipeline.statsFor("g1").errors, 1);
  assert.deepEqual(posts, ["u1|오늘 뭐 해?|訳:오늘 뭐 해?"]);
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

test("話者の一覧を保存して読み出す", async () => {
  assert.deepEqual(readSpeakers(), []);
  await writeSpeakers(["1", "2"]);
  assert.deepEqual(readSpeakers(), ["1", "2"]);
});

type Reply = { content: string; allowedMentions?: unknown };

// /k2j を処理させて、返信（deferReply 後の editReply を含む）を返す
async function runK2j(
  subcommand: string,
  user: { id: string; bot?: boolean } = { id: "100" },
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
    },
    reply: record,
    deferReply: async () => {},
    editReply: record,
  } as unknown as Interaction;
  await handleInteraction(interaction);
  return replies;
}

test("/k2j add で話者に指定し、通知は飛ばさない", async () => {
  const [reply] = await runK2j("add", { id: "100" });
  assert.match(reply!.content, /<@100> を韓国語話者にしました/);
  assert.deepEqual(reply!.allowedMentions, { parse: [] });
  assert.deepEqual(readSpeakers(), ["100"]);

  const [again] = await runK2j("add", { id: "100" });
  assert.match(again!.content, /すでに韓国語話者です/);
  assert.deepEqual(readSpeakers(), ["100"]);
});

test("/k2j add で Bot は指定できない", async () => {
  const [reply] = await runK2j("add", { id: "200", bot: true });
  assert.match(reply!.content, /Bot は韓国語話者に指定できません/);
  assert.deepEqual(readSpeakers(), []);
});

test("/k2j remove で指定を外す", async () => {
  await writeSpeakers(["100", "101"]);
  const [reply] = await runK2j("remove", { id: "100" });
  assert.match(reply!.content, /<@100> を韓国語話者から外しました/);
  assert.deepEqual(readSpeakers(), ["101"]);

  const [missing] = await runK2j("remove", { id: "999" });
  assert.match(missing!.content, /指定されていません/);
});

test("/k2j list で話者の一覧を出す", async () => {
  const [empty] = await runK2j("list");
  assert.equal(empty!.content, "韓国語話者はまだ指定されていません。");

  await writeSpeakers(["100", "101"]);
  const [reply] = await runK2j("list");
  assert.equal(reply!.content, "韓国語話者:\n<@100>\n<@101>");
  assert.deepEqual(reply!.allowedMentions, { parse: [] });
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
  await writeSpeakers(["100"]);
  const [reply] = await runK2j("status");
  assert.equal(
    reply!.content,
    [
      "翻訳: DeepL / 文字起こし: OpenAI (gpt-4o-mini-transcribe)",
      "韓国語話者: 1 人",
      "このサーバー: 字幕 0 件 / 捨てた発話 0 件 / 失敗 0 件",
      "DeepL の使用量: 10 / 500,000 文字",
    ].join("\n"),
  );
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
  assert.deepEqual(readSpeakers(), []);
});
