import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
