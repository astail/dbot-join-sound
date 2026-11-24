import type { Lang } from "./translator.js";

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
// 仮名か漢字。日本語話者の文字起こしの結果に含まれるはずの文字
const JAPANESE = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f\u3400-\u4dbf\u4e00-\u9fff]/;

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

// 日本語の相槌。カタカナはひらがなに寄せてから照らし合わせる
const JA_BACKCHANNEL_WORDS = new Set([
  "なるほど",
  "そうだね",
  "そうだよね",
  "そうですね",
  "そうそう",
  "そっか",
  "そうか",
  "そうなんだ",
  "たしかに",
  "確かに",
  "了解",
  "了解です",
  "りょうかい",
  "おっけー",
  "おけ",
  "わかった",
  "わかりました",
  "分かった",
  "分かりました",
  "いいね",
  "まじか",
  "まじで",
]);
const JA_BACKCHANNEL_SOUND =
  /^(?:(?:はー?い)+|(?:う+ー*ん+)+|え+ー*|あ+ー*|お+ー*|へ+ー*|ふ+ー*ん|ほ+ー*|ん+ー*|(?:は|あ)(?:は|あ)+|w+|笑+)$/;

function katakanaToHiragana(text: string): string {
  return text.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// 文全体が相槌のような短い反応だけなら true。lang は話者の言語
export function isBackchannel(text: string, lang: Lang = "ko"): boolean {
  const normalized = text.normalize("NFKC").toLowerCase();
  const parts = (lang === "ja" ? katakanaToHiragana(normalized) : normalized)
    .split(BACKCHANNEL_SEPARATOR)
    .filter(Boolean);
  const words = lang === "ja" ? JA_BACKCHANNEL_WORDS : BACKCHANNEL_WORDS;
  const sound = lang === "ja" ? JA_BACKCHANNEL_SOUND : BACKCHANNEL_SOUND;
  return parts.length > 0 && parts.every((part) => words.has(part) || sound.test(part));
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

// 日本語の YouTube 字幕に由来する定型文
const JA_HALLUCINATIONS: RegExp[] = [
  /ご視聴.{0,6}ありがとう/,
  /チャンネル登録/,
  /高評価/,
  /字幕.{0,4}(提供|作成|by)/i,
  /次回.{0,8}(お楽しみ|お会い)/,
];

// 文字起こしの結果を訳して字幕にするか。lang は話者の言語。false なら捨てる
export function isUsableTranscript(text: string, lang: Lang = "ko"): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // 話者の言語の文字がない。聞き違いか物音
  if (!(lang === "ko" ? HANGUL : JAPANESE).test(t)) return false;
  if (isBackchannel(t, lang)) return false;
  const hallucinations = lang === "ko" ? HALLUCINATIONS : JA_HALLUCINATIONS;
  if (t.length <= 30 && hallucinations.some((re) => re.test(t))) return false;
  return true;
}

// 字幕に埋め込んだとき markdown として崩れないようにする
export function escapeDiscord(text: string): string {
  return text.replace(/[\\`*_~|]/g, "\\$&");
}
