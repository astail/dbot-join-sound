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

export type NoticeKind = "join" | "leave" | "move";

const noticeTexts: Record<NoticeKind, string> = {
  join: "入室しました",
  leave: "退室しました",
  move: "チャンネルを移動しました",
};

/** 入退室案内の音声（WAV）を合成する。 */
export async function synthesizeNotice(
  name: string,
  kind: NoticeKind,
  botId: string,
): Promise<Buffer | null> {
  return synthesize(`${name}が${noticeTexts[kind]}`, botId);
}

/**
 * 文章をそのまま読み上げる音声（WAV）を合成する。VOICEVOX が落ちていても Bot を
 * 止めないため、失敗はここで握り潰して null を返す。
 */
export async function synthesize(
  text: string,
  botId: string,
): Promise<Buffer | null> {
  const speaker = botSpeakers.get(botId) ?? speakers[0];
  try {
    // 読みと抑揚を決める audio_query の結果を、そのまま synthesis へ渡す 2 段構成
    const query = await fetch(
      `${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
      { method: "POST", signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!query.ok) throw new Error(`audio_query failed: HTTP ${query.status}`);

    const synthesis = await fetch(`${baseUrl}/synthesis?speaker=${speaker}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await query.text(),
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
