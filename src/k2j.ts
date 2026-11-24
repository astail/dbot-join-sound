import { EndBehaviorType, type VoiceConnection, type VoiceReceiver } from "@discordjs/voice";
import { MessageFlags, type Guild } from "discord.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import prism from "prism-media";
import { soundsDir } from "./sounds.js";
import { escapeDiscord, isUsableTranscript } from "./transcript.js";
import type { Translator } from "./translator.js";
import { pcm48kStereoToWav16kMono, pcmRms } from "./wav.js";

// この長さ黙ったら 1 つの発話の終わりとみなす
const SILENCE_MS = 800;
// これより長く話し続けたら、そこで一度区切って字幕にする
const MAX_UTTERANCE_MS = 30_000;
// これより短い発話と、これより小さい音量（s16le の RMS）の発話は物音として捨てる
const MIN_UTTERANCE_MS = 400;
const RMS_THRESHOLD = 250;
// 文字起こしを同時に投げる数。何人も同時に話したときに API へ一度に押し寄せないようにする
const STT_CONCURRENCY = 2;
// 同じ人の同じ文がこの間隔で続いたら捨てる。文字起こしが無音から同じ文を作り続けることがある
const DUPLICATE_MS = 5_000;
// 失敗の知らせでチャットを埋めないよう、サーバーごとにこの間隔に 1 回まで
const ERROR_NOTICE_INTERVAL_MS = 30_000;
const STT_TIMEOUT_MS = 60_000;
const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";

// 韓国語話者として指定した人のユーザー ID。Bot・サーバーをまたいで共通の 1 ファイルに持つ
const speakersPath = join(soundsDir, "k2j.json");

export function readSpeakers(): string[] {
  if (!existsSync(speakersPath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(speakersPath, "utf8"));
    // 手で編集して壊れていても Bot を止めない。誰の発話も訳さなくなるだけ
    if (!Array.isArray(parsed)) throw new Error("話者の一覧が JSON の配列ではありません");
    return parsed.filter((id): id is string => typeof id === "string");
  } catch (err) {
    console.error("failed to read k2j speakers:", err);
    return [];
  }
}

export async function writeSpeakers(ids: string[]): Promise<void> {
  // 一時ファイルへ書いてから rename で置き換え、途中で落ちても一覧が壊れないようにする
  const tmp = `${speakersPath}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(ids, null, 2));
  await rename(tmp, speakersPath);
}

async function transcribeWithOpenAI(wav: Buffer, apiKey: string, model: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("model", model);
  // 指定した人は韓国語で話す前提。自動判定にすると短い発話を別の言語と取り違える
  form.append("language", "ko");
  form.append("response_format", "json");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OpenAI STT ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

export type Stats = {
  processed: number;
  dropped: number;
  errors: number;
  lastLatencyMs: number | null;
};

// 字幕の出し先。通話（セッション）ごとに作る
export type SubtitleOutput = {
  post(userId: string, ko: string, ja: string): Promise<void>;
  notifyError(message: string): void;
};

/**
 * 発話の PCM を文字起こしし、捨てるものを捨ててから訳して字幕にする。
 * 同じ人の発話は話した順に字幕にし、文字起こしは全体で同時に投げる数を絞る。
 */
export class VoicePipeline {
  private readonly stats = new Map<string, Stats>();
  private readonly userChains = new Map<string, Promise<void>>();
  private readonly lastText = new Map<string, { text: string; at: number }>();
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly transcribe: (wav: Buffer) => Promise<string>,
    readonly translator: Translator,
  ) {}

  statsFor(guildId: string): Stats {
    let stats = this.stats.get(guildId);
    if (!stats) {
      stats = { processed: 0, dropped: 0, errors: 0, lastLatencyMs: null };
      this.stats.set(guildId, stats);
    }
    return stats;
  }

  // pcm は 48kHz ステレオの s16le
  handleUtterance(guildId: string, userId: string, pcm: Buffer, out: SubtitleOutput): void {
    const durationMs = (pcm.length / 4 / 48_000) * 1000;
    if (durationMs < MIN_UTTERANCE_MS || pcmRms(pcm) < RMS_THRESHOLD) {
      this.statsFor(guildId).dropped++;
      return;
    }
    const key = `${guildId}:${userId}`;
    const previous = this.userChains.get(key) ?? Promise.resolve();
    const next = previous.then(() =>
      this.process(guildId, userId, pcm, out).catch((err: unknown) => {
        this.statsFor(guildId).errors++;
        console.error("voice translation failed:", err);
        // API のエラー本文には伏せ字の API キーの一部が入ることがあるので、チャットには出さない
        out.notifyError(
          "字幕を作れませんでした。`docker compose logs bot` で原因を確認してください。",
        );
      }),
    );
    this.userChains.set(key, next);
  }

  private async process(
    guildId: string,
    userId: string,
    pcm: Buffer,
    out: SubtitleOutput,
  ): Promise<void> {
    const started = Date.now();
    const stats = this.statsFor(guildId);

    const ko = await this.withSttSlot(() => this.transcribe(pcm48kStereoToWav16kMono(pcm)));
    if (!isUsableTranscript(ko)) {
      stats.dropped++;
      return;
    }
    const last = this.lastText.get(userId);
    const now = Date.now();
    if (last && last.text === ko && now - last.at < DUPLICATE_MS) {
      stats.dropped++;
      return;
    }
    this.lastText.set(userId, { text: ko, at: now });

    const ja = (await this.translator.translate(ko, { from: "ko", to: "ja", speech: true })).trim();
    if (!ja) {
      stats.dropped++;
      return;
    }
    // 投稿の失敗（権限がないなど）は翻訳の失敗とは分けて、ログだけ残す
    await out.post(userId, ko, ja).catch((err: unknown) => {
      console.error("failed to post subtitle:", err);
    });
    stats.processed++;
    stats.lastLatencyMs = Date.now() - started;
  }

  private async withSttSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= STT_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/**
 * 指定した人の発話を 1 つ分受け取り、48kHz ステレオの PCM にして返す。
 * Discord は人ごとに別の Opus の流れを送ってくるので、話者を聞き分ける必要はない。
 */
function captureUtterance(receiver: VoiceReceiver, userId: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    let total = 0;
    const maxBytes = 48_000 * 4 * (MAX_UTTERANCE_MS / 1000);
    let done = false;

    const cleanup = () => {
      if (!opus.destroyed) opus.destroy();
      if (!decoder.destroyed) decoder.destroy();
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      // 途中まで受け取れていれば使う（暗号化のやり直しなどで、まれに途切れる）
      if (total > 0) resolve(Buffer.concat(chunks));
      else reject(err);
    };

    decoder.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) finish();
    });
    decoder.once("end", finish);
    decoder.once("error", fail);
    opus.once("error", fail);
    opus.pipe(decoder);
  });
}

let current: { pipeline: VoicePipeline; sttModel: string } | null = null;

/**
 * .env の設定で音声翻訳を有効にする。OpenAI の API キー（文字起こし）と翻訳エンジンの
 * 両方があるときだけ有効になり、有効なら true を返す。
 */
export function configureVoiceTranslation(
  translator: Translator | null,
  env = process.env,
): boolean {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!translator || !apiKey) {
    current = null;
    return false;
  }
  const sttModel = env.STT_MODEL?.trim() || DEFAULT_STT_MODEL;
  current = {
    pipeline: new VoicePipeline((wav) => transcribeWithOpenAI(wav, apiKey, sttModel), translator),
    sttModel,
  };
  return true;
}

// 音声翻訳が有効なら、その処理と文字起こしのモデル。無効なら null
export function voiceTranslation(): { pipeline: VoicePipeline; sttModel: string } | null {
  return current;
}

async function displayName(guild: Guild, userId: string): Promise<string> {
  const member =
    guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  return member?.displayName ?? "不明なユーザー";
}

/**
 * 参加した通話で、韓国語話者に指定した人の発話を拾って字幕にする。字幕は Bot がいる
 * VC の付属チャットに投稿する（Bot が別の VC へ移されたら移動先に投稿する）。
 */
export function listenForSpeech(
  connection: VoiceConnection,
  guild: Guild,
  session: { readonly channelId: string; readonly destroyed: boolean },
): void {
  const active = current;
  if (!active) return;
  const capturing = new Set<string>();
  let lastNoticeAt = 0;

  const sendableChannel = () => {
    const channel = guild.channels.cache.get(session.channelId);
    return channel?.isSendable() ? channel : null;
  };
  const out: SubtitleOutput = {
    async post(userId, ko, ja) {
      const channel = sendableChannel();
      if (session.destroyed || !channel) return;
      const name = await displayName(guild, userId);
      await channel.send({
        content: `**${escapeDiscord(name)}**：${escapeDiscord(ja)}\n-# ${escapeDiscord(ko)}`,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressNotifications,
      });
    },
    notifyError(message) {
      const now = Date.now();
      if (session.destroyed || now - lastNoticeAt < ERROR_NOTICE_INTERVAL_MS) return;
      lastNoticeAt = now;
      sendableChannel()
        ?.send({ content: `⚠ ${message}`, allowedMentions: { parse: [] } })
        .catch((err: unknown) => console.error("failed to post translation error:", err));
    },
  };

  const startCapture = (userId: string) => {
    if (session.destroyed || capturing.has(userId) || !readSpeakers().includes(userId)) return;
    capturing.add(userId);
    captureUtterance(connection.receiver, userId)
      .then((pcm) => {
        if (!session.destroyed && pcm.length > 0) {
          active.pipeline.handleUtterance(guild.id, userId, pcm, out);
        }
      })
      .catch((err: unknown) => console.error(`failed to capture speech of ${userId}:`, err))
      .finally(() => {
        capturing.delete(userId);
        // 上限の長さで区切ったあとも話し続けていれば、続きを拾う
        if (!session.destroyed && connection.receiver.speaking.users.has(userId)) {
          startCapture(userId);
        }
      });
  };
  connection.receiver.speaking.on("start", startCapture);
}
