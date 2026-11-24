import { EndBehaviorType, type VoiceConnection, type VoiceReceiver } from "@discordjs/voice";
import { MessageFlags, type Guild } from "discord.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import prism from "prism-media";
import { soundsDir } from "./sounds.js";
import { escapeDiscord, isUsableTranscript } from "./transcript.js";
import { otherLang, type Lang, type Translator } from "./translator.js";
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
// 失敗の知らせや受信の失敗のログで埋め尽くさないよう、通話（Bot と通話の組）ごと・
// 人ごとにこの間隔に 1 回まで
const ERROR_NOTICE_INTERVAL_MS = 30_000;
const STT_TIMEOUT_MS = 60_000;
const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";

// 話者に指定した人のユーザー ID → その人が話す言語（1 人に 1 言語）。
// Bot・サーバーをまたいで共通の 1 ファイルに持つ
export type Speakers = Record<string, Lang>;

const speakersPath = join(soundsDir, "k2j.json");

// 誰かが話し出すたびに引くので、ファイルは起動後に 1 回だけ読んでメモリに持つ。
// 書き換えは /k2j add と remove（writeSpeakers）だけ。手で編集したら再起動で読み直す
let speakersCache: Speakers | undefined;

export function readSpeakers(): Speakers {
  speakersCache ??= loadSpeakers();
  // 呼び出し側が書き換えてから writeSpeakers に渡すので、持っている一覧そのものは渡さない
  return { ...speakersCache };
}

function loadSpeakers(): Speakers {
  if (!existsSync(speakersPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(speakersPath, "utf8"));
    // 手で編集して壊れていても Bot を止めない。誰の発話も訳さなくなるだけ（ログは起動後に 1 回）
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("話者の一覧が JSON のオブジェクトではありません");
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(([, lang]) => lang === "ko" || lang === "ja"),
    ) as Speakers;
  } catch (err) {
    console.error("failed to read k2j speakers:", err);
    return {};
  }
}

export async function writeSpeakers(speakers: Speakers): Promise<void> {
  // 一時ファイルへ書いてから rename で置き換え、途中で落ちても一覧が壊れないようにする
  const tmp = `${speakersPath}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(speakers, null, 2));
  await rename(tmp, speakersPath);
  speakersCache = { ...speakers };
}

async function transcribeWithOpenAI(
  wav: Buffer,
  language: Lang,
  apiKey: string,
  model: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("model", model);
  // 話者に指定した言語で聞き取る。自動判定にすると短い発話を別の言語と取り違える
  form.append("language", language);
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

// 字幕の出し先。通話（セッション）ごとに作る。original は文字起こしした文、to は訳文の言語。
// post は実際に投稿できたら true（Bot が抜けた・送れるチャンネルがないときは false）
export type SubtitleOutput = {
  post(userId: string, original: string, translated: string, to: Lang): Promise<boolean>;
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
    private readonly transcribe: (wav: Buffer, language: Lang) => Promise<string>,
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

  // pcm は 48kHz ステレオの s16le、lang は話者の言語
  handleUtterance(
    guildId: string,
    userId: string,
    pcm: Buffer,
    lang: Lang,
    out: SubtitleOutput,
  ): void {
    const durationMs = (pcm.length / 4 / 48_000) * 1000;
    if (durationMs < MIN_UTTERANCE_MS || pcmRms(pcm) < RMS_THRESHOLD) {
      this.statsFor(guildId).dropped++;
      return;
    }
    // 遅延は受け取った時点から測る（同じ人の前の発話を待つ時間も含める）
    const receivedAt = Date.now();
    const key = `${guildId}:${userId}`;
    const previous = this.userChains.get(key) ?? Promise.resolve();
    const next = previous.then(() =>
      this.process(guildId, userId, pcm, lang, out, receivedAt).catch((err: unknown) => {
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
    from: Lang,
    out: SubtitleOutput,
    receivedAt: number,
  ): Promise<void> {
    const stats = this.statsFor(guildId);

    const original = await this.withSttSlot(() =>
      this.transcribe(pcm48kStereoToWav16kMono(pcm), from),
    );
    if (!isUsableTranscript(original, from)) {
      stats.dropped++;
      return;
    }
    const last = this.lastText.get(userId);
    if (last && last.text === original && Date.now() - last.at < DUPLICATE_MS) {
      stats.dropped++;
      return;
    }

    const to = otherLang(from);
    const translated = (
      await this.translator.translate(original, { from, to, speech: true })
    ).trim();
    if (!translated) {
      stats.dropped++;
      return;
    }
    // 投稿の失敗（権限がないなど）は翻訳の失敗とは分けて、ログだけ残す
    const posted = await out.post(userId, original, translated, to).catch((err: unknown) => {
      console.error("failed to post subtitle:", err);
      stats.errors++;
      return null;
    });
    if (posted === null) return;
    if (!posted) {
      stats.dropped++;
      return;
    }
    // 字幕にできた文だけを覚える。翻訳や投稿に失敗した文は、言い直せばまた字幕にする
    this.lastText.set(userId, { text: original, at: Date.now() });
    stats.processed++;
    stats.lastLatencyMs = Date.now() - receivedAt;
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
 * 指定した人の発話を 1 つ分受け取り、48kHz ステレオの PCM にして返す。truncated は、
 * 上限の長さで区切った（まだ話し続けているかもしれない）ことを示す。
 * Discord は人ごとに別の Opus の流れを送ってくるので、話者を聞き分ける必要はない。
 */
export function captureUtterance(
  receiver: Pick<VoiceReceiver, "subscribe">,
  userId: string,
): Promise<{ pcm: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    let total = 0;
    const maxBytes = 48_000 * 4 * (MAX_UTTERANCE_MS / 1000);
    let done = false;

    // デコーダー（opusscript）は destroy しないと WASM のメモリを返さない。残ったまま
    // 増えると、入室音や読み上げの再生で例外になってプロセスが落ちるので、どの終わり方でも必ず消す
    const cleanup = () => {
      if (!opus.destroyed) opus.destroy();
      if (!decoder.destroyed) decoder.destroy();
    };
    const finish = (truncated = false) => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ pcm: Buffer.concat(chunks), truncated });
    };
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      // 途中まで受け取れていれば使う（暗号化のやり直しなどで、まれに途切れる）
      if (total > 0) resolve({ pcm: Buffer.concat(chunks), truncated: false });
      else reject(err);
    };

    decoder.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) finish(true);
    });
    decoder.once("end", () => finish());
    decoder.once("error", fail);
    opus.once("error", fail);
    // Bot が通話を抜けて接続が破棄されると、受信のストリームは end も error も出さずに
    // close だけで終わる。close でも終えないと、Promise もデコーダーも残り続ける
    opus.once("close", () => finish());
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
    pipeline: new VoicePipeline(
      (wav, language) => transcribeWithOpenAI(wav, language, apiKey, sttModel),
      translator,
    ),
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
 * 参加した通話で、話者に指定した人の発話を拾って字幕にする。韓国語話者は日本語に、
 * 日本語話者は韓国語に訳す。字幕は Bot がいる VC の付属チャットに投稿する
 * （Bot が別の VC へ移されたら移動先に投稿する）。
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
  // 受信の失敗のログを最後に出した時刻（人ごと）
  const lastCaptureErrorAt = new Map<string, number>();

  const sendableChannel = () => {
    const channel = guild.channels.cache.get(session.channelId);
    return channel?.isSendable() ? channel : null;
  };
  const out: SubtitleOutput = {
    async post(userId, original, translated, to) {
      const channel = sendableChannel();
      if (session.destroyed || !channel) return false;
      const name = await displayName(guild, userId);
      // 韓国語の字幕は韓国語話者に向けたものなので、国旗を付けて見分けられるようにする
      const prefix = to === "ko" ? "🇰🇷 " : "";
      await channel.send({
        content: `${prefix}**${escapeDiscord(name)}**：${escapeDiscord(translated)}\n-# ${escapeDiscord(original)}`,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressNotifications,
      });
      return true;
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
    if (session.destroyed || capturing.has(userId) || !readSpeakers()[userId]) return;
    capturing.add(userId);
    let truncated = false;
    captureUtterance(connection.receiver, userId)
      .then((captured) => {
        truncated = captured.truncated;
        // 話している間に指定が変わったときのため、言語は話し終えた時点で引き直す
        const lang = readSpeakers()[userId];
        if (!session.destroyed && lang && captured.pcm.length > 0) {
          active.pipeline.handleUtterance(guild.id, userId, captured.pcm, lang, out);
        }
      })
      .catch((err: unknown) => {
        // 復号に失敗し続けると、話している間ずっと 1 パケットごとに失敗する。ログは人ごとに間引く
        const now = Date.now();
        if (now - (lastCaptureErrorAt.get(userId) ?? 0) < ERROR_NOTICE_INTERVAL_MS) return;
        lastCaptureErrorAt.set(userId, now);
        console.error(`failed to capture speech of ${userId}:`, err);
      })
      .finally(() => {
        capturing.delete(userId);
        // 上限の長さで区切ったあとも話し続けていれば、続きを拾う。失敗で終わったときは
        // すぐに拾い直さず、次に話し始めるのを待つ（毎パケット失敗して拾い直し続けないように）
        if (truncated && !session.destroyed && connection.receiver.speaking.users.has(userId)) {
          startCapture(userId);
        }
      });
  };
  connection.receiver.speaking.on("start", startCapture);
}
