import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Message } from "discord.js";
import { handleMessage } from "../src/register.ts";
import { soundPath, soundsDir } from "../src/sounds.ts";

const botId = "1234567890";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static") as string;

function createMessage(
  content: string,
  userId: string,
  reply: (payload: unknown) => Promise<unknown>,
  attachment?: unknown,
): Message {
  return {
    author: { bot: false, id: userId },
    inGuild: () => true,
    content,
    client: { user: { id: botId } },
    attachments: { first: () => attachment },
    member: { voice: { channel: null } },
    guildId: "test-guild",
    reply,
  } as unknown as Message;
}

// ffmpeg の進捗出力（time=00:00:08.00）から実尺を読む。ffmpeg-static に ffprobe は同梱されない
async function readDurationSeconds(path: string): Promise<number> {
  const { stderr } = await execFileAsync(ffmpeg, ["-i", path, "-f", "null", "-"]);
  const last = [...stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)].at(-1);
  if (!last) throw new Error(`duration not found in ffmpeg output: ${stderr}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

// 指定秒数のサイン波を添付として登録させ、保存された入室音の実尺を返す
async function registerTone(userId: string, seconds: number): Promise<number> {
  const tonePath = join(soundsDir, `tone-${userId}.wav`);
  await execFileAsync(ffmpeg, [
    "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=440:duration=${seconds}`,
    tonePath,
  ]);

  const originalFetch = globalThis.fetch;
  const message = createMessage(`<@${botId}>`, userId, async () => {}, {
    name: "tone.wav",
    contentType: "audio/wav",
    size: 1024,
    url: "https://example.invalid/tone.wav",
  });
  globalThis.fetch = async () => new Response(await readFile(tonePath));
  try {
    await handleMessage(message);
    return await readDurationSeconds(soundPath(userId));
  } finally {
    globalThis.fetch = originalFetch;
    await unlink(tonePath).catch(() => {});
    await unlink(soundPath(userId)).catch(() => {});
  }
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

test("8秒以下の音声は末尾まで登録される", async () => {
  const duration = await registerTone("9876543212", 3);

  assert.ok(Math.abs(duration - 3) < 0.5, `expected about 3s, got ${duration}s`);
});

test("8秒を超える音声は冒頭8秒で切り詰められる", async () => {
  const duration = await registerTone("9876543213", 12);

  assert.ok(Math.abs(duration - 8) < 0.5, `expected about 8s, got ${duration}s`);
});

test("登録完了メッセージが最大8秒を示す", async () => {
  const replies: unknown[] = [];
  const message = createMessage(
    `<@${botId}>`,
    "9876543214",
    async (payload) => replies.push(payload),
    { name: "tone.wav", contentType: "audio/wav", size: 1024, url: "https://example.invalid/tone.wav" },
  );
  const tonePath = join(soundsDir, "tone-9876543214.wav");
  const originalFetch = globalThis.fetch;

  await execFileAsync(ffmpeg, [
    "-y",
    "-f", "lavfi",
    "-i", "sine=frequency=440:duration=1",
    tonePath,
  ]);
  globalThis.fetch = async () => new Response(await readFile(tonePath));
  try {
    await handleMessage(message);
  } finally {
    globalThis.fetch = originalFetch;
    await unlink(tonePath).catch(() => {});
    await unlink(soundPath("9876543214")).catch(() => {});
  }

  assert.deepEqual(replies, ["入室音を登録しました（冒頭8秒まで）。"]);
});
