import assert from "node:assert/strict";
import test from "node:test";
import { escapeDiscord, isBackchannel, isUsableTranscript } from "../src/transcript.ts";

test("ふつうの韓国語の発話は字幕にする", () => {
  assert.equal(isUsableTranscript("오늘 게임 진짜 재밌었어"), true);
  assert.equal(isUsableTranscript("내일 몇 시에 할까?"), true);
});

test("中身のある短い返事は字幕にする", () => {
  assert.equal(isUsableTranscript("감사합니다."), true);
  assert.equal(isUsableTranscript("아니요."), true);
  assert.equal(isUsableTranscript("몰라."), true);
});

test("笑い声以外のハングル字母の略語は字幕にする", () => {
  assert.equal(isUsableTranscript("ㄴㄴ"), true);
  assert.equal(isUsableTranscript("ㅈㅅ"), true);
  assert.equal(isUsableTranscript("ㄱㄱ"), true);
});

test("相槌だけの発話は捨てる", () => {
  for (const text of [
    "네.",
    "응",
    "으음...",
    "흐음...",
    "아하!",
    "그래",
    "맞아.",
    "그렇지",
    "오케이~",
    "우와!",
    "ㅋㅋㅋ",
    "네, 네",
    "아... 네.",
    "그래요",
    "맞아요",
    "맞습니다",
    "그렇죠",
    "그렇습니다",
    "그러게요",
    "그러네요",
    "알겠습니다",
    "알았습니다",
    "넵",
    "넹",
    "옙",
    "넵넵",
  ]) {
    assert.equal(isUsableTranscript(text), false, text);
  }
});

test("相槌で始まっても中身が続けば字幕にする", () => {
  assert.equal(isUsableTranscript("네, 오늘 갈게요."), true);
  assert.equal(isUsableTranscript("맞아, 그 게임 재미있었어."), true);
  assert.equal(isUsableTranscript("아예 안 갈래."), true);
});

test("空の文とハングルを含まない文は捨てる", () => {
  assert.equal(isUsableTranscript(""), false);
  assert.equal(isUsableTranscript("   "), false);
  assert.equal(isUsableTranscript("..."), false);
  assert.equal(isUsableTranscript("Thank you for watching"), false);
});

test("文字起こしが無音から作りがちな定型文は捨てる", () => {
  assert.equal(isUsableTranscript("시청해주셔서 감사합니다"), false);
  assert.equal(isUsableTranscript("구독과 좋아요 부탁드립니다"), false);
  assert.equal(isUsableTranscript("MBC 뉴스 김철수입니다"), false);
});

test("定型文の言葉を含む長い発話は字幕にする", () => {
  assert.equal(
    isUsableTranscript("어제 방송 보다가 시청자가 감사하다고 해서 기분이 좋았어 진짜로"),
    true,
  );
});

test("相槌の判定は全角や句読点の違いを吸収する", () => {
  assert.equal(isBackchannel("　네！ 네～ "), true);
  assert.equal(isBackchannel("오케이, 알겠어요"), true);
  assert.equal(isBackchannel(""), false);
  assert.equal(isBackchannel("네 오늘 갈게요"), false);
});

test("字幕に入れる文の markdown 記号をエスケープする", () => {
  assert.equal(
    escapeDiscord("*bold* _it_ `code` |sp| ~~s~~"),
    "\\*bold\\* \\_it\\_ \\`code\\` \\|sp\\| \\~\\~s\\~\\~",
  );
});

test("日本語話者のふつうの発話は字幕にする", () => {
  assert.equal(isUsableTranscript("今日のゲーム本当に面白かった", "ja"), true);
  assert.equal(isUsableTranscript("明日何時にやる？", "ja"), true);
  assert.equal(isUsableTranscript("ありがとう", "ja"), true);
});

test("日本語話者の相槌だけの発話は捨てる", () => {
  for (const text of [
    "はい",
    "はいはい",
    "はーい",
    "うん",
    "うんうん",
    "うーん...",
    "ええ",
    "えー",
    "あー",
    "へー",
    "ふーん",
    "なるほど",
    "そうそう",
    "そうですね。",
    "確かに",
    "オッケー",
    "ハハハ",
    "www",
    "はい、はい",
    "あー、なるほど",
  ]) {
    assert.equal(isUsableTranscript(text, "ja"), false, text);
  }
});

test("日本語話者の相槌で始まっても中身が続けば字幕にする", () => {
  assert.equal(isUsableTranscript("はい、今から行きます", "ja"), true);
  assert.equal(isUsableTranscript("うん、それでいいよ", "ja"), true);
});

test("日本語話者の結果に日本語の文字がなければ捨てる", () => {
  assert.equal(isUsableTranscript("Thank you for watching", "ja"), false);
  assert.equal(isUsableTranscript("오늘 게임 재밌었어", "ja"), false);
  assert.equal(isUsableTranscript("...", "ja"), false);
});

test("日本語の定型文（ご視聴ありがとうございました など）は捨てる", () => {
  assert.equal(isUsableTranscript("ご視聴ありがとうございました", "ja"), false);
  assert.equal(isUsableTranscript("チャンネル登録よろしくお願いします", "ja"), false);
});
