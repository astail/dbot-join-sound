const DEFAULT_URL = "http://voicevox:50021";
const DEFAULT_SPEAKER = 14; // 冥鳴ひまり（ノーマル）
const DEFAULT_TIMEOUT_MS = 10_000;

export function resolveSpeaker(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SPEAKER;

  const speaker = Number(value);
  if (!Number.isInteger(speaker) || speaker < 0) {
    throw new Error("VOICEVOX_SPEAKER は 0 以上の整数で指定してください");
  }
  return speaker;
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
const speaker = resolveSpeaker(process.env.VOICEVOX_SPEAKER);
const timeoutMs = resolveTimeoutMs(process.env.VOICEVOX_TIMEOUT_MS);

/**
 * 入室案内の音声（WAV）を合成する。VOICEVOX が落ちていても Bot を止めないため、
 * 失敗はここで握り潰して null を返す。
 */
export async function synthesizeJoinNotice(
  displayName: string,
): Promise<Buffer | null> {
  const text = `${displayName}さんが入室しました`;
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
