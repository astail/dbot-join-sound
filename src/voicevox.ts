import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { splitKorean, synthesizeKorean } from "./korean.js";
import { soundsDir } from "./sounds.js";

const DEFAULT_URL = "http://voicevox:50021";
const DEFAULT_SPEAKER = 14; // 冥鳴ひまり（ノーマル）
const DEFAULT_TIMEOUT_MS = 10_000;

// DISCORD_TOKEN と同じ順にカンマ区切りで並べ、Bot ごとに声を変えられる
export function resolveSpeakers(value: string | undefined): number[] {
  if (value === undefined || value.trim() === "") return [DEFAULT_SPEAKER];

  return value.split(",").map((part) => {
    const speaker = Number(part.trim());
    if (part.trim() === "" || !Number.isInteger(speaker) || speaker < 0) {
      throw new Error("VOICEVOX_SPEAKER は 0 以上の整数で指定してください");
    }
    return speaker;
  });
}

export function resolveTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TIMEOUT_MS;

  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("VOICEVOX_TIMEOUT_MS は 1 以上の整数で指定してください");
  }
  return timeout;
}

const baseUrl = (process.env.VOICEVOX_URL ?? DEFAULT_URL).replace(/\/$/, "");
const speakers = resolveSpeakers(process.env.VOICEVOX_SPEAKER);
const timeoutMs = resolveTimeoutMs(process.env.VOICEVOX_TIMEOUT_MS);

// Bot の ID ごとの話者。割り当てのない Bot は 1 つ目の話者で読む
const botSpeakers = new Map<string, number>();

/** index 番目のトークンの Bot に、VOICEVOX_SPEAKER の index 番目の話者を割り当てる。 */
export function assignSpeaker(botId: string, index: number): void {
  botSpeakers.set(botId, speakers[index] ?? speakers[0]);
}

function speakerOf(botId: string): number {
  return botSpeakers.get(botId) ?? speakers[0];
}

export type NoticeKind = "join" | "leave" | "move";

const noticeTexts: Record<NoticeKind, string> = {
  join: "入室しました",
  leave: "退室しました",
  move: "チャンネルを移動しました",
};

// 入退室の案内は同じ人なら毎回同じ文になるので、合成した WAV を残して使い回す。
// Raspberry Pi などでは VOICEVOX の合成に数秒かかり、その分だけ案内が遅れるため。
// sounds ボリュームに置いて毎日の再起動をまたいでも残す。話者か文（読み方の登録後の
// 名前を含む）が変われば別のファイルになるので、古い読みが残ることはない
const noticeCacheDir = join(soundsDir, "notice-cache");

/** 入退室案内の音声（WAV）を合成する。同じ話者・同じ文は 2 回目から保存済みの WAV を返す。 */
export async function synthesizeNotice(
  name: string,
  kind: NoticeKind,
  botId: string,
): Promise<Buffer | null> {
  const text = `${name}が${noticeTexts[kind]}`;
  const key = createHash("sha256").update(`${speakerOf(botId)}\n${text}`).digest("hex");
  const path = join(noticeCacheDir, `${key}.wav`);
  try {
    return await readFile(path);
  } catch {
    // 未保存（または読めない）なら合成し直す
  }

  const { wav, complete } = await synthesizeParts(text, botId);
  // VOICEVOX か Piper が落ちて一部だけ読めた音声は残さず、次回また合成する
  if (wav && complete) await saveNotice(path, wav);
  return wav;
}

// 書きかけのファイルを読まないよう、別名で書いてから置き換える
async function saveNotice(path: string, wav: Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(noticeCacheDir, { recursive: true });
    await writeFile(tmp, wav);
    await rename(tmp, path);
  } catch (err) {
    console.error("failed to cache notice:", err);
  }
}

// 日本語と韓国語が混ざった文は WAV をつなぐので、VOICEVOX の出力を
// Piper の韓国語の声（kss-medium）と同じサンプリングレートにそろえる
const MIXED_SAMPLE_RATE = 22_050;

// Piper は合成のたびに最大音量まで引き上げるため、そのままだと VOICEVOX より
// 約 9dB 大きく聞こえる。実測（EBU R128 のラウドネス）の差に合わせて下げる
const KOREAN_GAIN = 0.35;

async function synthesizeKoreanAtJapaneseVolume(text: string): Promise<Buffer | null> {
  const wav = await synthesizeKorean(text, timeoutMs);
  if (!wav) return null;
  try {
    return scaleWav(wav, KOREAN_GAIN);
  } catch (err) {
    console.error("failed to scale wav:", err);
    return null;
  }
}

/**
 * 文章をそのまま読み上げる音声（WAV）を合成する。韓国語の部分は Piper、それ以外は
 * VOICEVOX で合成し、1 本につなぐ。どちらかが落ちていても読める部分だけ読み、
 * 何も合成できなければ null を返す。
 */
export async function synthesize(
  text: string,
  botId: string,
): Promise<Buffer | null> {
  return (await synthesizeParts(text, botId)).wav;
}

// complete は、どの部分も合成できたか（一部を飛ばしていないか）
async function synthesizeParts(
  text: string,
  botId: string,
): Promise<{ wav: Buffer | null; complete: boolean }> {
  const segments = splitKorean(text);
  if (segments.length === 1) {
    const [segment] = segments;
    const wav = segment.korean
      ? await synthesizeKoreanAtJapaneseVolume(segment.text)
      : await synthesizeJapanese(segment.text, botId);
    return { wav, complete: wav !== null };
  }

  const wavs = await Promise.all(
    segments.map((segment) =>
      segment.korean
        ? synthesizeKoreanAtJapaneseVolume(segment.text)
        : synthesizeJapanese(segment.text, botId, MIXED_SAMPLE_RATE),
    ),
  );
  const synthesized = wavs.filter((wav) => wav !== null);
  if (synthesized.length === 0) return { wav: null, complete: false };
  try {
    return {
      wav: concatWav(synthesized),
      complete: synthesized.length === wavs.length,
    };
  } catch (err) {
    console.error("failed to concat wav:", err);
    return { wav: null, complete: false };
  }
}

/**
 * VOICEVOX で合成する。VOICEVOX が落ちていても Bot を止めないため、失敗はここで
 * 握り潰して null を返す。
 */
async function synthesizeJapanese(
  text: string,
  botId: string,
  sampleRate?: number,
): Promise<Buffer | null> {
  const speaker = speakerOf(botId);
  try {
    // 読みと抑揚を決める audio_query の結果を、そのまま synthesis へ渡す 2 段構成
    const query = await fetch(
      `${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
      { method: "POST", signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!query.ok) throw new Error(`audio_query failed: HTTP ${query.status}`);
    const body =
      sampleRate === undefined
        ? await query.text()
        : JSON.stringify({ ...(await query.json()), outputSamplingRate: sampleRate });

    const synthesis = await fetch(`${baseUrl}/synthesis?speaker=${speaker}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!synthesis.ok) {
      throw new Error(`synthesis failed: HTTP ${synthesis.status}`);
    }
    return Buffer.from(await synthesis.arrayBuffer());
  } catch (err) {
    console.error("voicevox synthesis failed:", err);
    return null;
  }
}

type WavFormat = { channels: number; sampleRate: number; bitsPerSample: number };

// WAV のチャンクを順に見て、形式（fmt）と音声データ（data）を取り出す
function parseWav(wav: Buffer): { format: WavFormat; data: Buffer } {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("WAV ではありません");
  }
  let format: WavFormat | undefined;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bitsPerSample: wav.readUInt16LE(body + 14),
      };
    } else if (id === "data" && format) {
      return { format, data: wav.subarray(body, body + size) };
    }
    offset = body + size + (size % 2); // チャンクは偶数バイト境界にそろう
  }
  throw new Error("WAV の fmt または data チャンクが見つかりません");
}

/** 16bit PCM の WAV の音量を gain 倍にする（元の WAV は書き換えない）。 */
export function scaleWav(wav: Buffer, gain: number): Buffer {
  const { format, data } = parseWav(wav);
  if (format.bitsPerSample !== 16) {
    throw new Error(`16bit 以外の WAV は扱えません: ${format.bitsPerSample}bit`);
  }
  const scaled = Buffer.from(wav);
  const start = data.byteOffset - wav.byteOffset;
  for (let i = start; i + 1 < start + data.length; i += 2) {
    scaled.writeInt16LE(Math.round(scaled.readInt16LE(i) * gain), i);
  }
  return scaled;
}

/** 同じ形式の WAV（PCM）をつないで 1 つの WAV にする。 */
export function concatWav(wavs: Buffer[]): Buffer {
  const parsed = wavs.map(parseWav);
  const { format } = parsed[0];
  for (const { format: other } of parsed) {
    if (
      other.channels !== format.channels ||
      other.sampleRate !== format.sampleRate ||
      other.bitsPerSample !== format.bitsPerSample
    ) {
      throw new Error(
        `WAV の形式が揃っていません: ${JSON.stringify(format)} と ${JSON.stringify(other)}`,
      );
    }
  }

  const data = Buffer.concat(parsed.map((p) => p.data));
  const blockAlign = (format.channels * format.bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
