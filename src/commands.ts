import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
} from "discord.js";
import {
  MAX_READING_LENGTH,
  MAX_WORD_LENGTH,
  normalizeWord,
  readDict,
  writeDict,
} from "./yomi.js";

// 一覧に使える文字数。2000文字の上限から、コードブロックと前後の文の分を引いた目安
const MAX_LIST_CHARS = 1800;

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
].map((command) => command.toJSON());

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "yomi") return;

  const subcommand = interaction.options.getSubcommand();
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
    await interaction.reply("単語と読み方の両方を入力してください。");
    return;
  }

  const dict = readDict();
  dict[word] = reading;
  await writeDict(dict);
  await interaction.reply(`「${word}」を「${reading}」と読むようにしました。`);
}

async function deleteYomi(interaction: ChatInputCommandInteraction): Promise<void> {
  const word = normalizeWord(interaction.options.getString("word", true));

  const dict = readDict();
  if (!(word in dict)) {
    await interaction.reply(`「${word}」の読み方は登録されていません。`);
    return;
  }
  delete dict[word];
  await writeDict(dict);
  await interaction.reply(`「${word}」の読み方を削除しました。`);
}

async function listYomi(interaction: ChatInputCommandInteraction): Promise<void> {
  const dict = readDict();
  const entries = Object.entries(dict);
  if (entries.length === 0) {
    await interaction.reply("読み方はまだ登録されていません。");
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

  await interaction.reply(
    `登録されている読み方:\n\`\`\`\n${shown.join("\n")}\n\`\`\`` +
      (omitted > 0 ? `ほか ${omitted} 件は長さの都合で省略しました。` : ""),
  );
}
