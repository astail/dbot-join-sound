import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import test from "node:test";
import type { Message } from "discord.js";
import { handleMessage } from "../src/register.ts";
import { soundPath } from "../src/sounds.ts";

const botId = "1234567890";

function createMessage(
  content: string,
  userId: string,
  reply: (payload: unknown) => Promise<unknown>,
): Message {
  return {
    author: { bot: false, id: userId },
    inGuild: () => true,
    content,
    client: { user: { id: botId } },
    attachments: { first: () => undefined },
    member: { voice: { channel: null } },
    guildId: "test-guild",
    reply,
  } as unknown as Message;
}

test("確認だけを指定したメンションで登録音を確認する", async () => {
  const replies: unknown[] = [];
  const message = createMessage(
    `<@${botId}> 確認`,
    "9876543210",
    async (payload) => replies.push(payload),
  );

  await handleMessage(message);

  assert.deepEqual(replies, [
    "入室音は未登録です。音声ファイルを添付してメンションすると登録できます。",
  ]);
});

test("確認を含む召喚依頼を登録音確認として扱わない", async () => {
  const replies: unknown[] = [];
  const message = createMessage(
    `<@${botId}> 動作確認できて`,
    "9876543210",
    async (payload) => replies.push(payload),
  );

  await handleMessage(message);

  assert.equal(replies.length, 1);
  assert.match(String(replies[0]), /ボイスチャンネルに入った状態/);
});

test("登録音の添付送信に失敗したらテキストで通知する", async () => {
  const userId = "9876543211";
  const path = soundPath(userId);
  const replies: unknown[] = [];
  const message = createMessage(
    `<@!${botId}> 確認`,
    userId,
    async (payload) => {
      replies.push(payload);
      if (replies.length === 1) throw new Error("missing ATTACH_FILES");
    },
  );
  const originalConsoleError = console.error;

  await writeFile(path, "test");
  console.error = () => {};
  try {
    await handleMessage(message);
  } finally {
    console.error = originalConsoleError;
    await unlink(path).catch(() => {});
  }

  assert.equal(replies.length, 2);
  assert.equal(replies[1], "入室音の送信に失敗しました。");
});
