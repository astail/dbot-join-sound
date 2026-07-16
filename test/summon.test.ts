import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";
import { ChannelType, type Message } from "discord.js";

// 実際のセッションは Discord への音声接続が確立して初めて作られ、テストからは
// 20 秒の接続タイムアウトを待つしかないため、voice モジュールごと差し替える
let session: { channelId: string } | undefined;
const joinedChannelIds: string[] = [];
// exports は Node 24 で namedExports を置き換えた新オプションだが、engines と
// Dockerfile が対象とする Node 22 では無視され、名前付き export が消えてしまう。
// 非推奨警告は出るが、22 と 24 の両方で動く namedExports を使う
mock.module("../src/voice.ts", {
  namedExports: {
    getSession: () => session,
    joinChannel: async (channel: { id: string }) => {
      joinedChannelIds.push(channel.id);
    },
  },
});
const { handleMessage } = await import("../src/register.ts");

const botId = "1234567890";

function createMention(
  voiceChannelId: string | null,
  reply: (payload: unknown) => Promise<unknown>,
): Message {
  return {
    author: { bot: false, id: "9876543210" },
    inGuild: () => true,
    content: `<@${botId}>`,
    client: { user: { id: botId } },
    attachments: { first: () => undefined },
    member: {
      voice: {
        channel:
          voiceChannelId === null
            ? null
            : { id: voiceChannelId, type: ChannelType.GuildVoice, joinable: true },
      },
    },
    guildId: "test-guild",
    reply,
  } as unknown as Message;
}

beforeEach(() => {
  session = undefined;
  joinedChannelIds.length = 0;
});

test("参加中の同じVCからのメンションには使い方を返信する", async () => {
  session = { channelId: "vc-1" };
  const replies: unknown[] = [];

  await handleMessage(createMention("vc-1", async (payload) => replies.push(payload)));

  assert.equal(replies.length, 1);
  assert.match(String(replies[0]), /^使い方:/);
  assert.match(String(replies[0]), /@Bot 音声ファイル    自分の入室音を登録/);
  assert.deepEqual(joinedChannelIds, []);
});

test("未参加ならメンション元のVCに参加する", async () => {
  const replies: unknown[] = [];

  await handleMessage(createMention("vc-1", async (payload) => replies.push(payload)));

  assert.deepEqual(joinedChannelIds, ["vc-1"]);
  assert.deepEqual(replies, []);
});

test("参加中に別のVCからメンションされたら参加中メッセージを返信する", async () => {
  session = { channelId: "vc-1" };
  const replies: unknown[] = [];

  await handleMessage(createMention("vc-2", async (payload) => replies.push(payload)));

  assert.deepEqual(replies, ["いまは別の通話に参加中です。"]);
  assert.deepEqual(joinedChannelIds, []);
});

test("VCに入っていないメンションには使い方を返信する", async () => {
  session = { channelId: "vc-1" };
  const replies: unknown[] = [];

  await handleMessage(createMention(null, async (payload) => replies.push(payload)));

  assert.equal(replies.length, 1);
  assert.match(String(replies[0]), /^使い方:/);
  assert.deepEqual(joinedChannelIds, []);
});
