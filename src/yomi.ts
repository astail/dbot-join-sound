import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { soundsDir } from "./sounds.js";

// 単語と読みの上限。Discord の表示名（32文字）に揃える
export const MAX_WORD_LENGTH = 32;
export const MAX_READING_LENGTH = 32;

// 単語 → 読み。サーバーをまたいで共通で、登録音と同じく sounds ボリュームに載せる
export type YomiDict = Record<string, string>;

const dictPath = join(soundsDir, "yomi.json");

// 大文字小文字の違いで登録が二重にならないよう、単語は小文字で持つ。
// ひらがな・カタカナ・漢字には大文字小文字がないので影響しない
export function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

export function readDict(): YomiDict {
  if (!existsSync(dictPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(dictPath, "utf8"));
    // 手で編集して壊れていても Bot を止めない。読み上げが表示名のままに戻るだけ
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("辞書が JSON のオブジェクトではありません");
    }
    // 手で編集されても置き換えが効くよう、読み込む側で単語を小文字にそろえる
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([word, reading]) => typeof reading === "string" && normalizeWord(word) !== "")
        .map(([word, reading]) => [normalizeWord(word), reading]),
    ) as YomiDict;
  } catch (err) {
    console.error("failed to read yomi dictionary:", err);
    return {};
  }
}

export async function writeDict(dict: YomiDict): Promise<void> {
  // 一時ファイルへ書いてから rename で置き換える。途中で落ちても
  // 既存の辞書が丸ごと壊れないようにする（登録音の保存と同じ理由）
  const tmp = `${dictPath}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(dict, null, 2));
  await rename(tmp, dictPath);
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 表示名に登録済みの読みを当てはめる。部分一致で置き換えるので、`mame` を
 * 登録しておけば `mamesan` も「まめsan」として読まれる。
 */
export function applyYomi(displayName: string, dict = readDict()): string {
  // 長い単語を先に並べる。同じ位置で複数当てはまるとき、正規表現は先に書いた
  // 選択肢を採るため、`mame` より `mamesan` を優先できる
  const words = Object.keys(dict).sort((a, b) => b.length - a.length);
  if (words.length === 0) return displayName;

  const pattern = new RegExp(words.map(escapeRegExp).join("|"), "gi");
  return displayName.replace(
    pattern,
    (matched) => dict[matched.toLowerCase()] ?? matched,
  );
}
