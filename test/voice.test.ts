import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { soundsDir } from "../src/sounds.ts";
import {
  createJoinNoticeResource,
  createJoinSoundResource,
  resolvePlaybackVolume,
  resolveVoicevoxVolume,
} from "../src/voice.ts";

test("登録音の再生音量のデフォルトは40%", () => {
  assert.equal(resolvePlaybackVolume(undefined), 0.4);
  assert.equal(resolvePlaybackVolume(""), 0.4);
});

test("再生音量は0から1の範囲で変更できる", () => {
  assert.equal(resolvePlaybackVolume("0"), 0);
  assert.equal(resolvePlaybackVolume("0.25"), 0.25);
  assert.equal(resolvePlaybackVolume("1"), 1);
});

test("範囲外または不正な再生音量を拒否する", () => {
  assert.throws(() => resolvePlaybackVolume("-0.1"), /0 以上 1 以下/);
  assert.throws(() => resolvePlaybackVolume("1.1"), /0 以上 1 以下/);
  assert.throws(() => resolvePlaybackVolume("invalid"), /0 以上 1 以下/);
});

test("VOICEVOXの音量を独立して設定できる", () => {
  assert.equal(resolveVoicevoxVolume(undefined), 0.8);
  assert.equal(resolveVoicevoxVolume(""), 0.8);
  assert.equal(resolveVoicevoxVolume("0.4"), 0.4);
  assert.throws(
    () => resolveVoicevoxVolume("1.1"),
    /VOICEVOX_VOLUME は 0 以上 1 以下/,
  );
});

test("オーディオリソースへ再生音量を設定する", async () => {
  const path = join(soundsDir, "volume-test.ogg");
  await writeFile(path, "");
  try {
    const resource = createJoinSoundResource(path, 0.2);
    assert.equal(resource.volume?.volume, 0.2);
    resource.playStream.destroy();
  } finally {
    await unlink(path).catch(() => {});
  }
});

test("VOICEVOXのオーディオリソースへ専用音量を設定する", () => {
  const resource = createJoinNoticeResource(Buffer.from("wav"), 0.4);
  assert.equal(resource.volume?.volume, 0.4);
  resource.playStream.destroy();
});
