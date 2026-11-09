const DEFAULT_URL = "http://piper:5000";

const baseUrl = (process.env.PIPER_URL ?? DEFAULT_URL).replace(/\/$/, "");

export type Segment = { korean: boolean; text: string };

// ハングルの連なり。間の空白・数字・句読点はまたいで 1 つにまとめ、直前の数字
// （「3개」の 3）と直後の句読点も含める。ㅋ のような字母も Hangul に入る
const KOREAN = /(?:\d+\s*)?\p{Script=Hangul}+(?:[\s\d.,!?~。、！？]*\p{Script=Hangul}+)*[.,!?~。、！？]*/gu;

// 記号や絵文字だけの切れ端は読むものがないので捨てる
const READABLE = /[\p{L}\p{N}]/u;

/** 文を韓国語の部分とそれ以外に分ける。ハングルがなければ文をそのまま 1 つで返す。 */
export function splitKorean(text: string): Segment[] {
  if (!/\p{Script=Hangul}/u.test(text)) return [{ korean: false, text }];

  const segments: Segment[] = [];
  const pushOther = (part: string) => {
    if (READABLE.test(part)) segments.push({ korean: false, text: part.trim() });
  };
  let last = 0;
  for (const match of text.matchAll(KOREAN)) {
    pushOther(text.slice(last, match.index));
    segments.push({ korean: true, text: match[0].trim() });
    last = match.index + match[0].length;
  }
  pushOther(text.slice(last));
  return segments;
}

/** 韓国語の文を Piper で合成する。VOICEVOX と同じく、失敗は null にして Bot を止めない。 */
export async function synthesizeKorean(
  text: string,
  timeoutMs: number,
): Promise<Buffer | null> {
  try {
    const res = await fetch(`${baseUrl}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`synthesize failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error("piper synthesis failed:", err);
    return null;
  }
}
