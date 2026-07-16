import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import test, { after, beforeEach, mock } from "node:test";
import { AudioPlayerStatus, StreamType } from "@discordjs/voice";
import { ChannelType, type VoiceState } from "discord.js";
import { offPath, soundPath } from "../src/sounds.ts";

// 実際の再生には Discord への音声接続が要るため、player と connection だけ差し替える。
// 判定ロジック（enqueue / playNext）は本物を通す
const actualVoice = await import("@discordjs/voice");

type Played = { inputType: StreamType };
const played: Played[] = [];
let idle: (() => void) | undefined;

const player = {
  state: { status: AudioPlayerStatus.Idle as AudioPlayerStatus },
  on(event: string, handler: () => void) {
    if (event === AudioPlayerStatus.Idle) idle = handler;
    return player;
  },
  play(resource: Played) {
    played.push(resource);
    player.state = { status: AudioPlayerStatus.Playing };
  },
  stop() {},
};

mock.module("@discordjs/voice", {
  namedExports: {
    ...actualVoice,
    createAudioPlayer: () => player,
    createAudioResource: (_input: unknown, options: { inputType: StreamType }) => ({
      inputType: options.inputType,
      volume: { setVolume() {} },
    }),
    joinVoiceChannel: () => ({
      subscribe() {},
      on() {},
      state: { status: "ready" },
      destroy() {},
    }),
    entersState: async () => {},
    getVoiceConnection: () => undefined,
  },
});

// 外部サービス（VOICEVOX）はモックする
const synthesized: string[] = [];
let synthesis: () => Promise<Buffer | null> = async () => Buffer.from("wav");
mock.module("../src/voicevox.ts", {
  namedExports: {
    synthesizeJoinNotice: async (displayName: string) => {
      synthesized.push(displayName);
      return synthesis();
    },
  },
});

const { handleVoiceStateUpdate } = await import("../src/voice.ts");

let guildSeq = 0;
let guildId = "";

// createJoinSoundResource は実際に createReadStream するため、テストごとに消すと
// 開く前にファイルが無くなる。ファイル単位でまとめて後始末する
const registeredPaths: string[] = [];
async function registerSound(userId: string): Promise<string> {
  const path = soundPath(userId);
  await writeFile(path, "ogg");
  registeredPaths.push(path);
  return userId;
}

async function turnOff(userId: string): Promise<string> {
  await writeFile(offPath(userId), "");
  registeredPaths.push(offPath(userId));
  return userId;
}

after(async () => {
  await Promise.all(registeredPaths.map((path) => unlink(path).catch(() => {})));
});

function voiceState(
  id: string,
  displayName: string | undefined,
  channelId: string | null,
  remaining = 1,
): VoiceState {
  return {
    id,
    guild: { id: guildId, afkChannelId: null },
    client: { user: { id: "bot-id" } },
    member: { user: { bot: false }, displayName },
    channelId,
    channel: channelId && {
      id: channelId,
      type: ChannelType.GuildVoice,
      joinable: true,
      guild: { id: guildId, voiceAdapterCreator: () => ({}) },
      members: { filter: () => ({ size: remaining }) },
    },
  } as unknown as VoiceState;
}

// VC から退出する（remaining=0 なら Bot も抜けてセッションが壊れる）
async function leave(id: string): Promise<void> {
  await handleVoiceStateUpdate(
    voiceState(id, "アステル", "vc-1", 0),
    voiceState(id, "アステル", null),
  );
}

// 誰かが VC に入る
async function join(id: string, displayName: string | undefined): Promise<void> {
  await handleVoiceStateUpdate(
    voiceState(id, displayName, null),
    voiceState(id, displayName, "vc-1"),
  );
}

// 再生が終わって次の項目へ進む
async function finishPlayback(): Promise<void> {
  player.state = { status: AudioPlayerStatus.Idle };
  idle?.();
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  // セッションは guild ごとに持たれるので、テストごとに別 guild を使って隔離する
  guildId = `guild-${++guildSeq}`;
  played.length = 0;
  synthesized.length = 0;
  player.state = { status: AudioPlayerStatus.Idle };
  idle = undefined;
  synthesis = async () => Buffer.from("wav");
});

test("登録音があるユーザーは登録音が再生される", async () => {
  const userId = await registerSound("u-registered-1");

  await join(userId, "アステル");

  assert.deepEqual(played.map((r) => r.inputType), [StreamType.OggOpus]);
  assert.deepEqual(synthesized, [], "登録済みなら合成しない");
});

test("登録音がないユーザーは表示名で読み上げられる", async () => {
  await join("u-unregistered-1", "アステル");

  assert.deepEqual(played.map((r) => r.inputType), [StreamType.Arbitrary]);
  assert.deepEqual(synthesized, ["アステル"]);
});

test("表示名が取れないユーザーは何も再生しない", async () => {
  await join("u-unregistered-2", undefined);

  assert.deepEqual(played, []);
  assert.deepEqual(synthesized, []);
});

test("合成を待つ間に入室した人の音を先に再生しない", async () => {
  const registered = await registerSound("u-registered-2");

  // 1 人目の合成を止めておき、その最中に 2 人目を入室させる
  let release: (() => void) | undefined;
  synthesis = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Buffer.from("wav");
  };

  await join("u-unregistered-3", "アステル");
  assert.deepEqual(played, [], "合成中は何も再生していない");

  await join(registered, "ほか");
  assert.deepEqual(played, [], "合成待ちを追い越して再生しない");

  release?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(played.map((r) => r.inputType), [StreamType.Arbitrary]);

  await finishPlayback();

  assert.deepEqual(
    played.map((r) => r.inputType),
    [StreamType.Arbitrary, StreamType.OggOpus],
    "入室順に再生される",
  );
});

test("複数人が連続入室してもキュー順に再生される", async () => {
  const first = await registerSound("u-registered-3");
  const last = await registerSound("u-registered-4");

  await join(first, "一人目");
  await join("u-unregistered-4", "二人目");
  await join(last, "三人目");

  await finishPlayback();
  await finishPlayback();

  assert.deepEqual(
    played.map((r) => r.inputType),
    [StreamType.OggOpus, StreamType.Arbitrary, StreamType.OggOpus],
  );
  assert.deepEqual(synthesized, ["二人目"]);
});

test("VOICEVOXが落ちていても後続の登録音は再生される", async () => {
  const registered = await registerSound("u-registered-5");

  // 合成の失敗が確定する前に次の人を並ばせておく。そうしないと「失敗を飛ばして
  // 次へ進む」経路を通らず、キューが空になっただけと区別できない
  let release: (() => void) | undefined;
  synthesis = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return null; // 合成失敗
  };

  await join("u-unregistered-5", "アステル");
  await join(registered, "ほか");
  assert.deepEqual(played, [], "合成の結果待ち");

  release?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(synthesized, ["アステル"], "合成は試みる");
  assert.deepEqual(
    played.map((r) => r.inputType),
    [StreamType.OggOpus],
    "読み上げだけ飛ばして次を再生する",
  );
});

test("合成待ちの最中に全員退出したら再生しない", async () => {
  let release: (() => void) | undefined;
  synthesis = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Buffer.from("wav");
  };

  await join("u-unregistered-6", "アステル");
  await leave("u-unregistered-6");

  release?.();
  await new Promise((resolve) => setImmediate(resolve));

  // 購読者のいない player で再生すると AutoPaused のまま ffmpeg が残ってしまう
  assert.deepEqual(played, []);
});

test("offにした人は登録音があっても鳴らない", async () => {
  const userId = await registerSound("u-off-1");
  await turnOff(userId);

  await join(userId, "アステル");

  assert.deepEqual(played, []);
  assert.deepEqual(synthesized, [], "合成も試みない");
});

test("offにした人は未登録でも読み上げられない", async () => {
  const userId = await turnOff("u-off-2");

  await join(userId, "アステル");

  assert.deepEqual(played, []);
  assert.deepEqual(synthesized, []);
});

test("offにした人が最初に入室してもBotは参加する", async () => {
  const userId = await turnOff("u-off-3");

  await join(userId, "アステル");

  // 参加はするので、次に入った人の入室音は鳴らせる
  const other = await registerSound("u-off-4");
  await join(other, "ほか");

  assert.deepEqual(played.map((r) => r.inputType), [StreamType.OggOpus]);
});

test("offは他の人の入室音に影響しない", async () => {
  const muted = await turnOff("u-off-5");
  const other = await registerSound("u-off-6");

  await join(other, "ほか");
  await join(muted, "アステル");
  await finishPlayback();

  assert.deepEqual(played.map((r) => r.inputType), [StreamType.OggOpus]);
});
