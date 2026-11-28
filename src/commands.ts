import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionReplyOptions,
} from "discord.js";
import { readChannels, writeChannels } from "./chat.js";
import {
  readSpeakers,
  readTriggers,
  voiceTranslation,
  writeSpeakers,
  writeTriggers,
  type Speakers,
} from "./k2j.js";
import { LANG_NAMES, otherLang, type Lang } from "./translator.js";
import { hasSessionInGuild } from "./voice.js";
import {
  MAX_READING_LENGTH,
  MAX_WORD_LENGTH,
  normalizeWord,
  readDict,
  writeDict,
} from "./yomi.js";

// 一覧に使える文字数。2000文字の上限から、コードブロックと前後の文の分を引いた目安
const MAX_LIST_CHARS = 1800;

// コマンドの結果は、実行した本人にだけ見える一時メッセージで返す。
// 登録や一覧のたびに、通話中のみんなのチャットへ Bot の返信が流れないようにする
async function replyPrivately(
  interaction: ChatInputCommandInteraction,
  reply: string | Omit<InteractionReplyOptions, "flags">,
): Promise<void> {
  const options = typeof reply === "string" ? { content: reply } : reply;
  await interaction.reply({ ...options, flags: MessageFlags.Ephemeral });
}

export const commands = [
  new SlashCommandBuilder()
    .setName("yomi")
    .setDescription("入退室の読み上げで読み間違えられる名前の読み方を設定します")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("読み方を登録します（登録済みなら上書き）")
        .addStringOption((option) =>
          option
            .setName("word")
            .setDescription("読み間違えられる単語（表示名の一部でも可）")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(MAX_WORD_LENGTH),
        )
        .addStringOption((option) =>
          option
            .setName("reading")
            .setDescription("実際の読み方（ひらがな・カタカナ）")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(MAX_READING_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("登録した読み方を削除します")
        .addStringOption((option) =>
          option
            .setName("word")
            .setDescription("削除する単語")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(MAX_WORD_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("登録されている読み方の一覧を表示します"),
    ),
  // Discord 標準の /tts や、読み方の /yomi と紛らわしくならない名前にする
  new SlashCommandBuilder()
    .setName("shaberu-ch")
    .setDescription("VC 付属チャット以外で、チャットを読み上げるチャンネルを設定します")
    .addSubcommand((sub) =>
      sub.setName("add").setDescription("このチャンネルのチャットを読み上げます"),
    )
    .addSubcommand((sub) =>
      sub.setName("remove").setDescription("このチャンネルのチャットを読み上げないようにします"),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("読み上げるチャンネルの一覧を表示します"),
    ),
  new SlashCommandBuilder()
    .setName("k2j")
    .setDescription("VC で話者の発話を韓国語⇔日本語に訳して字幕にします")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("翻訳する話者として指定します")
        .addUserOption((option) =>
          option.setName("user").setDescription("指定する人").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("lang")
            .setDescription("その人が話す言語（省略すると韓国語）")
            .addChoices(
              { name: "韓国語（日本語に訳す）", value: "ko" },
              { name: "日本語（韓国語に訳す）", value: "ja" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("話者の指定を外します")
        .addUserOption((option) =>
          option.setName("user").setDescription("指定を外す人").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("trigger-add")
        .setDescription(
          "字幕の条件にする人を足します（条件の人の誰かが Bot と同じ通話にいるときだけ字幕を出す）",
        )
        .addUserOption((option) =>
          option.setName("user").setDescription("字幕の条件にする人").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("trigger-remove")
        .setDescription("字幕の条件から外します")
        .addUserOption((option) =>
          option.setName("user").setDescription("字幕の条件から外す人").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("話者と字幕の条件にしている人の一覧を表示します"),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("音声翻訳の設定と処理した件数を表示します"),
    ),
].map((command) => command.toJSON());

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  // Bot が通話にいないときはチャットに何も書き込まないので、コマンドも実行しない。
  // 応答しないと Discord が本人にエラーを見せるため、本人にだけ見える一時メッセージで断る。
  // コマンドは 1 体目の Bot にだけ登録するので、どの Bot が通話にいても受け付ける
  if (!interaction.guildId || !hasSessionInGuild(interaction.guildId)) {
    await replyPrivately(interaction, "Bot が通話に参加していないときは使えません。");
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (interaction.commandName === "k2j") {
    if (subcommand === "add") {
      await addSpeaker(interaction);
    } else if (subcommand === "remove") {
      await removeSpeaker(interaction);
    } else if (subcommand === "trigger-add") {
      await addTrigger(interaction);
    } else if (subcommand === "trigger-remove") {
      await removeTrigger(interaction);
    } else if (subcommand === "list") {
      await listSpeakers(interaction);
    } else if (subcommand === "status") {
      await showK2jStatus(interaction);
    }
    return;
  }
  if (interaction.commandName === "shaberu-ch") {
    if (subcommand === "add") {
      await addChannel(interaction);
    } else if (subcommand === "remove") {
      await removeChannel(interaction);
    } else if (subcommand === "list") {
      await listChannels(interaction);
    }
    return;
  }
  if (interaction.commandName !== "yomi") return;

  if (subcommand === "set") {
    await setYomi(interaction);
  } else if (subcommand === "delete") {
    await deleteYomi(interaction);
  } else if (subcommand === "list") {
    await listYomi(interaction);
  }
}

async function setYomi(interaction: ChatInputCommandInteraction): Promise<void> {
  const word = normalizeWord(interaction.options.getString("word", true));
  // 改行を含めて空白は 1 つにまとめる。読み上げに使うだけなので改行に意味はない
  const reading = interaction.options
    .getString("reading", true)
    .replace(/\s+/g, " ")
    .trim();
  if (word === "" || reading === "") {
    await replyPrivately(interaction, "単語と読み方の両方を入力してください。");
    return;
  }

  const dict = readDict();
  dict[word] = reading;
  await writeDict(dict);
  await replyPrivately(interaction, `「${word}」を「${reading}」と読むようにしました。`);
}

async function deleteYomi(interaction: ChatInputCommandInteraction): Promise<void> {
  const word = normalizeWord(interaction.options.getString("word", true));

  const dict = readDict();
  if (!(word in dict)) {
    await replyPrivately(interaction, `「${word}」の読み方は登録されていません。`);
    return;
  }
  delete dict[word];
  await writeDict(dict);
  await replyPrivately(interaction, `「${word}」の読み方を削除しました。`);
}

async function listYomi(interaction: ChatInputCommandInteraction): Promise<void> {
  const dict = readDict();
  const entries = Object.entries(dict);
  if (entries.length === 0) {
    await replyPrivately(interaction, "読み方はまだ登録されていません。");
    return;
  }

  // 長い単語から順に当てはめるので、実際に効く順で並べる
  const lines = entries
    .sort(([a], [b]) => b.length - a.length)
    .map(([word, reading]) => `${word} → ${reading}`);

  // Discord のメッセージは2000文字まで。超えると送信自体が失敗して一覧を出せなくなる
  const shown: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > MAX_LIST_CHARS) break;
    shown.push(line);
    length += line.length + 1;
  }
  const omitted = lines.length - shown.length;

  await replyPrivately(
    interaction,
    `登録されている読み方:\n\`\`\`\n${shown.join("\n")}\n\`\`\`` +
      (omitted > 0 ? `ほか ${omitted} 件は長さの都合で省略しました。` : ""),
  );
}

async function addChannel(interaction: ChatInputCommandInteraction): Promise<void> {
  const channels = readChannels();
  if (channels.includes(interaction.channelId)) {
    await replyPrivately(interaction, "このチャンネルはすでに読み上げる設定です。");
    return;
  }
  await writeChannels([...channels, interaction.channelId]);
  await replyPrivately(
    interaction,
    "このチャンネルのチャットを読み上げるようにしました（Bot が通話に参加している間だけ）。",
  );
}

async function removeChannel(interaction: ChatInputCommandInteraction): Promise<void> {
  const channels = readChannels();
  if (!channels.includes(interaction.channelId)) {
    await replyPrivately(interaction, "このチャンネルは読み上げる設定になっていません。");
    return;
  }
  await writeChannels(channels.filter((id) => id !== interaction.channelId));
  await replyPrivately(interaction, "このチャンネルのチャットを読み上げないようにしました。");
}

async function listChannels(interaction: ChatInputCommandInteraction): Promise<void> {
  // 一覧は全サーバー共通なので、実行したサーバーのチャンネルだけ見せる
  const channels = readChannels().filter((id) =>
    interaction.guild?.channels.cache.has(id),
  );
  if (channels.length === 0) {
    await replyPrivately(
      interaction,
      "読み上げるチャンネルは登録されていません（Bot が参加中の VC 付属チャットは登録なしで読み上げます）。",
    );
    return;
  }
  await replyPrivately(
    interaction,
    `読み上げるチャンネル:\n${channels.map((id) => `<#${id}>`).join("\n")}`,
  );
}

// 話者の名前はメンションで見せるが、通知は飛ばさない
const NO_MENTIONS = { parse: [] };

function speakerCounts(speakers: Speakers): string {
  const ids = Object.values(speakers);
  const ko = ids.filter((lang) => lang === "ko").length;
  return `韓国語話者 ${ko} 人 / 日本語話者 ${ids.length - ko} 人`;
}

// 字幕の条件にしている人がいないと字幕は出ないので、話者を指定したときや一覧でそう伝える
const NO_TRIGGERS =
  "字幕の条件にしている人がいないので、字幕は出しません（`/k2j trigger-add` で指定）。";

async function addSpeaker(interaction: ChatInputCommandInteraction): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const lang = (interaction.options.getString("lang") ?? "ko") as Lang;
  if (user.bot) {
    await replyPrivately(interaction, "Bot は話者に指定できません。");
    return;
  }
  const speakers = readSpeakers();
  const previous = speakers[user.id];
  if (previous === lang) {
    await replyPrivately(interaction, {
      content: `<@${user.id}> はすでに${LANG_NAMES[lang]}話者です。`,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  // 1 人に 1 言語なので、別の言語で指定していたら置き換える
  speakers[user.id] = lang;
  await writeSpeakers(speakers);
  const changed = previous ? `（${LANG_NAMES[previous]}話者から変更）` : "";
  await replyPrivately(interaction, {
    content:
      `<@${user.id}> を${LANG_NAMES[lang]}話者にしました${changed}。` +
      `Bot がいる通話での発話を${LANG_NAMES[otherLang(lang)]}の字幕にします。\n` +
      `現在: ${speakerCounts(speakers)}` +
      (readTriggers().length === 0 ? `\n${NO_TRIGGERS}` : ""),
    allowedMentions: NO_MENTIONS,
  });
}

async function removeSpeaker(interaction: ChatInputCommandInteraction): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const speakers = readSpeakers();
  if (!speakers[user.id]) {
    await replyPrivately(interaction, {
      content: `<@${user.id}> は話者に指定されていません。`,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  delete speakers[user.id];
  await writeSpeakers(speakers);
  await replyPrivately(interaction, {
    content: `<@${user.id}> の指定を外しました（現在: ${speakerCounts(speakers)}）。`,
    allowedMentions: NO_MENTIONS,
  });
}

async function listSpeakers(interaction: ChatInputCommandInteraction): Promise<void> {
  // 一覧は全サーバー共通。ほかのサーバーの人も混ざるが、メンバーの一覧は取れないので絞らない
  const speakers = Object.entries(readSpeakers());
  const section = (lang: Lang) => {
    const ids = speakers.filter(([, l]) => l === lang).map(([id]) => id);
    return ids.length === 0
      ? []
      : [
          `${LANG_NAMES[lang]}話者 → ${LANG_NAMES[otherLang(lang)]}（${ids.length} 人）:`,
          ...ids.map((id) => `- <@${id}>`),
        ];
  };
  const lines = [...section("ko"), ...section("ja")];
  if (lines.length === 0) lines.push("話者はまだ指定されていません。");
  const triggers = readTriggers();
  lines.push(
    ...(triggers.length === 0
      ? [NO_TRIGGERS]
      : [
          `字幕の条件（誰かが Bot と同じ通話にいるときだけ字幕を出す、${triggers.length} 人）:`,
          ...triggers.map((id) => `- <@${id}>`),
        ]),
  );
  // /yomi list と同じく、2000 文字の上限に収まるところまで出す
  const shown: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > MAX_LIST_CHARS) break;
    shown.push(line);
    length += line.length + 1;
  }
  const omitted = lines.length - shown.length;
  await replyPrivately(interaction, {
    content:
      shown.join("\n") + (omitted > 0 ? `\nほか ${omitted} 行は長さの都合で省略しました。` : ""),
    allowedMentions: NO_MENTIONS,
  });
}

async function addTrigger(interaction: ChatInputCommandInteraction): Promise<void> {
  const user = interaction.options.getUser("user", true);
  if (user.bot) {
    await replyPrivately(interaction, "Bot は字幕の条件にできません。");
    return;
  }
  const triggers = readTriggers();
  if (triggers.includes(user.id)) {
    await replyPrivately(interaction, {
      content: `<@${user.id}> はすでに字幕の条件にしています。`,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  triggers.push(user.id);
  await writeTriggers(triggers);
  await replyPrivately(interaction, {
    content:
      `<@${user.id}> を字幕の条件にしました。` +
      `条件にした人の誰かが Bot と同じ通話にいるときだけ字幕を出します（現在 ${triggers.length} 人）。`,
    allowedMentions: NO_MENTIONS,
  });
}

async function removeTrigger(interaction: ChatInputCommandInteraction): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const triggers = readTriggers();
  if (!triggers.includes(user.id)) {
    await replyPrivately(interaction, {
      content: `<@${user.id}> は字幕の条件にしていません。`,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  const rest = triggers.filter((id) => id !== user.id);
  await writeTriggers(rest);
  await replyPrivately(interaction, {
    content:
      `<@${user.id}> を字幕の条件から外しました（現在 ${rest.length} 人）。` +
      (rest.length === 0 ? `\n${NO_TRIGGERS}` : ""),
    allowedMentions: NO_MENTIONS,
  });
}

async function showK2jStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const active = voiceTranslation();
  if (!active) {
    await replyPrivately(
      interaction,
      "VC の音声翻訳は止まっています（`.env` に OPENAI_API_KEY と翻訳エンジンの API キーが必要です）。",
    );
    return;
  }
  // DeepL の使用量を問い合わせる間に応答の期限（3 秒）を過ぎないよう、先に受け付けておく
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { pipeline, sttModel } = active;
  const stats = pipeline.statsFor(interaction.guildId ?? "");
  const triggers = readTriggers().length;
  const lines = [
    `翻訳: ${pipeline.translator.name} / 文字起こし: OpenAI (${sttModel})`,
    `話者: ${speakerCounts(readSpeakers())}`,
    `字幕の条件: ${triggers === 0 ? "なし（字幕は出しません）" : `${triggers} 人`}`,
    `このサーバー: 字幕 ${stats.processed} 件 / 捨てた発話 ${stats.dropped} 件 / 失敗 ${stats.errors} 件` +
      (stats.lastLatencyMs !== null
        ? ` / 直近の遅延 ${(stats.lastLatencyMs / 1000).toFixed(1)} 秒`
        : ""),
  ];
  const usage = await pipeline.translator.usage?.();
  if (usage) lines.push(usage);
  await interaction.editReply(lines.join("\n"));
}
