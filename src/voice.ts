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
import { MAX_SOUND_SECONDS, offPath, soundPath } from "./sounds.js";
import { synthesizeNotice, type NoticeKind } from "./voicevox.js";

const DEFAULT_PLAYBACK_VOLUME = 0.4;
const DEFAULT_VOICEVOX_VOLUME = 0.8;
const DEFAULT_ANNOUNCE_DELAY_MS = 500;
// 間の長さとして意味のある範囲は大きく超えているので、秒とミリ秒の取り違えのような
// 明らかな設定ミスだけを弾くための上限
const MAX_ANNOUNCE_DELAY_MS = 5000;
const DEFAULT_FADE_IN_MS = 1000;
// 入室音はトリム上限より長くならないので、これを超えるフェードは鳴り終わるまでに完了しない
const MAX_FADE_IN_MS = MAX_SOUND_SECONDS * 1000;
const FADE_STEP_MS = 50;

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

export function resolveAnnounceDelayMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_ANNOUNCE_DELAY_MS;
  }

  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_ANNOUNCE_DELAY_MS) {
    throw new Error(
      `ANNOUNCE_DELAY_MS は 0 以上 ${MAX_ANNOUNCE_DELAY_MS} 以下のミリ秒で指定してください`,
    );
  }
  return ms;
}

export function resolveFadeInMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_FADE_IN_MS;
  }

  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_FADE_IN_MS) {
    throw new Error(
      `JOIN_SOUND_FADE_IN_MS は 0 以上 ${MAX_FADE_IN_MS} 以下のミリ秒で指定してください`,
    );
  }
  return ms;
}

const playbackVolume = resolvePlaybackVolume(process.env.PLAYBACK_VOLUME);
const voicevoxVolume = resolveVoicevoxVolume(process.env.VOICEVOX_VOLUME);
const defaultFadeInMs = resolveFadeInMs(process.env.JOIN_SOUND_FADE_IN_MS);
const announceDelayMs = resolveAnnounceDelayMs(process.env.ANNOUNCE_DELAY_MS);

// 入室で登録済みなら音声ファイル、それ以外は読み上げる表示名と入退室の別
type QueueItem = { path: string } | { displayName: string; kind: NoticeKind };

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

export function leaveChannel(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  destroySession(guildId, session);
  return true;
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
    enqueue(session, initialJoiner.id, initialJoiner.displayName, "join");
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
  kind: NoticeKind,
): void {
  // off にした人は登録音も読み上げも鳴らさないため、分岐より前で弾く
  if (existsSync(offPath(userId))) return;

  const path = soundPath(userId);
  // 退室は全員共通の読み上げ。登録できるのは入室音だけ
  if (kind === "join" && existsSync(path)) {
    session.queue.push({ path });
  } else if (displayName) {
    session.queue.push({ displayName, kind });
  } else {
    return; // 表示名が取れない
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
      // 入退室の直後にいきなり鳴らさず一拍置く。待ちと合成を並行させるので、合成が
      // 待ちより短いうちは登録音と読み上げで間の長さが揃う（長引けば合成待ちになる）。
      // 0 のときは await しない（1 tick でも遅れると再生順の判定が変わる）。
      // node:timers/promises ではなくグローバルの setTimeout を使うのは、テストから
      // タイマーを差し替えて実時間を待たずに検証できるようにするため
      const pause =
        announceDelayMs > 0
          ? new Promise((resolve) => setTimeout(resolve, announceDelayMs))
          : null;

      if ("path" in item) {
        if (pause) await pause;
        if (session.destroyed) return;
        session.player.play(createJoinSoundResource(item.path));
        return; // 続きは Idle イベントが呼び出す
      }

      const wav = await synthesizeNotice(item.displayName, item.kind);
      if (pause) await pause;
      // 待つ間に全員退出していたら再生しない。購読者のいない player は
      // AutoPaused のままになり、変換中の ffmpeg が終了しなくなる
      if (session.destroyed) return;
      if (!wav) continue;
      session.player.play(createNoticeResource(wav));
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
  fadeInMs = defaultFadeInMs,
): AudioResource {
  // Opus を一度 PCM に戻して音量を調整するため、opusscript が必要。
  // 入室音は最大8秒なので、変換コストより既存ファイルにも即時適用できることを優先する。
  const resource = createAudioResource(createReadStream(path), {
    inputType: StreamType.OggOpus,
    inlineVolume: true,
  });
  const control = resource.volume;
  if (!control) {
    throw new Error("音量調整用のオーディオリソースを作成できませんでした");
  }

  if (fadeInMs === 0) {
    control.setVolume(volume);
    return resource;
  }

  // 突然鳴り出して驚かせないよう、無音から目標音量まで上げていく。経過時間ではなく
  // playbackDuration を見るのは、接続待ちで AutoPaused の間にフェードだけ進むのを防ぐため。
  // playbackDuration は Discord へ送出した時点で進む一方、音量変換はストリームの
  // バッファ分だけ先を処理しているので、実際に聞こえるフェードは指定より少し長くなる
  control.setVolume(0);
  const timer = setInterval(() => {
    const progress = Math.min(resource.playbackDuration / fadeInMs, 1);
    control.setVolume(volume * progress);
    // フェード中に鳴り終わる短い音もあるので、ended でも止める
    if (progress >= 1 || resource.ended) clearInterval(timer);
  }, FADE_STEP_MS);
  // 再生されないまま捨てられたリソースのタイマーがプロセスを起こし続けないようにする
  timer.unref();
  return resource;
}

export function createNoticeResource(
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
    if (humans === 0) {
      destroySession(guildId, session);
      return;
    }
    // 残っている人に向けた退室の読み上げ
    enqueue(session, oldState.id, oldState.member?.displayName, "leave");
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
    enqueue(session, newState.id, newState.member?.displayName, "join");
  }
  // 接続中に別チャンネルへ入った人は無視
}
