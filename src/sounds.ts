import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 登録時にトリムする長さ。登録側とフェードイン側の両方が参照するため、
// どちらにも依存しないここに置く
export const MAX_SOUND_SECONDS = 8;

// 入室音の登録と再生をまとめて止めるモード。読み上げだけで運用したいときに
// JOIN_SOUND_ENABLED=false で起動する
export function resolveJoinSoundEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;

  const enabled = value.trim().toLowerCase();
  if (enabled === "true") return true;
  if (enabled === "false") return false;
  throw new Error("JOIN_SOUND_ENABLED は true または false で指定してください");
}

// 登録済みの音声はモードを切り替えても消さずに残すため、true に戻せばまた鳴る
export const joinSoundEnabled = resolveJoinSoundEnabled(
  process.env.JOIN_SOUND_ENABLED,
);

// src/ と dist/ のどちらから実行してもプロジェクトルート直下の sounds/ を指す
export const soundsDir = fileURLToPath(new URL("../sounds/", import.meta.url));

mkdirSync(soundsDir, { recursive: true });

export function soundPath(userId: string): string {
  return join(soundsDir, `${userId}.ogg`);
}

// 「鳴らしてほしくない」ことを示す空ファイル。登録音の有無と同じくファイルの
// 有無で表現し、sounds ボリュームに載せてコンテナを作り直しても保持する
export function offPath(userId: string): string {
  return join(soundsDir, `${userId}.off`);
}
