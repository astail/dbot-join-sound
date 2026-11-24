const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;

// それだけでは訳しても会話の中身が増えない相槌・つなぎの言葉・笑い声。
// 句読点で区切った複数の相槌も、全部がこれに当てはまるときだけ捨てる
const BACKCHANNEL_WORDS = new Set([
  "아하",
  "와",
  "우와",
  "헐",
  "그래",
  "그래요",
  "맞아",
  "맞아요",
  "맞습니다",
  "그렇지",
  "그렇죠",
  "그렇습니다",
  "그러게",
  "그러게요",
  "그러네요",
  "알겠어",
  "알겠어요",
  "알겠습니다",
  "알았어",
  "알았어요",
  "알았습니다",
  "오케이",
]);
const BACKCHANNEL_SOUND =
  /^(?:아+|어+|(?:으+|흐+)?음+|흠+|응+|네+에*|예+에*|넵+|넹+|옙+|오+|[ᄏᄒ]+|하하+)$/;
const BACKCHANNEL_SEPARATOR = /[\s.,!?…~。！？、，"'“”‘’()[\]{}<>:;·]+/u;

// 文全体が相槌のような短い反応だけなら true
export function isBackchannel(text: string): boolean {
  const parts = text
    .normalize("NFKC")
    .toLowerCase()
    .split(BACKCHANNEL_SEPARATOR)
    .filter(Boolean);
  return (
    parts.length > 0 &&
    parts.every((part) => BACKCHANNEL_WORDS.has(part) || BACKCHANNEL_SOUND.test(part))
  );
}

// Whisper 系の文字起こしが、無音や物音から作りがちな定型文（韓国語の YouTube 字幕に由来する）。
// 短い文がこれに当てはまったら捨てる
const HALLUCINATIONS: RegExp[] = [
  /시청.{0,6}감사/, // ご視聴ありがとうございます
  /구독.{0,6}(좋아요|부탁)/, // チャンネル登録・高評価
  /(MBC|KBS|SBS)\s*뉴스/,
  /다음\s*(영상|시간)에\s*만나/,
  /자막\s*(제공|by)/i,
];

// 文字起こしの結果を訳して字幕にするか。false なら捨てる
export function isUsableTranscript(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // 韓国語話者の発話なのにハングルがない。聞き違いか物音
  if (!HANGUL.test(t)) return false;
  if (isBackchannel(t)) return false;
  if (t.length <= 30 && HALLUCINATIONS.some((re) => re.test(t))) return false;
  return true;
}

// 字幕に埋め込んだとき markdown として崩れないようにする
export function escapeDiscord(text: string): string {
  return text.replace(/[\\`*_~|]/g, "\\$&");
}
