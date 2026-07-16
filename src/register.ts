import { ChannelType, type Attachment, type Message } from "discord.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { soundPath, soundsDir } from "./sounds.js";
import { getSession, joinChannel } from "./voice.js";

const execFileAsync = promisify(execFile);

// ffmpeg-static は CJS (module.exports = path) のため createRequire で読む
const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string | null;
if (!ffmpegPath) throw new Error("ffmpeg-static: ffmpeg binary not found");
const ffmpeg: string = ffmpegPath;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_SOUND_SECONDS = 8;

const USAGE =
  `音声ファイルを添付してメンションすると、あなたの入室音として登録します（冒頭${MAX_SOUND_SECONDS}秒まで）。` +
  "「確認」を付けてメンションすると登録済みの入室音を返します。" +
  "ボイスチャンネルに入った状態でメンションすると、その通話に参加します。";

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.inGuild()) return;
  // 本文中の明示的なメンションだけに反応する
  // （mentions.users は Bot のメッセージへの「返信」でも true になり誤発動するため使わない）
  if (!new RegExp(`<@!?${message.client.user.id}>`).test(message.content)) return;

  const text = message.content.replace(/<@!?\d+>/g, "").trim();
  const attachment = message.attachments.first();
  if (attachment) {
    await registerSound(message, attachment);
  } else if (text === "確認") {
    await showSound(message);
  } else {
    await summonOrUsage(message);
  }
}

async function showSound(message: Message<true>): Promise<void> {
  const path = soundPath(message.author.id);
  if (!existsSync(path)) {
    await message.reply("入室音は未登録です。音声ファイルを添付してメンションすると登録できます。");
    return;
  }
  try {
    await message.reply({
      content: "登録されている入室音です。",
      files: [{ attachment: path, name: "join-sound.ogg" }],
    });
  } catch (err) {
    console.error("failed to send registered sound:", err);
    await message.reply("入室音の送信に失敗しました。").catch(() => {});
  }
}

const AUDIO_EXTENSION = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm|mka)$/i;

async function registerSound(
  message: Message<true>,
  attachment: Attachment,
): Promise<void> {
  // contentType を付けないクライアントがあるため拡張子でもフォールバック判定する
  const isAudio =
    attachment.contentType?.startsWith("audio/") ||
    AUDIO_EXTENSION.test(attachment.name);
  if (!isAudio) {
    await message.reply("添付ファイルを音声として認識できませんでした。mp3 / wav / ogg などの音声ファイルを添付してください。");
    return;
  }
  if (attachment.size > MAX_UPLOAD_BYTES) {
    await message.reply("ファイルが大きすぎます（25MBまで）。");
    return;
  }

  // 一意な一時パスで変換し、成功後に rename で置き換える
  // （登録先へ直接出力すると変換途中の失敗で既存の音声が壊れる。同時登録の競合も防ぐ）
  const tmpBase = join(soundsDir, `${message.author.id}.${randomUUID()}`);
  const tmpInput = `${tmpBase}.upload`;
  const tmpOutput = `${tmpBase}.tmp.ogg`;
  try {
    // 添付の CDN URL は期限付きなので受信直後にダウンロードする
    const res = await fetch(attachment.url, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    await writeFile(tmpInput, Buffer.from(await res.arrayBuffer()));

    // 冒頭 MAX_SOUND_SECONDS 秒でトリムし、パススルー再生できる 48kHz ogg/opus に統一変換
    // timeout: 破損ファイルで demuxer がハングしてもプロセスを残留させない
    await execFileAsync(
      ffmpeg,
      [
        "-y",
        "-i", tmpInput,
        "-t", String(MAX_SOUND_SECONDS),
        "-c:a", "libopus",
        "-b:a", "96k",
        "-ar", "48000",
        "-ac", "2",
        tmpOutput,
      ],
      { timeout: 30_000 },
    );
    await rename(tmpOutput, soundPath(message.author.id));

    await message.reply(`入室音を登録しました（冒頭${MAX_SOUND_SECONDS}秒まで）。`);
  } catch (err) {
    console.error("sound registration failed:", err);
    await message.reply("登録に失敗しました。別の音声ファイルで試してください。");
  } finally {
    await unlink(tmpInput).catch(() => {});
    await unlink(tmpOutput).catch(() => {});
  }
}

async function summonOrUsage(message: Message<true>): Promise<void> {
  const voiceChannel = message.member?.voice.channel;
  if (!voiceChannel) {
    await message.reply(USAGE);
    return;
  }

  const session = getSession(message.guildId);
  if (session) {
    // 参加済みの VC からのメンションは召喚が不要なので、無反応にせず使い方を返す
    await message.reply(
      session.channelId === voiceChannel.id ? USAGE : "いまは別の通話に参加中です。",
    );
    return;
  }

  // 20秒の接続タイムアウトを待たずに、参加できないチャンネルは先に弾く
  if (voiceChannel.type !== ChannelType.GuildVoice || !voiceChannel.joinable) {
    await message.reply("そのチャンネルには参加できません（権限または満員）。");
    return;
  }

  try {
    await joinChannel(voiceChannel);
  } catch (err) {
    console.error("failed to join via mention:", err);
    await message.reply("通話への参加に失敗しました。");
  }
}
