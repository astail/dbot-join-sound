import { RESTJSONErrorCodes, type Message } from "discord.js";
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { soundsDir } from "./sounds.js";
import { enqueueText, getSession } from "./voice.js";
import { applyYomi } from "./yomi.js";

// 長文を最後まで読むと入退室の音がその分待たされるので、ここで打ち切る
export const MAX_SPEECH_LENGTH = 100;

const DEFAULT_VC_CHAT_DELETE_SECONDS = 30;
// setTimeout の上限（約24.8日）より十分短く、分と秒の取り違えのような
// 明らかな設定ミスだけを弾くための上限
const MAX_VC_CHAT_DELETE_SECONDS = 86_400;

export function resolveVcChatDeleteSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_VC_CHAT_DELETE_SECONDS;
  }

  const seconds = Number(value);
  if (
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    seconds > MAX_VC_CHAT_DELETE_SECONDS
  ) {
    throw new Error(
      `VC_CHAT_DELETE_SECONDS は 0 以上 ${MAX_VC_CHAT_DELETE_SECONDS} 以下の整数で指定してください`,
    );
  }
  return seconds;
}

const vcChatDeleteSeconds = resolveVcChatDeleteSeconds(
  process.env.VC_CHAT_DELETE_SECONDS,
);

// VC 付属チャットの読み上げを止めても、/shaberu-ch で指定したチャンネルは読む
export function resolveVcChatReadEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;

  const enabled = value.trim().toLowerCase();
  if (enabled === "true") return true;
  if (enabled === "false") return false;
  throw new Error("VC_CHAT_READ_ENABLED は true または false で指定してください");
}

const vcChatReadEnabled = resolveVcChatReadEnabled(process.env.VC_CHAT_READ_ENABLED);

// VC 付属チャット以外で読み上げるチャンネルの ID。サーバーをまたいで共通の
// 1 ファイルに持つ（チャンネル ID は Discord 全体で一意なので混ざらない）
const channelsPath = join(soundsDir, "shaberu-ch.json");

export function readChannels(): string[] {
  if (!existsSync(channelsPath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(channelsPath, "utf8"));
    // 手で編集して壊れていても Bot を止めない。VC 付属チャットだけ読む状態に戻るだけ
    if (!Array.isArray(parsed)) {
      throw new Error("読み上げチャンネルの一覧が JSON の配列ではありません");
    }
    return parsed.filter((id): id is string => typeof id === "string");
  } catch (err) {
    console.error("failed to read read channels:", err);
    return [];
  }
}

export async function writeChannels(channelIds: string[]): Promise<void> {
  // 一時ファイルへ書いてから rename で置き換える（辞書の保存と同じ理由）
  const tmp = `${channelsPath}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(channelIds, null, 2));
  await rename(tmp, channelsPath);
}

/** チャットの本文を、読み上げてそれらしく聞こえる文に整える。 */
export function toSpeechText(content: string): string {
  const text = content
    // 伏せ字を読み上げるとネタバレになる
    .replace(/\|\|[\s\S]*?\|\|/g, "伏せ字")
    .replace(/https?:\/\/\S+/g, "URL")
    // カスタム絵文字は <:name:id> の形で、名前も読み物として意味をなさないことが多い
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_SPEECH_LENGTH
    ? `${text.slice(0, MAX_SPEECH_LENGTH)} 以下略`
    : text;
}

// contentType を付けないクライアントがあるため拡張子でもフォールバック判定する
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|heic)$/i;
const VIDEO_EXTENSION = /\.(mp4|mov|webm|mkv|avi)$/i;

/** 画像・動画の添付を知らせる文。どちらもなければ空文字。 */
export function toAttachmentNotice(
  attachments: { contentType: string | null; name: string }[],
): string {
  const hasImage = attachments.some(
    (a) => a.contentType?.startsWith("image/") || IMAGE_EXTENSION.test(a.name),
  );
  const hasVideo = attachments.some(
    (a) => a.contentType?.startsWith("video/") || VIDEO_EXTENSION.test(a.name),
  );
  if (hasImage && hasVideo) return "画像と動画がアップロードされました";
  if (hasImage) return "画像がアップロードされました";
  if (hasVideo) return "動画がアップロードされました";
  return "";
}

/**
 * Bot が参加中の VC の付属チャットと、`/shaberu-ch add` で登録したチャンネルの
 * 発言を読み上げる。Bot が VC にいないサーバーの発言は読まない。
 */
export function readChatMessage(
  message: Message,
  readVcChat = vcChatReadEnabled,
): void {
  if (message.author.bot || !message.inGuild()) return;
  const session = getSession(message.guildId);
  if (!session) return;
  const isVcChat = readVcChat && message.channelId === session.channelId;
  if (!isVcChat && !readChannels().includes(message.channelId)) return;
  // Bot へのメンションはコマンドなので読まない
  if (new RegExp(`<@!?${message.client.user.id}>`).test(message.content)) return;

  // cleanContent はメンションを <@id> ではなく @表示名 に直したもの
  const text = [
    toSpeechText(message.cleanContent),
    toAttachmentNotice([...message.attachments.values()]),
  ]
    .filter((part) => part !== "")
    .join("、");
  if (text === "") return; // 絵文字だけ・画像や動画以外の添付だけの発言
  enqueueText(session, applyYomi(text));
}

/**
 * Bot が参加中の VC の付属チャットの発言を、Bot 自身の返信も含めて一定時間後に消す。
 * 普通のテキストチャンネルと、Bot のいない VC の付属チャットは消さない。
 * 投稿の時点で参加中なら、消す前に Bot が抜けても予定どおり消す。
 */
export function scheduleVcChatDeletion(
  message: Message,
  seconds = vcChatDeleteSeconds,
): void {
  if (seconds === 0) return;
  if (!message.inGuild()) return;
  // セッションのチャンネルは常に VC なので、一致すれば VC 付属チャットに限られる
  if (getSession(message.guildId)?.channelId !== message.channelId) return;

  setTimeout(() => {
    message.delete().catch((err: unknown) => {
      // 待つ間に本人が消していた場合は目的を果たしているので黙る
      if ((err as { code?: unknown }).code === RESTJSONErrorCodes.UnknownMessage) {
        return;
      }
      console.error("failed to delete vc chat message:", err);
    });
  }, seconds * 1000);
}
