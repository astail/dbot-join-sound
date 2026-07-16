import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type AudioResource,
} from "@discordjs/voice";
import { ChannelType, type VoiceBasedChannel, type VoiceState } from "discord.js";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { offPath, soundPath } from "./sounds.js";
import { synthesizeJoinNotice } from "./voicevox.js";

const DEFAULT_PLAYBACK_VOLUME = 0.4;
const DEFAULT_VOICEVOX_VOLUME = 0.8;

function resolveVolume(
  value: string | undefined,
  variableName: string,
  defaultVolume: number,
): number {
  if (value === undefined || value.trim() === "") {
    return defaultVolume;
  }

  const volume = Number(value);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new Error(`${variableName} は 0 以上 1 以下の数値で指定してください`);
  }
  return volume;
}

export function resolvePlaybackVolume(value: string | undefined): number {
  return resolveVolume(value, "PLAYBACK_VOLUME", DEFAULT_PLAYBACK_VOLUME);
}

export function resolveVoicevoxVolume(value: string | undefined): number {
  return resolveVolume(value, "VOICEVOX_VOLUME", DEFAULT_VOICEVOX_VOLUME);
}

const playbackVolume = resolvePlaybackVolume(process.env.PLAYBACK_VOLUME);
const voicevoxVolume = resolveVoicevoxVolume(process.env.VOICEVOX_VOLUME);

// 登録済みなら音声ファイル、未登録なら読み上げる表示名
type QueueItem = { path: string } | { displayName: string };

type Session = {
  channelId: string;
  player: AudioPlayer;
  queue: QueueItem[];
  // 音声合成を待つ間も player は Idle のままなので、再入して二重に再生しないための印
  playing: boolean;
  destroyed: boolean;
};

// guildId → Session（Bot が参加中の VC）
const sessions = new Map<string, Session>();

export function getSession(guildId: string): Session | undefined {
  return sessions.get(guildId);
}

export async function joinChannel(
  channel: VoiceBasedChannel,
  initialJoiner?: { id: string; displayName: string | undefined },
): Promise<Session> {
  const guildId = channel.guild.id;
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  const session: Session = {
    channelId: channel.id,
    player,
    queue: [],
    playing: false,
    destroyed: false,
  };
  // Ready を待つ間に別チャンネルへの参加が走らないよう、先にセッションを予約する
  sessions.set(guildId, session);

  player.on(AudioPlayerStatus.Idle, () => void playNext(session));
  player.on("error", (err) => {
    console.error("audio player error:", err.message);
    void playNext(session);
  });

  // リスナーがないと error イベントでプロセスが落ちる
  connection.on("error", (err) => {
    console.error("voice connection error:", err.message);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    // チャンネル移動等でも一時的に Disconnected になるため、少し待って再接続の気配がなければ破棄
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroySession(guildId, session);
    }
  });

  // 最初の入室者は Ready を待つ前にキューへ積む。待機中に後続の入室イベントが
  // enqueue しても到着順が保たれる（Ready までは AutoPaused で再生保留される）
  if (initialJoiner) {
    enqueue(session, initialJoiner.id, initialJoiner.displayName);
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    destroySession(guildId, session);
    throw err;
  }
  return session;
}

function destroySession(guildId: string, expected?: Session): void {
  const session = sessions.get(guildId);
  // 遅延実行される catch からの呼び出しで、後から作られた別セッションを壊さない
  if (expected && session !== expected) return;
  sessions.delete(guildId);
  if (session) {
    session.destroyed = true;
    session.queue.length = 0;
    session.player.stop(true);
  }
  const connection = getVoiceConnection(guildId);
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
    connection.destroy();
  }
}

function enqueue(
  session: Session,
  userId: string,
  displayName: string | undefined,
): void {
  // off にした人は登録音も読み上げも鳴らさないため、分岐より前で弾く
  if (existsSync(offPath(userId))) return;

  const path = soundPath(userId);
  if (existsSync(path)) {
    session.queue.push({ path });
  } else if (displayName) {
    session.queue.push({ displayName });
  } else {
    return; // 未登録で表示名も取れない
  }

  if (session.player.state.status === AudioPlayerStatus.Idle) {
    void playNext(session);
  }
}

// 合成に失敗した項目は飛ばして、次に再生できるものを探す
async function playNext(session: Session): Promise<void> {
  if (session.playing) return;
  session.playing = true;
  try {
    for (let item = session.queue.shift(); item; item = session.queue.shift()) {
      if ("path" in item) {
        session.player.play(createJoinSoundResource(item.path));
        return; // 続きは Idle イベントが呼び出す
      }

      const wav = await synthesizeJoinNotice(item.displayName);
      // 合成を待つ間に全員退出していたら再生しない。購読者のいない player は
      // AutoPaused のままになり、変換中の ffmpeg が終了しなくなる
      if (session.destroyed) return;
      if (!wav) continue;
      session.player.play(createJoinNoticeResource(wav));
      return;
    }
  } catch (err) {
    console.error("failed to play next:", err);
  } finally {
    session.playing = false;
  }
}

export function createJoinSoundResource(
  path: string,
  volume = playbackVolume,
): AudioResource {
  // Opus を一度 PCM に戻して音量を調整するため、opusscript が必要。
  // 入室音は最大8秒なので、変換コストより既存ファイルにも即時適用できることを優先する。
  const resource = createAudioResource(createReadStream(path), {
    inputType: StreamType.OggOpus,
    inlineVolume: true,
  });
  if (!resource.volume) {
    throw new Error("音量調整用のオーディオリソースを作成できませんでした");
  }
  resource.volume.setVolume(volume);
  return resource;
}

export function createJoinNoticeResource(
  wav: Buffer,
  volume = voicevoxVolume,
): AudioResource {
  // VOICEVOX が返すのは 24kHz の WAV。Arbitrary にすると @discordjs/voice が
  // ffmpeg 経由で opus へ変換するため、一時ファイルを作らずに済む
  const resource = createAudioResource(Readable.from(wav), {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });
  if (!resource.volume) {
    throw new Error("音量調整用のオーディオリソースを作成できませんでした");
  }
  resource.volume.setVolume(volume);
  return resource;
}

export async function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
): Promise<void> {
  const guildId = newState.guild.id;

  // Bot 自身: 切断されたらセッション破棄、移動させられたら追従
  if (newState.id === newState.client.user?.id) {
    const session = sessions.get(guildId);
    if (!session) return;
    if (!newState.channelId) {
      destroySession(guildId, session);
      return;
    }
    session.channelId = newState.channelId;
    // 無人チャンネルへ移動させられた場合も「全員退出で即切断」に合わせて抜ける
    const humans =
      newState.channel?.members.filter((m) => !m.user.bot).size ?? 0;
    if (humans === 0) destroySession(guildId, session);
    return;
  }

  if (newState.member?.user.bot) return;
  // ミュート切替・画面共有等ではチャンネルは変わらない
  if (oldState.channelId === newState.channelId) return;

  const session = sessions.get(guildId);

  // Bot のいるチャンネルからの退室: 人間が 0 人になったら即切断（移動先には追従しない）
  if (session && oldState.channelId === session.channelId) {
    const humans =
      oldState.channel?.members.filter((m) => !m.user.bot).size ?? 0;
    if (humans === 0) destroySession(guildId, session);
    return;
  }

  // 入室
  if (!newState.channel) return;
  if (!session) {
    // 未接続なら最初に誰かが入った VC に参加し、本人の入室音も鳴らす
    const channel = newState.channel;
    // ステージ・AFK チャンネル・参加権限がない/満員のチャンネルには入らない
    if (channel.type !== ChannelType.GuildVoice) return;
    if (channel.id === newState.guild.afkChannelId) return;
    if (!channel.joinable) return;
    await joinChannel(channel, {
      id: newState.id,
      displayName: newState.member?.displayName,
    });
  } else if (newState.channelId === session.channelId) {
    enqueue(session, newState.id, newState.member?.displayName);
  }
  // 接続中に別チャンネルへ入った人は無視
}
