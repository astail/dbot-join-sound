import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
import { DiscordAPIError, Events, RESTJSONErrorCodes } from "discord.js";
import {
  RateLimiter,
  ReactionTranslator,
  emojiLang,
  formatTranslation,
  guessLang,
  needsTranslation,
  resolveMaxChars,
  resolveRatePerMin,
  truncateChars,
} from "../src/reaction.ts";
import { TranslationIndex } from "../src/translations.ts";
import type { TranslateOptions, Translator } from "../src/translator.ts";

test("国旗の絵文字から訳先の言語を決める", () => {
  assert.equal(emojiLang({ name: "🇰🇷" }), "ko");
  assert.equal(emojiLang({ name: "🇯🇵" }), "ja");
  assert.equal(emojiLang({ name: "👍" }), null);
  assert.equal(emojiLang({ name: null }), null);
});

test("すでに訳先の言語なら訳さない", () => {
  assert.equal(guessLang("안녕하세요"), "ko");
  assert.equal(guessLang("こんにちは"), "ja");
  assert.equal(needsTranslation("안녕하세요", "ko"), false);
  assert.equal(needsTranslation("안녕하세요", "ja"), true);
  assert.equal(needsTranslation("こんにちは", "ja"), false);
  assert.equal(needsTranslation("こんにちは", "ko"), true);
  // 漢字だけでは決められないので訳す
  assert.equal(needsTranslation("了解", "ko"), true);
});

test("タイムスタンプ・スラッシュコマンドへのリンク・@everyone / @here だけの発言は訳さない", () => {
  assert.equal(needsTranslation("<t:1700000000:R>", "ja"), false);
  assert.equal(needsTranslation("<t:1700000000>", "ja"), false);
  assert.equal(needsTranslation("</yomi set:123456>", "ja"), false);
  assert.equal(needsTranslation("@everyone @here", "ja"), false);
  assert.equal(needsTranslation("<t:1700000000:R> 집합", "ja"), true);
});

test("URL・メンション・絵文字だけの発言は訳さない", () => {
  assert.equal(needsTranslation("https://example.com/abc", "ko"), false);
  assert.equal(needsTranslation("<@123456> <:pepe:98765>", "ja"), false);
  assert.equal(needsTranslation("😂😂", "ja"), false);
  assert.equal(needsTranslation("<@123456> 고마워", "ja"), true);
});

test("訳文に言語を添え、2000 文字に収める", () => {
  assert.equal(formatTranslation("ありがとう", "ja"), "ありがとう\n-# 🇯🇵 日本語訳");
  const long = formatTranslation("가".repeat(3000), "ko");
  assert.ok(long.length <= 2000);
  assert.ok(long.endsWith("…\n-# 🇰🇷 韓国語訳"));
  assert.equal(formatTranslation("x", "ja", true), "x\n-# 🇯🇵 日本語訳（先頭のみ）");
});

test("絵文字（サロゲートペア）の途中で切らない", () => {
  const out = formatTranslation("😀".repeat(1500), "ja");
  assert.ok(out.length <= 2000);
  assert.doesNotMatch(out, /[\ud800-\udbff](?![\udc00-\udfff])/);
  assert.deepEqual(truncateChars("😀😀😀", 2), { text: "😀😀", truncated: true });
  assert.deepEqual(truncateChars("abc", 5), { text: "abc", truncated: false });
});

test("REACTION_MAX_CHARS は 1〜4000 の整数、未指定なら 1000", () => {
  assert.equal(resolveMaxChars(undefined), 1000);
  assert.equal(resolveMaxChars(" "), 1000);
  assert.equal(resolveMaxChars("1"), 1);
  assert.equal(resolveMaxChars("4000"), 4000);
  for (const bad of ["0", "4001", "1.5", "abc", "-1"]) {
    assert.throws(() => resolveMaxChars(bad), /REACTION_MAX_CHARS/);
  }
});

test("REACTION_RATE_PER_MIN は 0 以上の整数、未指定なら 10", () => {
  assert.equal(resolveRatePerMin(undefined), 10);
  assert.equal(resolveRatePerMin(""), 10);
  assert.equal(resolveRatePerMin("0"), 0);
  assert.equal(resolveRatePerMin("30"), 30);
  for (const bad of ["-1", "1.5", "abc"]) {
    assert.throws(() => resolveRatePerMin(bad), /REACTION_RATE_PER_MIN/);
  }
});

test("回数制限は直近 1 分の回数を数え、時間が経てば戻る", () => {
  const limiter = new RateLimiter(2, 60_000);
  assert.equal(limiter.tryTake("u", 0), true);
  assert.equal(limiter.tryTake("u", 1), true);
  assert.equal(limiter.tryTake("u", 2), false);
  assert.equal(limiter.tryTake("other", 2), true);
  assert.equal(limiter.tryTake("u", 60_001), true);
  assert.equal(new RateLimiter(0, 1).tryTake("u"), true);
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

// 訳文を返すタイミングをテストから決められる翻訳エンジン
function fakeTranslator() {
  const calls: { text: string; options: TranslateOptions; resolve: (s: string) => void }[] = [];
  const translator: Translator = {
    name: "fake",
    translate: (text, options) =>
      new Promise((resolve) => calls.push({ text, options, resolve })),
  };
  return { translator, calls };
}

// Discord API の「もうない」エラー（10008: Unknown Message）
function unknownMessage(): DiscordAPIError {
  return new DiscordAPIError(
    { code: RESTJSONErrorCodes.UnknownMessage, message: "Unknown Message" },
    RESTJSONErrorCodes.UnknownMessage,
    404,
    "GET",
    "/channels/c1/messages/t1",
    {},
  );
}

function setup(content = "こんにちは", { ratePerMin = 10 } = {}) {
  const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let reactions: { count: number; emoji: { id: null; name: string } }[] = [];
  const rest = {
    get: mock.fn(async (): Promise<unknown> => ({ reactions })),
    delete: mock.fn(async (): Promise<unknown> => undefined),
    patch: mock.fn(async (_route: string, _options: unknown): Promise<unknown> => undefined),
  };
  Object.assign(client, { user: { id: "bot" }, rest });
  let replies = 0;
  const message = {
    id: "m1",
    channelId: "c1",
    partial: false,
    content,
    author: { id: "author" },
    messageSnapshots: { first: () => undefined },
    inGuild: () => true,
    guild: { members: { me: {} as object | null } },
    channel: {
      name: "general",
      isThread: () => false,
      permissionsFor: mock.fn(() => ({ has: () => true })),
      messages: { fetch: mock.fn(async (_id: string): Promise<unknown> => ({})) },
    },
    reply: mock.fn(async () => ({ id: `t${++replies}` })),
    fetch: async () => message,
  };
  const { translator, calls } = fakeTranslator();
  const index = new TranslationIndex(":memory:");
  new ReactionTranslator(client as never, translator, index, {
    maxChars: 1000,
    ratePerMin,
  }).register();
  const reaction = { emoji: { id: null, name: "🇰🇷" }, message };
  const user = { id: "u1", bot: false, partial: false };
  return {
    client,
    rest,
    message,
    calls,
    index,
    reaction,
    add: (by = user) => client.emit(Events.MessageReactionAdd, reaction, by),
    remove: () => client.emit(Events.MessageReactionRemove, reaction, user),
    setReactions: (n: number) => {
      reactions = n > 0 ? [{ count: n, emoji: { id: null, name: "🇰🇷" } }] : [];
    },
  };
}

test("国旗を付けると訳して返信し、対応を残す", async () => {
  const t = setup();
  t.add();
  await flush();
  assert.equal(t.calls.length, 1);
  // 元の言語は文字種で決めて渡す
  assert.deepEqual(t.calls[0]!.options, { from: "ja", to: "ko" });
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  assert.equal(t.message.reply.mock.callCount(), 1);
  assert.equal(
    (t.message.reply.mock.calls[0]!.arguments as unknown as [{ content: string }])[0].content,
    "안녕하세요\n-# 🇰🇷 韓国語訳",
  );
  assert.equal(t.index.get("m1", "ko")?.translationId, "t1");
});

test("翻訳中に外して付け直しても翻訳が投稿される", async () => {
  const t = setup();
  t.setReactions(1);
  t.add();
  await flush();
  assert.equal(t.calls.length, 1);
  t.setReactions(0);
  t.remove();
  await flush();
  t.setReactions(1);
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  assert.equal(t.message.reply.mock.callCount(), 1);
  assert.equal(t.rest.delete.mock.callCount(), 0);
  assert.equal(t.index.get("m1", "ko")?.translationId, "t1");
});

test("翻訳中にリアクションが全部外れたら投稿しない", async () => {
  const t = setup();
  t.add();
  await flush();
  t.setReactions(0);
  t.remove();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  assert.equal(t.message.reply.mock.callCount(), 0);
  assert.equal(t.index.get("m1", "ko"), undefined);
});

test("付け外しを繰り返してもキャッシュを使い、翻訳エンジンは 1 回だけ呼ぶ", async () => {
  const t = setup();
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  t.setReactions(0);
  t.remove();
  await flush();
  assert.equal(t.rest.delete.mock.callCount(), 1);
  assert.equal(t.index.get("m1", "ko"), undefined);
  t.add();
  await flush();
  assert.equal(t.calls.length, 1);
  assert.equal(t.message.reply.mock.callCount(), 2);
});

test("外れたかを確かめている間に付け直されたら翻訳を消さない", async () => {
  const t = setup();
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  let respond!: (value: unknown) => void;
  t.rest.get.mock.mockImplementationOnce(() => new Promise((resolve) => (respond = resolve)));
  t.remove();
  await flush();
  t.add(); // 応答が返る前に付け直す
  await flush();
  respond({ reactions: [] }); // 付け直す前の古い状態（0 件）
  await flush();
  assert.equal(t.rest.delete.mock.callCount(), 0);
  assert.equal(t.index.get("m1", "ko")?.translationId, "t1");
});

test("文字種で決められない言語（英語）は元の言語を翻訳エンジンに任せる", async () => {
  const t = setup("hello world");
  t.add();
  await flush();
  assert.equal(t.calls[0]!.options.from, null);
});

test("訳先の言語で書かれた発言には国旗を付けても訳さない", async () => {
  const t = setup("안녕하세요");
  t.add();
  await flush();
  assert.equal(t.calls.length, 0);
  assert.equal(t.message.reply.mock.callCount(), 0);
});

test("元の発言が消えたら翻訳も消し、消せなかったら対応を残してあとで消す", async () => {
  const t = setup();
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  t.rest.delete.mock.mockImplementationOnce(async () => {
    throw new Error("network");
  });
  const error = mock.method(console, "error", () => {});
  try {
    t.client.emit(Events.MessageDelete, t.message);
    await flush();
    assert.equal(t.index.get("m1", "ko")?.translationId, "t1");
    t.client.emit(Events.MessageDelete, t.message);
    await flush();
    assert.equal(t.index.get("m1", "ko"), undefined);
    assert.equal(t.rest.delete.mock.callCount(), 2);
  } finally {
    error.mock.restore();
  }
});

test("編集が重なっても最後の本文の訳文で直す", async () => {
  const t = setup();
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();

  t.message.content = "編集A";
  t.client.emit(Events.MessageUpdate, null, t.message);
  await flush();
  t.message.content = "編集B";
  t.client.emit(Events.MessageUpdate, null, t.message);
  await flush();
  t.calls[2]!.resolve("편집B");
  await flush();
  t.calls[1]!.resolve("편집A"); // 遅れて返った古い訳文
  await flush();

  assert.equal(t.rest.patch.mock.callCount(), 1);
  const [, options] = t.rest.patch.mock.calls[0]!.arguments as [string, { body: { content: string } }];
  assert.match(options.body.content, /편집B/);
  assert.equal(t.index.get("m1", "ko")?.sourceText, "編集B");
});

test("最初の翻訳を待つ間に編集されたら、訳し終えたあと最後の本文で直す", async () => {
  const t = setup();
  t.add();
  await flush();
  // 対応がまだないので、この編集は見送られる
  t.message.content = "さようなら";
  t.client.emit(Events.MessageUpdate, null, t.message);
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1]!.text, "さようなら");
  t.calls[1]!.resolve("안녕히 가세요");
  await flush();

  assert.equal(t.rest.patch.mock.callCount(), 1);
  const [, options] = t.rest.patch.mock.calls[0]!.arguments as [string, { body: { content: string } }];
  assert.match(options.body.content, /안녕히 가세요/);
  assert.equal(t.index.get("m1", "ko")?.sourceText, "さようなら");
});

test("外して翻訳を消している間に付け直されたら、訳し直して国旗だけが残らないようにする", async () => {
  const t = setup();
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  let finishDelete!: () => void;
  t.rest.delete.mock.mockImplementationOnce(
    () => new Promise((resolve) => (finishDelete = () => resolve(undefined))),
  );
  t.setReactions(0);
  t.remove();
  await flush();
  t.setReactions(1);
  t.add(); // 消し終わる前に付け直す（まだ翻訳があるので、この時点では何もしない）
  await flush();
  finishDelete();
  await flush();

  // 訳し直しはキャッシュから出るので、翻訳エンジンは 1 回だけ
  assert.equal(t.calls.length, 1);
  assert.equal(t.message.reply.mock.callCount(), 2);
  assert.equal(t.index.get("m1", "ko")?.translationId, "t2");
});

test("国旗が外れたかを確かめる API が失敗したら、翻訳は消さずにログに残す", async () => {
  const t = setup();
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  t.rest.get.mock.mockImplementationOnce(async () => {
    throw new Error("503 Service Unavailable");
  });
  const error = mock.method(console, "error", () => {});
  try {
    t.remove();
    await flush();
    assert.equal(error.mock.callCount(), 1);
  } finally {
    error.mock.restore();
  }
  assert.equal(t.rest.delete.mock.callCount(), 0);
  assert.equal(t.index.get("m1", "ko")?.translationId, "t1");
});

test("1 人分の回数を使い切ったら訳さない", async () => {
  const t = setup("こんにちは", { ratePerMin: 1 });
  const warn = mock.method(console, "warn", () => {});
  try {
    t.add();
    await flush();
    t.calls[0]!.resolve("안녕하세요");
    await flush();
    // 別の発言の扱いにするため、対応とキャッシュに当たらないよう ID を変える
    t.message.id = "m2";
    t.add();
    await flush();
  } finally {
    warn.mock.restore();
  }
  assert.equal(t.calls.length, 1);
  assert.equal(t.message.reply.mock.callCount(), 1);
});

test("全員の合計で 1 人分の 3 倍を超えたら訳さない", async () => {
  const t = setup("こんにちは", { ratePerMin: 1 });
  const warn = mock.method(console, "warn", () => {});
  try {
    for (let i = 1; i <= 4; i++) {
      t.message.id = `m${i}`;
      t.add({ id: `u${i}`, bot: false, partial: false });
      await flush();
      t.calls.at(-1)?.resolve("안녕하세요");
      await flush();
    }
  } finally {
    warn.mock.restore();
  }
  assert.equal(t.calls.length, 3);
  assert.equal(t.message.reply.mock.callCount(), 3);
});

test("返信する権限がなければ翻訳エンジンを呼ばない", async () => {
  const t = setup();
  t.message.channel.permissionsFor.mock.mockImplementation(() => ({ has: () => false }));
  const warn = mock.method(console, "warn", () => {});
  try {
    t.add();
    await flush();
  } finally {
    warn.mock.restore();
  }
  assert.equal(t.calls.length, 0);
});

test("Bot 自身のメンバー情報が取れなければ、権限がないものとして訳さない", async () => {
  const t = setup();
  t.message.guild.members.me = null;
  const warn = mock.method(console, "warn", () => {});
  try {
    t.add();
    await flush();
  } finally {
    warn.mock.restore();
  }
  assert.equal(t.calls.length, 0);
});

test("自分の投稿には国旗を付けても訳さない", async () => {
  const t = setup();
  t.message.author = { id: "bot" };
  t.add();
  await flush();
  assert.equal(t.calls.length, 0);
});

test("Bot が止まっている間に翻訳が消されていたら、付け直しで投稿し直す", async () => {
  const t = setup();
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  // 外したことは見えないまま、翻訳メッセージだけが消えている
  t.message.channel.messages.fetch.mock.mockImplementationOnce(async () => {
    throw unknownMessage();
  });
  t.add();
  await flush();
  assert.equal(t.message.reply.mock.callCount(), 2);
  assert.equal(t.index.get("m1", "ko")?.translationId, "t2");
});

test("翻訳が残っていれば、付け直しても投稿し直さない", async () => {
  const t = setup();
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  t.add({ id: "u2", bot: false, partial: false });
  await flush();
  assert.equal(t.message.reply.mock.callCount(), 1);
});

test("翻訳中に元の発言が消えたら投稿せず、付け直しても復活しない", async () => {
  const t = setup();
  t.add();
  await flush();
  t.client.emit(Events.MessageDelete, t.message);
  await flush();
  t.add(); // 消えた取り消しは、付け直しでは撤回しない
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  assert.equal(t.message.reply.mock.callCount(), 0);
  assert.equal(t.index.get("m1", "ko"), undefined);
});

test("返信を投稿している間に元の発言が消えたら、投稿した翻訳を消す", async () => {
  const t = setup();
  let finishReply!: () => void;
  t.message.reply.mock.mockImplementationOnce(
    () => new Promise((resolve) => (finishReply = () => resolve({ id: "t1" }))),
  );
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  t.client.emit(Events.MessageDelete, t.message);
  await flush();
  finishReply();
  await flush();
  assert.equal(t.rest.delete.mock.callCount(), 1);
  assert.equal(t.index.get("m1", "ko"), undefined);
});

for (const [name, emit] of [
  ["リアクションが全部消された（RemoveAll）", (t: ReturnType<typeof setup>) =>
    t.client.emit(Events.MessageReactionRemoveAll, t.message, new Map())],
  ["その絵文字が全部消された（RemoveEmoji）", (t: ReturnType<typeof setup>) =>
    t.client.emit(Events.MessageReactionRemoveEmoji, t.reaction)],
  ["まとめて削除された（BulkDelete）", (t: ReturnType<typeof setup>) =>
    t.client.emit(Events.MessageBulkDelete, new Map([[t.message.id, t.message]]), {})],
] as const) {
  test(`${name}ら翻訳も消す`, async () => {
    const t = setup();
    t.add();
    await flush();
    t.calls[0]!.resolve("안녕하세요");
    await flush();
    t.setReactions(0);
    emit(t);
    await flush();
    assert.equal(t.rest.delete.mock.callCount(), 1);
    assert.equal(t.index.get("m1", "ko"), undefined);
  });
}

test("編集で訳先の言語の文になったら翻訳を消す", async () => {
  const t = setup();
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  t.message.content = "안녕";
  t.client.emit(Events.MessageUpdate, null, t.message);
  await flush();
  assert.equal(t.calls.length, 1);
  assert.equal(t.rest.delete.mock.callCount(), 1);
  assert.equal(t.index.get("m1", "ko"), undefined);
});

test("直そうとした翻訳が消されていたら、対応を忘れる", async () => {
  const t = setup();
  t.add();
  await flush();
  t.calls[0]!.resolve("안녕하세요");
  await flush();
  t.rest.patch.mock.mockImplementationOnce(async () => {
    throw unknownMessage();
  });
  t.message.content = "さようなら";
  t.client.emit(Events.MessageUpdate, null, t.message);
  await flush();
  t.calls[1]!.resolve("안녕히 가세요");
  await flush();
  assert.equal(t.index.get("m1", "ko"), undefined);
});
