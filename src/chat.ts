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

/**
 * Bot が参加中の VC の付属チャットと、`/shaberu-ch add` で登録したチャンネルの
 * 発言を読み上げる。Bot が VC にいないサーバーの発言は読まない。
 */
export function readChatMessage(message: Message): void {
  if (message.author.bot || !message.inGuild()) return;
  const session = getSession(message.guildId);
  if (!session) return;
  if (
    message.channelId !== session.channelId &&
    !readChannels().includes(message.channelId)
  ) {
    return;
  }
  // Bot へのメンションはコマンドなので読まない
  if (new RegExp(`<@!?${message.client.user.id}>`).test(message.content)) return;

  // cleanContent はメンションを <@id> ではなく @表示名 に直したもの
  const text = toSpeechText(message.cleanContent);
  if (text === "") return; // 添付だけ・絵文字だけの発言
  enqueueText(session, applyYomi(text));
}

/**
 * VC 付属チャットの発言を、Bot 自身の返信も含めて一定時間後に消す。
 * 普通のテキストチャンネルの発言は、誰のものでも消さない。
 */
export function scheduleVcChatDeletion(
  message: Message,
  seconds = vcChatDeleteSeconds,
): void {
  if (seconds === 0) return;
  if (!message.inGuild() || !message.channel.isVoiceBased()) return;

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
