import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Message } from "discord.js";
import { handleMessage } from "../src/register.ts";
import { offPath, soundPath, soundsDir } from "../src/sounds.ts";

const botId = "1234567890";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static") as string;

function createMessage(
  content: string,
  userId: string,
  reply: (payload: unknown) => Promise<unknown>,
  attachment?: unknown,
  react?: (emoji: string) => Promise<unknown>,
): Message {
  return {
    author: { bot: false, id: userId },
    inGuild: () => true,
    content,
    client: { user: { id: botId } },
    attachments: { first: () => attachment },
    member: { voice: { channel: null } },
    guildId: "test-guild",
    reply,
    react,
  } as unknown as Message;
}

// ffmpeg の進捗出力（time=00:00:08.00）から実尺を読む。ffmpeg-static に ffprobe は同梱されない
async function readDurationSeconds(path: string): Promise<number> {
  const { stderr } = await execFileAsync(ffmpeg, ["-i", path, "-f", "null", "-"]);
  const last = [...stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)].at(-1);
  if (!last) throw new Error(`duration not found in ffmpeg output: ${stderr}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

// 指定秒数のサイン波を添付として登録させ、Bot の反応と保存された入室音の実尺を返す
async function registerTone(
  userId: string,
  seconds: number,
  react?: (emoji: string) => Promise<unknown>,
): Promise<{ replies: unknown[]; reactions: string[]; duration: number }> {
  const tonePath = join(soundsDir, `tone-${userId}.wav`);
  await execFileAsync(ffmpeg, [
    "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=440:duration=${seconds}`,
    tonePath,
  ]);

  const replies: unknown[] = [];
  const reactions: string[] = [];
  const originalFetch = globalThis.fetch;
  const message = createMessage(
    `<@${botId}>`,
    userId,
    async (payload) => replies.push(payload),
    {
      name: "tone.wav",
      contentType: "audio/wav",
      size: 1024,
      url: "https://example.invalid/tone.wav",
    },
    react ?? (async (emoji) => reactions.push(emoji)),
  );
  globalThis.fetch = async () => new Response(await readFile(tonePath));
  try {
    await handleMessage(message);
    if (!existsSync(soundPath(userId))) {
      throw new Error(`registration failed: ${replies.join(" / ")}`);
    }
    return {
      replies,
      reactions,
      duration: await readDurationSeconds(soundPath(userId)),
    };
  } finally {
    globalThis.fetch = originalFetch;
    await unlink(tonePath).catch(() => {});
    await unlink(soundPath(userId)).catch(() => {});
  }
}

// 任意の添付を登録させ、Bot の返信と入室音が保存されたかを返す
// （後始末で消すため、登録の有無は呼び出し側で existsSync せずこの戻り値で見る）
async function registerAttachment(
  userId: string,
  attachment: unknown,
  body: BodyInit = "",
): Promise<{ replies: unknown[]; registered: boolean }> {
  const replies: unknown[] = [];
  const message = createMessage(
    `<@${botId}>`,
    userId,
    async (payload) => replies.push(payload),
    attachment,
    async () => {},
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body);
  try {
    await handleMessage(message);
    return { replies, registered: existsSync(soundPath(userId)) };
  } finally {
    globalThis.fetch = originalFetch;
    await unlink(soundPath(userId)).catch(() => {});
  }
}

test("checkだけを指定したメンションで登録音を確認する", async () => {
  const replies: unknown[] = [];
  const message = createMessage(
    `<@${botId}> check`,
    "9876543210",
    async (payload) => replies.push(payload),
  );

  await handleMessage(message);

  assert.deepEqual(replies, [
    "入室音は未登録です。音声ファイルを添付してメンションすると登録できます。",
  ]);
});

test("大文字を含むcheckでも登録音を確認する", async () => {
  const replies: unknown[] = [];
  const message = createMessage(
    `<@${botId}> Check`,
    "9876543210",
    async (payload) => replies.push(payload),
  );

  await handleMessage(message);

  assert.deepEqual(replies, [
    "入室音は未登録です。音声ファイルを添付してメンションすると登録できます。",
  ]);
});

test("checkを含む召喚依頼を登録音確認として扱わない", async () => {
  const replies: unknown[] = [];
  const message = createMessage(
    `<@${botId}> check して`,
    "9876543210",
    async (payload) => replies.push(payload),
  );

  await handleMessage(message);

  assert.equal(replies.length, 1);
  assert.match(String(replies[0]), /ボイスチャンネルに入った状態/);
});

test("登録音の添付送信に失敗したらテキストで通知する", async () => {
  const userId = "9876543211";
  const path = soundPath(userId);
  const replies: unknown[] = [];
  const message = createMessage(
    `<@!${botId}> check`,
    userId,
    async (payload) => {
      replies.push(payload);
      if (replies.length === 1) throw new Error("missing ATTACH_FILES");
    },
  );
  const originalConsoleError = console.error;

  await writeFile(path, "test");
  console.error = () => {};
  try {
    await handleMessage(message);
  } finally {
    console.error = originalConsoleError;
    await unlink(path).catch(() => {});
  }

  assert.equal(replies.length, 2);
  assert.equal(replies[1], "入室音の送信に失敗しました。");
});

test("8秒以下の音声は末尾まで登録される", async () => {
  const { duration } = await registerTone("9876543212", 3);

  assert.ok(Math.abs(duration - 3) < 0.5, `expected about 3s, got ${duration}s`);
});

test("8秒を超える音声は冒頭8秒で切り詰められる", async () => {
  const { duration } = await registerTone("9876543213", 12);

  assert.ok(Math.abs(duration - 8) < 0.5, `expected about 8s, got ${duration}s`);
});

test("登録が完了したらリアクションだけを付けて返信しない", async () => {
  const { replies, reactions } = await registerTone("9876543214", 1);

  assert.deepEqual(reactions, ["✅"]);
  assert.deepEqual(replies, []);
});

test("リアクションを付けられなくても登録失敗として扱わない", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  // registerTone は登録済みファイルを確認してから実尺を読むため、戻ること自体が
  // 「リアクションが失敗しても登録は完了している」ことの確認になる
  try {
    const { replies } = await registerTone("9876543215", 1, async () => {
      throw new Error("Missing Permissions");
    });
    assert.deepEqual(replies, []);
  } finally {
    console.error = originalConsoleError;
  }
});

test("登録済みの入室音を添付して返す", async () => {
  const userId = "9876543220";
  const replies: unknown[] = [];
  const message = createMessage(
    `<@${botId}> check`,
    userId,
    async (payload) => replies.push(payload),
  );

  await writeFile(soundPath(userId), "test");
  try {
    await handleMessage(message);
  } finally {
    await unlink(soundPath(userId)).catch(() => {});
  }

  assert.deepEqual(replies, [
    {
      content: "登録されている入室音です。",
      files: [{ attachment: soundPath(userId), name: "join-sound.ogg" }],
    },
  ]);
});

test("音声として認識できない添付は登録しない", async () => {
  const { replies, registered } = await registerAttachment("9876543221", {
    name: "note.txt",
    contentType: "text/plain",
    size: 100,
    url: "https://example.invalid/note.txt",
  });

  assert.deepEqual(replies, [
    "添付ファイルを音声として認識できませんでした。mp3 / wav / ogg などの音声ファイルを添付してください。",
  ]);
  assert.equal(registered, false);
});

test("25MBを超える添付は登録しない", async () => {
  const { replies, registered } = await registerAttachment("9876543222", {
    name: "big.wav",
    contentType: "audio/wav",
    size: 25 * 1024 * 1024 + 1,
    url: "https://example.invalid/big.wav",
  });

  assert.deepEqual(replies, ["ファイルが大きすぎます（25MBまで）。"]);
  assert.equal(registered, false);
});

test("変換できない添付は登録に失敗したと返信する", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const { replies, registered } = await registerAttachment(
      "9876543223",
      {
        name: "broken.wav",
        contentType: "audio/wav",
        size: 1024,
        url: "https://example.invalid/broken.wav",
      },
      "this is not audio",
    );
    assert.deepEqual(replies, ["登録に失敗しました。別の音声ファイルで試してください。"]);
    assert.equal(registered, false);
  } finally {
    console.error = originalConsoleError;
  }
});

test("contentTypeがなくても拡張子が音声なら登録する", async () => {
  const userId = "9876543224";
  const tonePath = join(soundsDir, `tone-${userId}.wav`);
  await execFileAsync(ffmpeg, [
    "-y",
    "-f", "lavfi",
    "-i", "sine=frequency=440:duration=1",
    tonePath,
  ]);

  try {
    const { replies, registered } = await registerAttachment(
      userId,
      { name: "tone.wav", size: 1024, url: "https://example.invalid/tone.wav" },
      await readFile(tonePath),
    );
    assert.equal(registered, true);
    assert.deepEqual(replies, []);
  } finally {
    await unlink(tonePath).catch(() => {});
  }
});

test("deleteで登録音を削除し、削除した音声を添付して返す", async () => {
  const userId = "9876543230";
  const replies: unknown[] = [];
  const message = createMessage(
    `<@${botId}> delete`,
    userId,
    async (payload) => replies.push(payload),
  );

  await writeFile(soundPath(userId), "ogg");
  let stillRegistered = true;
  try {
    await handleMessage(message);
    stillRegistered = existsSync(soundPath(userId));
  } finally {
    await unlink(soundPath(userId)).catch(() => {});
  }

  assert.deepEqual(replies, [
    {
      content:
        "この入室音を削除しました。登録し直すには、この音声を添付してメンションしてください。",
      files: [{ attachment: soundPath(userId), name: "join-sound.ogg" }],
    },
  ]);
  assert.equal(stillRegistered, false, "入室音が削除されていること");
});

test("大文字を含むDeleteでも削除できる", async () => {
  const userId = "9876543231";
  const message = createMessage(`<@${botId}> Delete`, userId, async () => {});

  await writeFile(soundPath(userId), "ogg");
  let stillRegistered = true;
  try {
    await handleMessage(message);
    stillRegistered = existsSync(soundPath(userId));
  } finally {
    await unlink(soundPath(userId)).catch(() => {});
  }

  assert.equal(stillRegistered, false);
});

test("未登録でdeleteしても失敗しない", async () => {
  const replies: unknown[] = [];
  const message = createMessage(
    `<@${botId}> delete`,
    "9876543232",
    async (payload) => replies.push(payload),
  );

  await handleMessage(message);

  assert.deepEqual(replies, [
    "入室音は未登録です。音声ファイルを添付してメンションすると登録できます。",
  ]);
});

test("添付送信に失敗したら削除しない", async () => {
  const userId = "9876543233";
  const replies: unknown[] = [];
  const message = createMessage(
    `<@${botId}> delete`,
    userId,
    async (payload) => {
      replies.push(payload);
      if (replies.length === 1) throw new Error("missing ATTACH_FILES");
    },
  );
  const originalConsoleError = console.error;

  await writeFile(soundPath(userId), "ogg");
  console.error = () => {};
  let stillRegistered = false;
  try {
    await handleMessage(message);
    stillRegistered = existsSync(soundPath(userId));
  } finally {
    console.error = originalConsoleError;
    await unlink(soundPath(userId)).catch(() => {});
  }

  // 送信できないと復元用のコピーが手元に残らないため、削除してはいけない
  assert.equal(stillRegistered, true, "入室音が残っていること");
  assert.equal(replies[1], "入室音の送信に失敗したため、削除していません。");
});

test("delete後にcheckすると未登録として扱われる", async () => {
  const userId = "9876543234";
  const replies: unknown[] = [];
  const reply = async (payload: unknown) => {
    replies.push(payload);
  };

  await writeFile(soundPath(userId), "ogg");
  try {
    await handleMessage(createMessage(`<@${botId}> delete`, userId, reply));
    await handleMessage(createMessage(`<@${botId}> check`, userId, reply));
  } finally {
    await unlink(soundPath(userId)).catch(() => {});
  }

  assert.equal(
    replies[1],
    "入室音は未登録です。音声ファイルを添付してメンションすると登録できます。",
  );
});

// off / on コマンドを送って Bot の返信を得る
async function sendCommand(userId: string, command: string): Promise<unknown[]> {
  const replies: unknown[] = [];
  await handleMessage(
    createMessage(`<@${botId}> ${command}`, userId, async (payload) => {
      replies.push(payload);
    }),
  );
  return replies;
}

test("offで鳴らさない設定になり、登録音は保持される", async () => {
  const userId = "9876543240";
  await writeFile(soundPath(userId), "ogg");
  let marked = false;
  let soundKept = false;
  try {
    const replies = await sendCommand(userId, "off");
    marked = existsSync(offPath(userId));
    soundKept = existsSync(soundPath(userId));
    assert.deepEqual(replies, [
      "入室音と読み上げを鳴らさないようにしました。登録した音声は保持されます。",
    ]);
  } finally {
    await unlink(offPath(userId)).catch(() => {});
    await unlink(soundPath(userId)).catch(() => {});
  }

  assert.equal(marked, true, "off マーカーが作られること");
  assert.equal(soundKept, true, "登録音は消さないこと");
});

test("onで鳴らす設定に戻る", async () => {
  const userId = "9876543241";
  let cleared = true;
  try {
    await sendCommand(userId, "off");
    const replies = await sendCommand(userId, "on");
    cleared = existsSync(offPath(userId));
    assert.deepEqual(replies, ["入室音を鳴らすようにしました。"]);
  } finally {
    await unlink(offPath(userId)).catch(() => {});
  }

  assert.equal(cleared, false, "off マーカーが消えること");
});

test("大文字を含むOff/Onでも動作する", async () => {
  const userId = "9876543242";
  let afterOff = false;
  let afterOn = true;
  try {
    await sendCommand(userId, "Off");
    afterOff = existsSync(offPath(userId));
    await sendCommand(userId, "ON");
    afterOn = existsSync(offPath(userId));
  } finally {
    await unlink(offPath(userId)).catch(() => {});
  }

  assert.equal(afterOff, true);
  assert.equal(afterOn, false);
});

test("すでにoff/onの状態で実行しても失敗せず現在の状態を返す", async () => {
  const userId = "9876543243";
  try {
    await sendCommand(userId, "off");
    const offAgain = await sendCommand(userId, "off");
    assert.deepEqual(offAgain, [
      "すでに鳴らさない設定です。「on」を付けてメンションすると戻ります。",
    ]);

    await sendCommand(userId, "on");
    const onAgain = await sendCommand(userId, "on");
    assert.deepEqual(onAgain, ["すでに鳴らす設定です。"]);
  } finally {
    await unlink(offPath(userId)).catch(() => {});
  }
});

test("off中に登録すると鳴らさない設定が解除される", async () => {
  const userId = "9876543244";
  await writeFile(offPath(userId), "");
  let stillOff = true;
  try {
    const { replies, reactions } = await registerTone(userId, 1);
    stillOff = existsSync(offPath(userId));
    assert.deepEqual(reactions, ["✅"]);
    assert.deepEqual(replies, ["鳴らさない設定を解除しました。"]);
  } finally {
    await unlink(offPath(userId)).catch(() => {});
  }

  assert.equal(stillOff, false, "off が解除されること");
});

test("off中のcheckは鳴らさない設定である旨と保持中の音声を返す", async () => {
  const userId = "9876543245";
  await writeFile(soundPath(userId), "ogg");
  await writeFile(offPath(userId), "");
  const replies: unknown[] = [];
  try {
    await handleMessage(
      createMessage(`<@${botId}> check`, userId, async (p) => {
        replies.push(p);
      }),
    );
  } finally {
    await unlink(offPath(userId)).catch(() => {});
    await unlink(soundPath(userId)).catch(() => {});
  }

  assert.deepEqual(replies, [
    {
      content:
        "鳴らさない設定です。保持されている入室音はこちらです。「on」を付けてメンションすると鳴るようになります。",
      files: [{ attachment: soundPath(userId), name: "join-sound.ogg" }],
    },
  ]);
});

test("未登録でoff中のcheckは未登録かつ鳴らさない設定である旨を返す", async () => {
  const userId = "9876543246";
  await writeFile(offPath(userId), "");
  let replies: unknown[] = [];
  try {
    replies = await sendCommand(userId, "check");
  } finally {
    await unlink(offPath(userId)).catch(() => {});
  }

  assert.deepEqual(replies, [
    "入室音は未登録で、鳴らさない設定です。「on」を付けてメンションすると読み上げが戻ります。",
  ]);
});
