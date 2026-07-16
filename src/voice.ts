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
} from "@discordjs/voice";
import { ChannelType, type VoiceBasedChannel, type VoiceState } from "discord.js";
import { createReadStream, existsSync } from "node:fs";
import { soundPath } from "./sounds.js";

type Session = {
  channelId: string;
  player: AudioPlayer;
  queue: string[];
};

// guildId → Session（Bot が参加中の VC）
const sessions = new Map<string, Session>();

export function getSession(guildId: string): Session | undefined {
  return sessions.get(guildId);
}

export async function joinChannel(
  channel: VoiceBasedChannel,
  initialUserId?: string,
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

  const session: Session = { channelId: channel.id, player, queue: [] };
  // Ready を待つ間に別チャンネルへの参加が走らないよう、先にセッションを予約する
  sessions.set(guildId, session);

  player.on(AudioPlayerStatus.Idle, () => playNext(session));
  player.on("error", (err) => {
    console.error("audio player error:", err.message);
    playNext(session);
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
      destroySession(guildId);
    }
  });

  // 最初の入室者は Ready を待つ前にキューへ積む。待機中に後続の入室イベントが
  // enqueue しても到着順が保たれる（Ready までは AutoPaused で再生保留される）
  if (initialUserId) enqueue(session, initialUserId);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    destroySession(guildId);
    throw err;
  }
  return session;
}

function destroySession(guildId: string): void {
  const session = sessions.get(guildId);
  sessions.delete(guildId);
  if (session) {
    session.queue.length = 0;
    session.player.stop(true);
  }
  const connection = getVoiceConnection(guildId);
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
    connection.destroy();
  }
}

function enqueue(session: Session, userId: string): void {
  const path = soundPath(userId);
  if (!existsSync(path)) return; // 未登録ユーザー
  session.queue.push(path);
  if (session.player.state.status === AudioPlayerStatus.Idle) {
    playNext(session);
  }
}

function playNext(session: Session): void {
  const path = session.queue.shift();
  if (!path) return;
  const resource = createAudioResource(createReadStream(path), {
    inputType: StreamType.OggOpus,
  });
  session.player.play(resource);
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
      destroySession(guildId);
    } else {
      session.channelId = newState.channelId;
    }
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
    if (humans === 0) destroySession(guildId);
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
    await joinChannel(channel, newState.id);
  } else if (newState.channelId === session.channelId) {
    enqueue(session, newState.id);
  }
  // 接続中に別チャンネルへ入った人は無視
}
