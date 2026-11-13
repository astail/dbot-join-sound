import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach, beforeEach, mock } from "node:test";
import {
  MessageFlags,
  RESTJSONErrorCodes,
  type Interaction,
  type Message,
} from "discord.js";
import { soundsDir } from "../src/sounds.ts";

// 読み上げの順番は queue.test.ts で確かめているので、ここでは何をキューに積むかだけ見る
let session: { channelId: string } | undefined;
const enqueued: string[] = [];
mock.module("../src/voice.ts", {
  namedExports: {
    getSession: () => session,
    hasSessionInGuild: () => session !== undefined,
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
  resolveVcChatReadEnabled,
  scheduleVcChatDeletion,
  toAttachmentNotice,
  toSpeechText,
  writeChannels,
} = await import("../src/chat.ts");
const { handleInteraction } = await import("../src/commands.ts");

// 一覧は sounds/shaberu-ch.json ひとつを共有するため、ファイルを触るテストは
// この 1 ファイルにまとめて、テストごとに消す（node:test はファイル内では直列に走る）
const channelsPath = join(soundsDir, "shaberu-ch.json");

const botId = "1234567890";

beforeEach(() => {
  session = { channelId: "vc-1" };
  enqueued.length = 0;
});

afterEach(async () => {
  await unlink(channelsPath).catch(() => {});
});

type TestAttachment = { contentType: string | null; name: string };

function chatMessage(
  channelId: string,
  content: string,
  { bot = false, attachments = [] as TestAttachment[] } = {},
): Message {
  return {
    author: { bot },
    inGuild: () => true,
    guildId: "test-guild",
    channelId,
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
    content,
    client: { user: { id: botId } },
    // 本文中でメンションされたユーザー。Bot かどうかだけ見る
    mentions: {
      users: new Map([
        ["2222222222", { bot: true }],
        ["3333333333", { bot: false }],
      ]),
    },
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
    commandName: "shaberu-ch",
    guildId: "test-guild",
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

test("メンションは読まない", () => {
  assert.equal(toSpeechText("<@3333333333> おはよう"), "おはよう");
  assert.equal(toSpeechText("<@!3333333333>と<@&4444444444>"), "と");
  assert.equal(toSpeechText("<#5555555555> 見て"), "見て");
  assert.equal(toSpeechText("@everyone 集合 @here"), "集合");
  assert.equal(toSpeechText("<@3333333333>"), "");
});

test("スラッシュコマンドのメンションはコマンド名だけ読む", () => {
  assert.equal(toSpeechText("</yomi add:123456789>"), "/yomi add");
});

test("メンションだけの発言は読み上げない", () => {
  readChatMessage(chatMessage("vc-1", "<@3333333333>"));
  assert.deepEqual(enqueued, []);
});

test("読み方は打ち切る前に当てる", () => {
  // 「mame」を「まめ」と読む辞書（上のモック）。元の文は上限を超えるが、読み方を当てると収まる。
  // 先に打ち切ると「mame」が途中で切れて読み方が当たらない
  readChatMessage(chatMessage("vc-1", `${"あ".repeat(MAX_SPEECH_LENGTH - 2)}mame`));
  assert.deepEqual(enqueued, [`${"あ".repeat(MAX_SPEECH_LENGTH - 2)}まめ`]);
});

test("絵文字は読まない", () => {
  assert.equal(toSpeechText("おはよう😀"), "おはよう");
  assert.equal(toSpeechText("👍🏻 了解"), "了解");
  assert.equal(toSpeechText("👨‍👩‍👧 家族 🇯🇵"), "家族");
  assert.equal(toSpeechText("❤️"), "");
});

test("絵文字だけの発言は読み上げない", () => {
  readChatMessage(chatMessage("vc-1", "🎉🎉<:party:123456789>"));
  assert.deepEqual(enqueued, []);
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

test("画像や動画の添付を知らせる", () => {
  const image = { contentType: "image/png", name: "a.png" };
  const video = { contentType: "video/mp4", name: "b.mp4" };

  assert.equal(toAttachmentNotice([image, image]), "画像がアップロードされました");
  assert.equal(toAttachmentNotice([video]), "動画がアップロードされました");
  assert.equal(toAttachmentNotice([image, video]), "画像と動画がアップロードされました");
});

test("contentTypeがなくても拡張子で画像や動画と判定する", () => {
  assert.equal(
    toAttachmentNotice([{ contentType: null, name: "photo.JPG" }]),
    "画像がアップロードされました",
  );
  assert.equal(
    toAttachmentNotice([{ contentType: null, name: "clip.mov" }]),
    "動画がアップロードされました",
  );
});

test("画像や動画以外の添付は知らせない", () => {
  assert.equal(toAttachmentNotice([{ contentType: "application/pdf", name: "a.pdf" }]), "");
  assert.equal(toAttachmentNotice([]), "");
});

test("画像だけの発言は添付を読み上げる", () => {
  const attachments = [{ contentType: "image/png", name: "a.png" }];

  readChatMessage(chatMessage("vc-1", "", { attachments }));

  assert.deepEqual(enqueued, ["画像がアップロードされました"]);
});

test("本文と画像がある発言は本文に続けて添付を読み上げる", () => {
  const attachments = [{ contentType: "video/mp4", name: "a.mp4" }];

  readChatMessage(chatMessage("vc-1", "見て", { attachments }));

  assert.deepEqual(enqueued, ["見て、動画がアップロードされました"]);
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

test("別のBotへのコマンドは読まず、人へのメンションは読む", () => {
  readChatMessage(chatMessage("vc-1", "<@2222222222> join"));
  readChatMessage(chatMessage("vc-1", "<@3333333333> こんにちは"));

  // 人へのメンションの発言は読むが、メンションそのものは読まない
  assert.deepEqual(enqueued, ["こんにちは"]);
});

test("VC付属チャットの読み上げを止めても指定チャンネルは読む", async () => {
  await writeChannels(["text-1"]);

  readChatMessage(chatMessage("vc-1", "VC付属チャット"), false);
  readChatMessage(chatMessage("text-1", "指定チャンネル"), false);

  assert.deepEqual(enqueued, ["指定チャンネル"]);
});

test("VC付属チャットの読み上げの有効・無効を切り替えられる", () => {
  assert.equal(resolveVcChatReadEnabled(undefined), true);
  assert.equal(resolveVcChatReadEnabled(""), true);
  assert.equal(resolveVcChatReadEnabled("FALSE"), false);
  assert.throws(() => resolveVcChatReadEnabled("no"), /true または false/);
});

test("画像や動画以外の添付だけの発言は読まない", () => {
  const attachments = [{ contentType: "application/pdf", name: "a.pdf" }];

  readChatMessage(chatMessage("vc-1", "", { attachments }));

  assert.deepEqual(enqueued, []);
});

test("Botが通話にいないときはスラッシュコマンドを実行せず本人にだけ断る", async () => {
  session = undefined;
  const replies: unknown[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    commandName: "shaberu-ch",
    guildId: "test-guild",
    channelId: "text-1",
    options: { getSubcommand: () => "add" },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
  } as unknown as Interaction;

  await handleInteraction(interaction);

  assert.deepEqual(replies, [
    {
      content: "Bot が通話に参加していないときは使えません。",
      flags: MessageFlags.Ephemeral,
    },
  ]);
  assert.equal(existsSync(channelsPath), false, "登録しない");
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

  function deletable(channelId: string, { bot = false, error = undefined as unknown } = {}) {
    const message = chatMessage(channelId, "こんにちは", { bot });
    let deleted = 0;
    Object.assign(message, {
      delete: async () => {
        deleted++;
        if (error) throw error;
      },
    });
    return { message, deleted: () => deleted };
  }

  test("Botが参加中のVC付属チャットは指定した秒数が経ったら消す", () => {
    const { message, deleted } = deletable("vc-1");

    scheduleVcChatDeletion(message, 30);
    mock.timers.tick(29_999);
    assert.equal(deleted(), 0);
    mock.timers.tick(1);
    assert.equal(deleted(), 1);
  });

  test("Botの発言も消す", () => {
    const { message, deleted } = deletable("vc-1", { bot: true });

    scheduleVcChatDeletion(message, 30);
    mock.timers.tick(30_000);

    assert.equal(deleted(), 1);
  });

  test("投稿のあとBotが抜けても予定どおり消す", () => {
    const { message, deleted } = deletable("vc-1");

    scheduleVcChatDeletion(message, 30);
    mock.timers.tick(10_000);
    session = undefined;
    mock.timers.tick(20_000);

    assert.equal(deleted(), 1);
  });

  test("Botが参加していないVCの付属チャットは消さない", () => {
    const { message, deleted } = deletable("vc-2");

    scheduleVcChatDeletion(message, 30);
    mock.timers.tick(30_000);

    assert.equal(deleted(), 0);
  });

  test("Botが通話にいなければ消さない", () => {
    session = undefined;
    const { message, deleted } = deletable("vc-1");

    scheduleVcChatDeletion(message, 30);
    mock.timers.tick(30_000);

    assert.equal(deleted(), 0);
  });

  test("指定チャンネルの発言はBotのものも含めて消さない", async () => {
    await writeChannels(["text-1"]);
    const human = deletable("text-1");
    const bot = deletable("text-1", { bot: true });

    scheduleVcChatDeletion(human.message, 30);
    scheduleVcChatDeletion(bot.message, 30);
    mock.timers.tick(30_000);

    assert.equal(human.deleted(), 0);
    assert.equal(bot.deleted(), 0);
  });

  test("0秒なら消さない", () => {
    const { message, deleted } = deletable("vc-1");

    scheduleVcChatDeletion(message, 0);
    mock.timers.tick(30_000);

    assert.equal(deleted(), 0);
  });

  test("先に消されていてもエラーを出さない", async () => {
    const errors: unknown[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const { message } = deletable("vc-1", {
      error: { code: RESTJSONErrorCodes.UnknownMessage },
    });

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

test("読み上げ用に置き換える決まった言い回しは、すべて保存の対象になっている", async () => {
  const { FIXED_PHRASES } = await import("../src/voicevox.ts");
  const outputs = [
    toSpeechText("||ネタバレ||"),
    toSpeechText("https://example.com"),
    toSpeechText("あ".repeat(MAX_SPEECH_LENGTH + 1)).split(" ").at(-1)!,
    toAttachmentNotice([{ contentType: "image/png", name: "a.png" }]),
    toAttachmentNotice([{ contentType: "video/mp4", name: "a.mp4" }]),
    toAttachmentNotice([
      { contentType: "image/png", name: "a.png" },
      { contentType: "video/mp4", name: "a.mp4" },
    ]),
  ];
  assert.deepEqual(outputs.sort(), [...FIXED_PHRASES].sort());
});
