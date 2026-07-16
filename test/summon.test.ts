import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";
import { ChannelType, type Message } from "discord.js";

// 実際のセッションは Discord への音声接続が確立して初めて作られ、テストからは
// 20 秒の接続タイムアウトを待つしかないため、voice モジュールごと差し替える
let session: { channelId: string } | undefined;
const joinedChannelIds: string[] = [];
const leftGuildIds: string[] = [];
let joinError: Error | undefined;
// exports は Node 24 で namedExports を置き換えた新オプションだが、engines と
// Dockerfile が対象とする Node 22 では無視され、名前付き export が消えてしまう。
// 非推奨警告は出るが、22 と 24 の両方で動く namedExports を使う
mock.module("../src/voice.ts", {
  namedExports: {
    getSession: () => session,
    joinChannel: async (channel: { id: string }) => {
      if (joinError) throw joinError;
      joinedChannelIds.push(channel.id);
    },
    leaveChannel: (guildId: string) => {
      if (!session) return false;
      leftGuildIds.push(guildId);
      session = undefined;
      return true;
    },
  },
});
const { handleMessage } = await import("../src/register.ts");

const botId = "1234567890";
const botName = "test-bot";

function createMention(
  command: string,
  voiceChannelId: string | null,
  reply: (payload: unknown) => Promise<unknown>,
  joinable = true,
): Message {
  return {
    author: { bot: false, id: "9876543210" },
    inGuild: () => true,
    content: `<@${botId}> ${command}`,
    client: { user: { id: botId, username: botName } },
    attachments: { first: () => undefined },
    member: {
      voice: {
        channel:
          voiceChannelId === null
            ? null
            : { id: voiceChannelId, type: ChannelType.GuildVoice, joinable },
      },
    },
    guildId: "test-guild",
    reply,
  } as unknown as Message;
}

beforeEach(() => {
  session = undefined;
  joinedChannelIds.length = 0;
  leftGuildIds.length = 0;
  joinError = undefined;
});

test("VC参加中の引数なしメンションには参加せず使い方を返信する", async () => {
  session = { channelId: "vc-2" };
  const replies: unknown[] = [];

  await handleMessage(createMention("", "vc-1", async (payload) => replies.push(payload)));

  assert.equal(replies.length, 1);
  assert.match(String(replies[0]), /^使い方:/);
  assert.match(String(replies[0]), /@test-bot \+ 音声ファイル  自分の入室音を登録/);
  assert.match(String(replies[0]), /@test-bot join +自分がいる通話に参加/);
  assert.match(String(replies[0]), /@test-bot leave +参加中の通話から退出/);
  assert.doesNotMatch(String(replies[0]), /@Bot/);
  assert.deepEqual(joinedChannelIds, []);
});

test("VC未参加の引数なしメンションにも使い方を返信する", async () => {
  const replies: unknown[] = [];

  await handleMessage(createMention("", null, async (payload) => replies.push(payload)));

  assert.equal(replies.length, 1);
  assert.match(String(replies[0]), /^使い方:/);
  assert.deepEqual(joinedChannelIds, []);
});

test("joinならメンション元のVCに参加する", async () => {
  const replies: unknown[] = [];

  await handleMessage(createMention("join", "vc-1", async (payload) => replies.push(payload)));

  assert.deepEqual(joinedChannelIds, ["vc-1"]);
  assert.deepEqual(replies, []);
});

test("参加中の同じVCからjoinされたら参加済みメッセージを返信する", async () => {
  session = { channelId: "vc-1" };
  const replies: unknown[] = [];

  await handleMessage(createMention("join", "vc-1", async (payload) => replies.push(payload)));

  assert.deepEqual(replies, ["すでにこの通話に参加しています。"]);
  assert.deepEqual(joinedChannelIds, []);
});

test("参加中に別のVCからjoinされたら参加中メッセージを返信する", async () => {
  session = { channelId: "vc-1" };
  const replies: unknown[] = [];

  await handleMessage(createMention("join", "vc-2", async (payload) => replies.push(payload)));

  assert.deepEqual(replies, ["いまは別の通話に参加中です。"]);
  assert.deepEqual(joinedChannelIds, []);
});

test("VCに入っていないjoinには使い方を返信する", async () => {
  const replies: unknown[] = [];

  await handleMessage(createMention("join", null, async (payload) => replies.push(payload)));

  assert.equal(replies.length, 1);
  assert.match(String(replies[0]), /^使い方:/);
  assert.deepEqual(joinedChannelIds, []);
});

test("参加できないVCへのjoinには理由を返信する", async () => {
  const replies: unknown[] = [];

  await handleMessage(
    createMention("join", "vc-1", async (payload) => replies.push(payload), false),
  );

  assert.deepEqual(replies, ["そのチャンネルには参加できません（権限または満員）。"]);
  assert.deepEqual(joinedChannelIds, []);
});

test("通話への接続に失敗したjoinには失敗を返信する", async () => {
  joinError = new Error("connection failed");
  const replies: unknown[] = [];

  await handleMessage(createMention("join", "vc-1", async (payload) => replies.push(payload)));

  assert.deepEqual(replies, ["通話への参加に失敗しました。"]);
  assert.deepEqual(joinedChannelIds, []);
});

test("leaveなら参加中の通話から退出する", async () => {
  session = { channelId: "vc-1" };
  const replies: unknown[] = [];

  await handleMessage(createMention("leave", null, async (payload) => replies.push(payload)));

  assert.deepEqual(leftGuildIds, ["test-guild"]);
  assert.deepEqual(replies, ["通話から退出しました。"]);
});

test("未参加のleaveにはその旨を返信する", async () => {
  const replies: unknown[] = [];

  await handleMessage(createMention("leave", null, async (payload) => replies.push(payload)));

  assert.deepEqual(leftGuildIds, []);
  assert.deepEqual(replies, ["通話に参加していません。"]);
});
