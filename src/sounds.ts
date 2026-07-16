import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// src/ と dist/ のどちらから実行してもプロジェクトルート直下の sounds/ を指す
export const soundsDir = fileURLToPath(new URL("../sounds/", import.meta.url));

mkdirSync(soundsDir, { recursive: true });

export function soundPath(userId: string): string {
  return join(soundsDir, `${userId}.ogg`);
}
