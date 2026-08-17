import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { soundsDir } from "../src/sounds.ts";
import {
  createJoinSoundResource,
  createNoticeResource,
  resolveAnnounceDelayMs,
  resolveFadeInMs,
  resolvePlaybackVolume,
  resolveVoicevoxVolume,
} from "../src/voice.ts";
import type { AudioResource } from "@discordjs/voice";

// フェードは 50ms 間隔のタイマーで進むため、変化しないことの確認はこれだけ待つ
const FADE_SETTLE_MS = 200;

// createJoinSoundResource は実際に createReadStream するので、実ファイルが要る
async function withSound(
  name: string,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const path = join(soundsDir, name);
  await writeFile(path, "");
  try {
    await run(path);
  } finally {
    await unlink(path).catch(() => {});
  }
}

// タイマーの発火タイミングに依存しないよう、期待値になるまで待つ
async function waitForVolume(
  resource: AudioResource,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (resource.volume?.volume !== expected && Date.now() < deadline) {
    await setTimeout(10);
  }
  assert.equal(resource.volume?.volume, expected);
}

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
    const resource = createJoinSoundResource(path, 0.2, 0);
    assert.equal(resource.volume?.volume, 0.2);
    resource.playStream.destroy();
  } finally {
    await unlink(path).catch(() => {});
  }
});

test("入退室から鳴らすまでの待ちのデフォルトは0.5秒", () => {
  assert.equal(resolveAnnounceDelayMs(undefined), 500);
  assert.equal(resolveAnnounceDelayMs(""), 500);
});

test("待ち時間はミリ秒で変更できる", () => {
  assert.equal(resolveAnnounceDelayMs("0"), 0);
  assert.equal(resolveAnnounceDelayMs("1500"), 1500);
  assert.equal(resolveAnnounceDelayMs("5000"), 5000);
});

test("範囲外または不正な待ち時間を拒否する", () => {
  assert.throws(() => resolveAnnounceDelayMs("-1"), /0 以上 5000 以下/);
  assert.throws(() => resolveAnnounceDelayMs("5001"), /0 以上 5000 以下/);
  assert.throws(() => resolveAnnounceDelayMs("invalid"), /0 以上 5000 以下/);
});

test("フェードインのデフォルトは1秒", () => {
  assert.equal(resolveFadeInMs(undefined), 1000);
  assert.equal(resolveFadeInMs(""), 1000);
});

test("フェードイン時間はミリ秒で変更できる", () => {
  assert.equal(resolveFadeInMs("0"), 0);
  assert.equal(resolveFadeInMs("2000"), 2000);
  assert.equal(resolveFadeInMs("8000"), 8000);
});

// 上限は入室音のトリム長。これを超えると鳴り終わるまでにフェードが完了しない
test("範囲外または不正なフェードイン時間を拒否する", () => {
  assert.throws(() => resolveFadeInMs("-1"), /0 以上 8000 以下/);
  assert.throws(() => resolveFadeInMs("8001"), /0 以上 8000 以下/);
  assert.throws(() => resolveFadeInMs("invalid"), /0 以上 8000 以下/);
});

test("フェードインありなら無音から始まり再生に応じて上がる", async () => {
  await withSound("fade-test.ogg", async (path) => {
    const resource = createJoinSoundResource(path, 0.4, 1000);
    assert.equal(resource.volume?.volume, 0);

    // 再生済み時間に比例して目標音量へ近づく
    resource.playbackDuration = 500;
    await waitForVolume(resource, 0.2);

    resource.playbackDuration = 1000;
    await waitForVolume(resource, 0.4);
    resource.playStream.destroy();
  });
});

test("フェード完了後は音量を上げ続けない", async () => {
  await withSound("fade-done-test.ogg", async (path) => {
    const resource = createJoinSoundResource(path, 0.4, 100);
    resource.playbackDuration = 200;
    await waitForVolume(resource, 0.4);

    // タイマーが止まっていれば、さらに再生が進んでも 0.4 のまま
    resource.playbackDuration = 5000;
    await setTimeout(FADE_SETTLE_MS);
    assert.equal(resource.volume?.volume, 0.4);
    resource.playStream.destroy();
  });
});

test("フェード途中で鳴り終わったらタイマーを止める", async () => {
  await withSound("fade-ended-test.ogg", async (path) => {
    // 目標音量に届く前に鳴り終わる短い音を模す
    const resource = createJoinSoundResource(path, 0.4, 1000);
    resource.playbackDuration = 250;
    await waitForVolume(resource, 0.1);

    resource.playStream.destroy();
    assert.equal(resource.ended, true);
    await setTimeout(FADE_SETTLE_MS);

    // タイマーが止まっていれば、再生位置が進んだことにしても反応しない
    resource.playbackDuration = 1000;
    await setTimeout(FADE_SETTLE_MS);
    assert.equal(resource.volume?.volume, 0.1);
  });
});

test("VOICEVOXのオーディオリソースへ専用音量を設定する", () => {
  const resource = createNoticeResource(Buffer.from("wav"), 0.4);
  assert.equal(resource.volume?.volume, 0.4);
  resource.playStream.destroy();
});
