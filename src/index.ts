import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
} from "discord.js";
import { readChatMessage, scheduleVcChatDeletion } from "./chat.js";
import { commands, handleInteraction } from "./commands.js";
import { handleMessage } from "./register.js";
import { handleVoiceStateUpdate } from "./voice.js";
import { assignSpeaker } from "./voicevox.js";

// カンマ区切りで複数指定すると、その数だけ Bot が動く。同時に別々の通話へ入れるように
// するためで、登録音・読み方・読み上げチャンネルはすべての Bot で共通
const tokens = [
  ...new Set(
    (process.env.DISCORD_TOKEN ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token !== ""),
  ),
];
if (tokens.length === 0) {
  console.error("DISCORD_TOKEN が設定されていません（.env を確認してください）");
  process.exit(1);
}

// イメージのビルド時に埋め込まれる。どのコードが動いているか Discord から確認できる
const commit = process.env.GIT_COMMIT || "unknown";

// ギルドごとに登録すると即座に反映される（グローバル登録は反映まで最大1時間かかる）。
// 失敗しても入室音の再生には関係ないので、Bot は止めずにログだけ残す
function registerCommands(guild: Guild): void {
  guild.commands.set(commands).catch((err) => {
    console.error(`failed to register commands for guild ${guild.id}:`, err);
  });
}

function createClient(index: number): Client {
  const registersCommands = index === 0;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      // チャットの読み上げに本文が要る。Developer Portal での有効化が必要な特権 Intent
      GatewayIntentBits.MessageContent,
    ],
    // ClientReady で設定すると再接続のたびに消えるため、IDENTIFY に載せる
    presence: {
      activities: [{ name: commit, type: ActivityType.Custom, state: commit }],
    },
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`Logged in as ${c.user.tag} (commit: ${commit})`);
    assignSpeaker(c.user.id, index);
    if (registersCommands) c.guilds.cache.each(registerCommands);
  });

  // 起動後に招待されたサーバーにも登録する
  if (registersCommands) client.on(Events.GuildCreate, registerCommands);

  // リスナーがないと error イベントでプロセスが落ちる
  client.on(Events.Error, (err) => {
    console.error("client error:", err);
  });

  client.on(Events.MessageCreate, (message) => {
    scheduleVcChatDeletion(message);
    readChatMessage(message);
    handleMessage(message).catch((err) =>
      console.error("messageCreate handler failed:", err),
    );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    handleInteraction(interaction).catch((err) =>
      console.error("interactionCreate handler failed:", err),
    );
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleVoiceStateUpdate(oldState, newState).catch((err) =>
      console.error("voiceStateUpdate handler failed:", err),
    );
  });

  return client;
}

// スラッシュコマンドは 1 体目の Bot にだけ登録する。全員に登録すると、同じコマンドが
// Bot の数だけ候補に並ぶ（設定は共通なので、どの Bot から実行しても結果は同じ）
await Promise.all(
  tokens.map((token, i) => createClient(i).login(token)),
);
