import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach, beforeEach, mock } from "node:test";
import { RESTJSONErrorCodes, type Interaction, type Message } from "discord.js";
import { soundsDir } from "../src/sounds.ts";

// 読み上げの順番は queue.test.ts で確かめているので、ここでは何をキューに積むかだけ見る
let session: { channelId: string } | undefined;
const enqueued: string[] = [];
mock.module("../src/voice.ts", {
  namedExports: {
    getSession: () => session,
    enqueueText: (_session: unknown, text: string) => {
      enqueued.push(text);
    },
  },
});

// 辞書は sounds/yomi.json を共有し、テストファイルの並行実行で奪い合うためモックする
mock.module("../src/yomi.ts", {
  namedExports: {
    applyYomi: (text: string) => text.replace("mame", "まめ"),
    normalizeWord: (word: string) => word,
    readDict: () => ({}),
    writeDict: async () => {},
    MAX_WORD_LENGTH: 32,
    MAX_READING_LENGTH: 32,
  },
});

const {
  MAX_SPEECH_LENGTH,
  readChannels,
  readChatMessage,
  resolveVcChatDeleteSeconds,
  scheduleVcChatDeletion,
  toSpeechText,
  writeChannels,
} = await import("../src/chat.ts");
const { handleInteraction } = await import("../src/commands.ts");

// 一覧は sounds/readchannel.json ひとつを共有するため、ファイルを触るテストは
// この 1 ファイルにまとめて、テストごとに消す（node:test はファイル内では直列に走る）
const channelsPath = join(soundsDir, "readchannels.json");

const botId = "1234567890";

beforeEach(() => {
  session = { channelId: "vc-1" };
  enqueued.length = 0;
});

afterEach(async () => {
  await unlink(channelsPath).catch(() => {});
});

function chatMessage(
  channelId: string,
  content: string,
  { bot = false, voice = false } = {},
): Message {
  return {
    author: { bot },
    inGuild: () => true,
    guildId: "test-guild",
    channelId,
    channel: { isVoiceBased: () => voice },
    content,
    cleanContent: content,
    client: { user: { id: botId } },
  } as unknown as Message;
}

// スラッシュコマンドを処理させて返信を返す
async function runReadChannel(
  subcommand: string,
  channelId: string,
  guildChannelIds: string[] = [channelId],
): Promise<string[]> {
  const replies: string[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    commandName: "readchannel",
    channelId,
    guild: { channels: { cache: { has: (id: string) => guildChannelIds.includes(id) } } },
    options: { getSubcommand: () => subcommand },
    reply: async (content: string) => {
      replies.push(content);
    },
  } as unknown as Interaction;

  await handleInteraction(interaction);
  return replies;
}

test("URLは「URL」と読む", () => {
  assert.equal(toSpeechText("見て https://example.com/a?b=c これ"), "見て URL これ");
});

test("伏せ字の中身は読まない", () => {
  assert.equal(toSpeechText("犯人は||ヤス||だった"), "犯人は伏せ字だった");
});

test("カスタム絵文字は読まない", () => {
  assert.equal(toSpeechText("いいね<:thumbsup_custom:123456789>"), "いいね");
  assert.equal(toSpeechText("<a:party:123456789>"), "");
});

test("改行や連続した空白はひとつにまとめる", () => {
  assert.equal(toSpeechText("  おはよう\n\nございます  "), "おはよう ございます");
});

test("長文は途中で打ち切る", () => {
  const text = toSpeechText("あ".repeat(MAX_SPEECH_LENGTH + 1));

  assert.equal(text, `${"あ".repeat(MAX_SPEECH_LENGTH)} 以下略`);
});

test("Botが参加中のVC付属チャットを読み上げる", () => {
  readChatMessage(chatMessage("vc-1", "こんにちは"));

  assert.deepEqual(enqueued, ["こんにちは"]);
});

test("読み上げにも登録した読み方を使う", () => {
  readChatMessage(chatMessage("vc-1", "mameです"));

  assert.deepEqual(enqueued, ["まめです"]);
});

test("Botが参加していないVCの付属チャットは読まない", () => {
  readChatMessage(chatMessage("vc-2", "こんにちは"));

  assert.deepEqual(enqueued, []);
});

test("Botが通話にいなければ読まない", async () => {
  await writeChannels(["text-1"]);
  session = undefined;

  readChatMessage(chatMessage("vc-1", "こんにちは"));
  readChatMessage(chatMessage("text-1", "こんにちは"));

  assert.deepEqual(enqueued, []);
});

test("登録したチャンネルはVC付属チャットでなくても読み上げる", async () => {
  await writeChannels(["text-1"]);

  readChatMessage(chatMessage("text-1", "こんにちは"));
  readChatMessage(chatMessage("text-2", "こんばんは"));

  assert.deepEqual(enqueued, ["こんにちは"]);
});

test("Botの発言とBotへのコマンドは読まない", () => {
  readChatMessage(chatMessage("vc-1", "使い方:", { bot: true }));
  readChatMessage(chatMessage("vc-1", `<@${botId}> check`));

  assert.deepEqual(enqueued, []);
});

test("添付だけの発言は読まない", () => {
  readChatMessage(chatMessage("vc-1", ""));

  assert.deepEqual(enqueued, []);
});

test("addでこのチャンネルを読み上げ対象にする", async () => {
  const replies = await runReadChannel("add", "text-1");

  assert.match(replies[0], /読み上げるようにしました/);
  assert.deepEqual(readChannels(), ["text-1"]);
});

test("addは二重に登録しない", async () => {
  await runReadChannel("add", "text-1");
  const replies = await runReadChannel("add", "text-1");

  assert.deepEqual(replies, ["このチャンネルはすでに読み上げる設定です。"]);
  assert.deepEqual(readChannels(), ["text-1"]);
});

test("removeで読み上げ対象から外す", async () => {
  await writeChannels(["text-1", "text-2"]);

  const replies = await runReadChannel("remove", "text-1");

  assert.deepEqual(replies, ["このチャンネルのチャットを読み上げないようにしました。"]);
  assert.deepEqual(readChannels(), ["text-2"]);
});

test("未登録のチャンネルはremoveできない", async () => {
  const replies = await runReadChannel("remove", "text-1");

  assert.deepEqual(replies, ["このチャンネルは読み上げる設定になっていません。"]);
  assert.equal(existsSync(channelsPath), false, "書き込まない");
});

test("listは実行したサーバーのチャンネルだけ返す", async () => {
  await writeChannels(["text-1", "other-guild-text"]);

  const replies = await runReadChannel("list", "text-1", ["text-1"]);

  assert.deepEqual(replies, ["読み上げるチャンネル:\n<#text-1>"]);
});

test("一覧が壊れていても空として扱う", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  await writeFile(channelsPath, "{ this is not json");
  try {
    assert.deepEqual(readChannels(), []);
  } finally {
    console.error = originalConsoleError;
  }
});

test("自動削除までの秒数のデフォルトは30秒", () => {
  assert.equal(resolveVcChatDeleteSeconds(undefined), 30);
  assert.equal(resolveVcChatDeleteSeconds(""), 30);
  assert.equal(resolveVcChatDeleteSeconds("0"), 0);
  assert.equal(resolveVcChatDeleteSeconds("60"), 60);
});

test("不正な自動削除の秒数を拒否する", () => {
  assert.throws(() => resolveVcChatDeleteSeconds("-1"), /0 以上/);
  assert.throws(() => resolveVcChatDeleteSeconds("1.5"), /0 以上/);
  assert.throws(() => resolveVcChatDeleteSeconds("86401"), /0 以上/);
  assert.throws(() => resolveVcChatDeleteSeconds("soon"), /0 以上/);
});

test.describe("VC付属チャットの自動削除", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  function deletable(voice: boolean, error?: unknown) {
    const message = chatMessage("vc-1", "こんにちは", { voice });
    let deleted = 0;
    Object.assign(message, {
      delete: async () => {
        deleted++;
        if (error) throw error;
      },
    });
    return { message, deleted: () => deleted };
  }

  test("指定した秒数が経ったら消す", () => {
    const { message, deleted } = deletable(true);

    scheduleVcChatDeletion(message, 30);
    mock.timers.tick(29_999);
    assert.equal(deleted(), 0);
    mock.timers.tick(1);
    assert.equal(deleted(), 1);
  });

  test("VC付属チャット以外は消さない", () => {
    const { message, deleted } = deletable(false);

    scheduleVcChatDeletion(message, 30);
    mock.timers.tick(30_000);

    assert.equal(deleted(), 0);
  });

  test("0秒なら消さない", () => {
    const { message, deleted } = deletable(true);

    scheduleVcChatDeletion(message, 0);
    mock.timers.tick(30_000);

    assert.equal(deleted(), 0);
  });

  test("先に消されていてもエラーを出さない", async () => {
    const errors: unknown[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const { message } = deletable(true, { code: RESTJSONErrorCodes.UnknownMessage });

    try {
      scheduleVcChatDeletion(message, 30);
      mock.timers.tick(30_000);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = originalConsoleError;
    }

    assert.deepEqual(errors, []);
  });
});
