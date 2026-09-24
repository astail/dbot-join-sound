import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import test, { after, beforeEach, mock } from "node:test";
import { AudioPlayerStatus, StreamType } from "@discordjs/voice";
import { ChannelType, type Message, type VoiceState } from "discord.js";

// 設定はモジュールの読み込み時に確定するため、src を読む前に指定する（このファイル
// だけ別プロセスで動くので、他のテストの設定には影響しない）
process.env.JOIN_SOUND_ENABLED = "false";
// 一拍置く待ちはここでの関心事ではない。0 ならタイマーを差し替えずに済む
process.env.ANNOUNCE_DELAY_MS = "0";

// 実際の再生には Discord への音声接続が要るため、player と connection だけ差し替える
const actualVoice = await import("@discordjs/voice");

const played: StreamType[] = [];
const player = {
  state: { status: AudioPlayerStatus.Idle as AudioPlayerStatus },
  on() {
    return player;
  },
  play(resource: { inputType: StreamType }) {
    played.push(resource.inputType);
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

// 辞書は sounds/yomi.json を共有し、テストファイルの並行実行で奪い合うためモックする
mock.module("../src/yomi.ts", {
  namedExports: { applyYomi: (displayName: string) => displayName },
});

const synthesized: string[] = [];
mock.module("../src/voicevox.ts", {
  namedExports: {
    synthesizeNotice: async (name: string, kind: string) => {
      synthesized.push(`${kind}:${name}`);
      return Buffer.from("wav");
    },
    synthesize: async () => Buffer.from("wav"),
  },
});

const { resolveJoinSoundEnabled, soundPath } = await import("../src/sounds.ts");
const { handleVoiceStateUpdate } = await import("../src/voice.ts");
const { handleMessage } = await import("../src/register.ts");

const botId = "1234567890";

let guildSeq = 0;
let guildId = "";

const cleanupPaths: string[] = [];
after(async () => {
  await Promise.all(cleanupPaths.map((path) => unlink(path).catch(() => {})));
});

beforeEach(() => {
  // セッションは guild ごとに持たれるので、テストごとに別 guild を使って隔離する
  guildId = `guild-disabled-${++guildSeq}`;
  played.length = 0;
  synthesized.length = 0;
  player.state = { status: AudioPlayerStatus.Idle };
});

function voiceState(id: string, channelId: string | null): VoiceState {
  return {
    id,
    guild: { id: guildId, afkChannelId: null },
    client: { user: { id: "bot-id" } },
    member: { user: { bot: false }, displayName: "アステル" },
    channelId,
    channel: channelId && {
      id: channelId,
      type: ChannelType.GuildVoice,
      joinable: true,
      guild: { id: guildId, voiceAdapterCreator: () => ({}) },
      members: { filter: () => ({ size: 1 }) },
    },
  } as unknown as VoiceState;
}

function createMessage(
  content: string,
  userId: string,
  reply: (payload: unknown) => Promise<unknown>,
  attachment?: unknown,
): Message {
  return {
    author: { bot: false, id: userId },
    inGuild: () => true,
    content,
    client: { user: { id: botId, username: "test-bot" } },
    attachments: { first: () => attachment },
    member: { voice: { channel: null } },
    guildId,
    reply,
    react: async () => {},
  } as unknown as Message;
}

// Bot は通話にいないとコマンドを受け付けないので、誰かを入室させて参加させておく
async function summonBot(): Promise<void> {
  await handleVoiceStateUpdate(voiceState("u-summoner", null), voiceState("u-summoner", "vc-1"));
}

test("設定がなければ登録できるモードで動く", () => {
  assert.equal(resolveJoinSoundEnabled(undefined), true);
  assert.equal(resolveJoinSoundEnabled(""), true);
  assert.equal(resolveJoinSoundEnabled("true"), true);
  assert.equal(resolveJoinSoundEnabled("FALSE"), false);
  assert.equal(resolveJoinSoundEnabled(" false "), false);
});

test("true/false以外の指定は起動時に弾く", () => {
  assert.throws(() => resolveJoinSoundEnabled("0"), /true または false/);
  assert.throws(() => resolveJoinSoundEnabled("no"), /true または false/);
});

test("登録できないモードでは音声を添付しても登録しない", async () => {
  const userId = "u-disabled-register";
  await summonBot();
  const replies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  // 受け付けない添付をダウンロードしていないことも確かめる
  globalThis.fetch = async () => {
    throw new Error("添付をダウンロードしてはいけない");
  };
  try {
    await handleMessage(
      createMessage(`<@${botId}>`, userId, async (payload) => replies.push(payload), {
        name: "tone.wav",
        contentType: "audio/wav",
        size: 1024,
        url: "https://example.invalid/tone.wav",
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(existsSync(soundPath(userId)), false);
  assert.equal(replies.length, 1);
  assert.match(String(replies[0]), /登録・再生しない設定/);
});

test("登録できないモードの使い方には登録の案内を出さない", async () => {
  await summonBot();
  const replies: unknown[] = [];

  await handleMessage(
    createMessage(`<@${botId}>`, "u-disabled-usage", async (payload) =>
      replies.push(payload),
    ),
  );

  assert.equal(replies.length, 1);
  assert.match(String(replies[0]), /^使い方:/);
  assert.doesNotMatch(String(replies[0]), /音声ファイル  自分の入室音を登録/);
  assert.match(String(replies[0]), /登録・再生しない設定/);
});

test("登録済みでも登録できないモードでは鳴らさず読み上げる", async () => {
  const userId = "u-disabled-registered";
  const path = soundPath(userId);
  await writeFile(path, "ogg");
  cleanupPaths.push(path);

  await handleVoiceStateUpdate(voiceState(userId, null), voiceState(userId, "vc-1"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(played, [StreamType.Arbitrary], "登録音ではなく読み上げが鳴る");
  assert.deepEqual(synthesized, ["join:アステル"]);
  // モードを戻せばまた鳴るよう、登録済みの音声は消さずに残す
  assert.equal(existsSync(path), true);
});

test("登録できないモードでも登録済みの音声は確認・削除できる", async () => {
  const userId = "u-disabled-check";
  const path = soundPath(userId);
  await writeFile(path, "ogg");
  cleanupPaths.push(path);

  await summonBot();
  const replies: unknown[] = [];
  const push = async (payload: unknown) => replies.push(payload);
  await handleMessage(createMessage(`<@${botId}> check`, userId, push));
  await handleMessage(createMessage(`<@${botId}> delete`, userId, push));

  assert.equal(replies.length, 2);
  const check = replies[0] as { content: string; files: unknown[] };
  assert.match(check.content, /登録されている入室音です。/);
  assert.match(check.content, /登録・再生しない設定/);
  assert.equal(check.files.length, 1);
  assert.match(String((replies[1] as { content: string }).content), /削除しました/);
  assert.equal(existsSync(path), false, "delete は登録できないモードでも効く");
});
