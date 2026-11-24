import assert from "node:assert/strict";
import test from "node:test";
import { pcm48kStereoToWav16kMono, pcmRms } from "../src/wav.ts";

// 48kHz ステレオの s16le PCM（左右とも value）
function stereoPcm(frames: number, value: number): Buffer {
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(value, i * 4);
    buf.writeInt16LE(value, i * 4 + 2);
  }
  return buf;
}

test("16kHz モノラルの WAV ヘッダを付ける", () => {
  const wav = pcm48kStereoToWav16kMono(stereoPcm(48_000, 1000)); // 1 秒
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1); // モノラル
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 16_000 * 2); // 1 秒分のデータ
  assert.equal(wav.length, 44 + 16_000 * 2);
});

test("サンプルの値を保ったまま間引く", () => {
  const wav = pcm48kStereoToWav16kMono(stereoPcm(300, -2500));
  assert.equal(wav.readUInt32LE(40), 100 * 2); // 300 フレーム / 3
  for (let i = 0; i < 100; i++) {
    assert.equal(wav.readInt16LE(44 + i * 2), -2500);
  }
});

test("1 フレームに満たない入力でも壊れない", () => {
  const wav = pcm48kStereoToWav16kMono(Buffer.alloc(2));
  assert.equal(wav.readUInt32LE(40), 0);
});

test("RMS は音量の大きさを返す", () => {
  assert.equal(pcmRms(Buffer.alloc(0)), 0);
  assert.equal(pcmRms(stereoPcm(100, 0)), 0);
  assert.equal(Math.round(pcmRms(stereoPcm(100, 1000))), 1000);
  assert.equal(Math.round(pcmRms(stereoPcm(100, -1000))), 1000);
});
