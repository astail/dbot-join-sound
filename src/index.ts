import { ActivityType, Client, Events, GatewayIntentBits } from "discord.js";
import { handleMessage } from "./register.js";
import { handleVoiceStateUpdate } from "./voice.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN が設定されていません（.env を確認してください）");
  process.exit(1);
}

// イメージのビルド時に埋め込まれる。どのコードが動いているか Discord から確認できる
const commit = process.env.GIT_COMMIT || "unknown";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
  // ClientReady で設定すると再接続のたびに消えるため、IDENTIFY に載せる
  presence: {
    activities: [{ name: commit, type: ActivityType.Custom, state: commit }],
  },
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} (commit: ${commit})`);
});

// リスナーがないと error イベントでプロセスが落ちる
client.on(Events.Error, (err) => {
  console.error("client error:", err);
});

client.on(Events.MessageCreate, (message) => {
  handleMessage(message).catch((err) =>
    console.error("messageCreate handler failed:", err),
  );
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  handleVoiceStateUpdate(oldState, newState).catch((err) =>
    console.error("voiceStateUpdate handler failed:", err),
  );
});

await client.login(token);
