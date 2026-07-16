import { Client, Events, GatewayIntentBits } from "discord.js";
import { handleMessage } from "./register.js";
import { handleVoiceStateUpdate } from "./voice.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN が設定されていません（.env を確認してください）");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
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
