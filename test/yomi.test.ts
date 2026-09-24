import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach, mock } from "node:test";
import type { Interaction } from "discord.js";
import { soundsDir } from "../src/sounds.ts";
import { applyYomi, readDict, writeDict } from "../src/yomi.ts";

// Bot が通話にいないときはコマンドを受け付けないので、通話中として扱う。
// 通話にいないときの動きは chat.test.ts で確かめている
mock.module("../src/voice.ts", {
  namedExports: {
    getSession: () => ({ channelId: "vc-1" }),
    enqueueText: () => {},
  },
});
const { handleInteraction } = await import("../src/commands.ts");

// 辞書は sounds/yomi.json ひとつを共有するため、ファイルを触るテストは
// この 1 ファイルにまとめて、テストごとに消す（node:test はファイル内では直列に走る）
const dictPath = join(soundsDir, "yomi.json");

afterEach(async () => {
  await unlink(dictPath).catch(() => {});
});

// スラッシュコマンドを処理させて返信を返す
async function runCommand(
  subcommand: string,
  options: Record<string, string> = {},
): Promise<string[]> {
  const replies: string[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    commandName: "yomi",
    guildId: "test-guild",
    options: {
      getSubcommand: () => subcommand,
      getString: (name: string) => options[name] ?? null,
    },
    reply: async (content: string) => {
      replies.push(content);
    },
  } as unknown as Interaction;

  await handleInteraction(interaction);
  return replies;
}

test("読みが未登録なら表示名のまま読み上げる", () => {
  assert.equal(applyYomi("mame", {}), "mame");
});

test("表示名そのものが登録されていれば置き換える", () => {
  assert.equal(applyYomi("mame", { mame: "まめ" }), "まめ");
});

test("表示名の一部でも置き換える", () => {
  assert.equal(applyYomi("mamesan", { mame: "まめ" }), "まめsan");
  assert.equal(applyYomi("super mame", { mame: "まめ" }), "super まめ");
});

test("同じ位置に複数当てはまるときは長い単語を優先する", () => {
  const dict = { mame: "まめ", mamesan: "まめさん" };

  assert.equal(applyYomi("mamesan", dict), "まめさん");
  assert.equal(applyYomi("mame", dict), "まめ");
});

test("表示名の大文字小文字は区別せずに置き換える", () => {
  assert.equal(applyYomi("Mame", { mame: "まめ" }), "まめ");
  assert.equal(applyYomi("MAMESAN", { mame: "まめ" }), "まめSAN");
});

test("正規表現の記号を含む単語でも壊れない", () => {
  assert.equal(applyYomi("a.b", { "a.b": "えーびー" }), "えーびー");
  // ドットが「任意の1文字」として扱われていれば axb も置き換わってしまう
  assert.equal(applyYomi("axb", { "a.b": "えーびー" }), "axb");
});

test("複数の単語をまとめて置き換える", () => {
  assert.equal(
    applyYomi("mame_neko", { mame: "まめ", neko: "ねこ" }),
    "まめ_ねこ",
  );
});

test("辞書を書いて読み直せる", async () => {
  await writeDict({ mame: "まめ" });

  assert.deepEqual(readDict(), { mame: "まめ" });
});

test("辞書が壊れていても空として扱う", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  await writeFile(dictPath, "{ this is not json");
  try {
    assert.deepEqual(readDict(), {});
  } finally {
    console.error = originalConsoleError;
  }
});

test("setで読み方を登録する", async () => {
  const replies = await runCommand("set", { word: "mame", reading: "まめ" });

  assert.deepEqual(replies, ["「mame」を「まめ」と読むようにしました。"]);
  assert.deepEqual(readDict(), { mame: "まめ" });
});

test("setは登録済みの読み方を上書きする", async () => {
  await runCommand("set", { word: "mame", reading: "めいむ" });
  await runCommand("set", { word: "mame", reading: "まめ" });

  assert.deepEqual(readDict(), { mame: "まめ" });
});

test("単語は小文字にそろえて登録する", async () => {
  await runCommand("set", { word: "MaMe", reading: "まめ" });

  assert.deepEqual(readDict(), { mame: "まめ" }, "大文字違いで二重登録しない");
});

test("deleteで読み方を削除する", async () => {
  await runCommand("set", { word: "mame", reading: "まめ" });

  const replies = await runCommand("delete", { word: "mame" });

  assert.deepEqual(replies, ["「mame」の読み方を削除しました。"]);
  assert.deepEqual(readDict(), {});
});

test("未登録の単語は削除できない", async () => {
  const replies = await runCommand("delete", { word: "mame" });

  assert.deepEqual(replies, ["「mame」の読み方は登録されていません。"]);
  assert.equal(existsSync(dictPath), false, "書き込まない");
});

test("listで登録されている読み方を長い順に返す", async () => {
  await runCommand("set", { word: "mame", reading: "まめ" });
  await runCommand("set", { word: "mamesan", reading: "まめさん" });

  const replies = await runCommand("list");

  assert.deepEqual(replies, [
    "登録されている読み方:\n```\nmamesan → まめさん\nmame → まめ\n```",
  ]);
});

test("listは未登録ならその旨を返す", async () => {
  assert.deepEqual(await runCommand("list"), ["読み方はまだ登録されていません。"]);
});

test("長すぎる一覧は省略して送る", async () => {
  // 1 行あたり約 70 文字なので、2000 文字の上限を確実に超える件数を登録する
  const dict = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`word${i}`.padEnd(32, "x"), "よみ"]),
  );
  await writeDict(dict);

  const replies = await runCommand("list");

  assert.ok(replies[0].length <= 2000, `got ${replies[0].length} chars`);
  assert.match(replies[0], /ほか \d+ 件は長さの都合で省略しました。$/);
});
