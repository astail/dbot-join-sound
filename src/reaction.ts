import {
  DiscordAPIError,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  Routes,
  type APIMessage,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { LANG_NAMES, type Lang, type Translator } from "./translator.js";
import type { TranslationIndex } from "./translations.js";

const MAX_MESSAGE_LENGTH = 2000;
const LANG_FLAGS: Record<Lang, string> = { ko: "🇰🇷", ja: "🇯🇵" };
// 付け外しの行き違いを見分けるため、リアクションを付けた記録を残しておく時間
const RECENT_ADD_MS = 60_000;

const DEFAULT_MAX_CHARS = 1000;
// Discord のメッセージの上限（Nitro で 4000 字）。これより長い本文は来ない
const MAX_MAX_CHARS = 4000;
const DEFAULT_RATE_PER_MIN = 10;

export function resolveMaxChars(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_CHARS;

  const chars = Number(value);
  if (!Number.isInteger(chars) || chars < 1 || chars > MAX_MAX_CHARS) {
    throw new Error(
      `REACTION_MAX_CHARS は 1 以上 ${MAX_MAX_CHARS} 以下の整数で指定してください`,
    );
  }
  return chars;
}

export function resolveRatePerMin(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_RATE_PER_MIN;

  const rate = Number(value);
  if (!Number.isInteger(rate) || rate < 0) {
    throw new Error("REACTION_RATE_PER_MIN は 0 以上の整数で指定してください（0 で無制限）");
  }
  return rate;
}

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
// カスタム絵文字・メンション・URL。訳す文字として数えない
const NON_TEXT_TOKEN = /<a?:\w+:\d+>|<(?:[@#]|@!|@&)\d+>|https?:\/\/\S+/g;

/**
 * 文字種から韓国語か日本語かを決める。ハングルだけなら ko、仮名だけなら ja。
 * 両方ある・漢字だけ・英語などで決められなければ null
 */
export function guessLang(text: string): Lang | null {
  const ko = HANGUL.test(text);
  const ja = KANA.test(text);
  if (ko === ja) return null;
  return ko ? "ko" : "ja";
}

// to の言語へ訳す意味があるか。すでに to の言語か、訳す文字がなければ false
export function needsTranslation(text: string, to: Lang): boolean {
  const body = text.replace(NON_TEXT_TOKEN, "");
  if (!/\p{L}/u.test(body)) return false;
  return guessLang(body) !== to;
}

// リアクションの絵文字に対応する訳先の言語。国旗でなければ null
export function emojiLang(emoji: { name: string | null }): Lang | null {
  if (emoji.name === LANG_FLAGS.ko) return "ko";
  if (emoji.name === LANG_FLAGS.ja) return "ja";
  return null;
}

// 文字（コードポイント）単位で切り詰める。絵文字のサロゲートペアを分けない
export function truncateChars(text: string, max: number): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  return chars.length > max
    ? { text: chars.slice(0, max).join(""), truncated: true }
    : { text, truncated: false };
}

/**
 * 翻訳メッセージの本文。Discord の上限に収まるよう訳文を切り詰める。
 * partial は元の本文が長すぎて先頭だけを訳したことを示す
 */
export function formatTranslation(translated: string, lang: Lang, partial = false): string {
  const footer = `\n-# ${LANG_FLAGS[lang]} ${LANG_NAMES[lang]}訳${partial ? "（先頭のみ）" : ""}`;
  const max = MAX_MESSAGE_LENGTH - footer.length;
  if (translated.length <= max) return translated + footer;
  // 上限は UTF-16 の長さで数え、切る位置はコードポイント単位にする（「…」の 1 文字分を残す）
  let body = "";
  for (const ch of translated) {
    if (body.length + ch.length > max - 1) break;
    body += ch;
  }
  return `${body}…${footer}`;
}

// キーごとに直近 windowMs の回数を数える（メモリ上）。limit が 0 なら制限しない
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  // 枠が残っていれば 1 回分使って true、使い切っていれば false
  tryTake(key: string, now = Date.now()): boolean {
    if (this.limit === 0) return true;
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const ok = recent.length < this.limit;
    if (ok) recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(now);
    return ok;
  }

  private sweep(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}

// 元の本文。転送されたメッセージは本文が空なので、転送元の本文を使う
function sourceText(message: Message): string {
  return (message.content || message.messageSnapshots.first()?.content || "").trim();
}

// 対象のメッセージ（またはチャンネル）がもうない
function isGone(err: unknown): boolean {
  return (
    err instanceof DiscordAPIError &&
    (err.code === RESTJSONErrorCodes.UnknownMessage ||
      err.code === RESTJSONErrorCodes.UnknownChannel)
  );
}

function logError(what: string) {
  return (err: unknown) => console.error(`reaction translation: ${what}:`, err);
}

type Job = {
  // reaction: リアクションが全部外れた（付け直されたら取り消しをやめる）/ deleted: 元の発言が消えた
  cancel: "reaction" | "deleted" | null;
};

export type ReactionTranslatorOptions = { maxChars: number; ratePerMin: number };

/**
 * テキストチャットで国旗のリアクションが付いた発言を翻訳して返信する。
 * - 🇰🇷 なら韓国語へ、🇯🇵 なら日本語へ
 * - 元の発言が消えた・その国旗が全部外れたら翻訳も消す
 * - 元の発言が編集されたら翻訳も直す
 * Bot が通話にいないときも動く（チャットに書き込まない決まりの例外）。
 */
export class ReactionTranslator {
  // 処理中の翻訳（`${messageId}:${lang}`）。取り消されたら投稿しない・投稿後に消す
  private readonly pending = new Map<string, Job>();
  // リアクションを付けた通し番号（`${messageId}:${lang}` → 最後に付けたとき）。削除の判定との行き違いを見分ける
  private readonly lastAdd = new Map<string, { seq: number; at: number }>();
  private addSeq = 0;
  // 編集中の最新の本文（messageId → 本文）。古い編集の訳文で上書きしないため
  private readonly latestEdit = new Map<string, string>();
  private readonly limiter: RateLimiter;

  constructor(
    private readonly client: Client,
    private readonly translator: Translator,
    private readonly index: TranslationIndex,
    private readonly options: ReactionTranslatorOptions = {
      maxChars: resolveMaxChars(process.env.REACTION_MAX_CHARS),
      ratePerMin: resolveRatePerMin(process.env.REACTION_RATE_PER_MIN),
    },
  ) {
    this.limiter = new RateLimiter(options.ratePerMin, 60_000);
  }

  register(): void {
    const c = this.client;
    c.on(Events.MessageReactionAdd, (reaction, user) => {
      this.onReactionAdd(reaction, user).catch(logError("failed to translate"));
    });
    c.on(Events.MessageReactionRemove, (reaction) => {
      this.onReactionRemove(reaction).catch(logError("failed to handle reaction removal"));
    });
    c.on(Events.MessageReactionRemoveEmoji, (reaction) => {
      this.onReactionRemove(reaction).catch(logError("failed to handle reaction removal"));
    });
    c.on(Events.MessageReactionRemoveAll, (message) => {
      this.deleteTranslations(message, null, "reaction").catch(
        logError("failed to delete translations"),
      );
    });
    c.on(Events.MessageDelete, (message) => {
      this.onMessageDelete(message).catch(logError("failed to delete translations"));
    });
    c.on(Events.MessageBulkDelete, (messages) => {
      for (const message of messages.values()) {
        this.onMessageDelete(message).catch(logError("failed to delete translations"));
      }
    });
    c.on(Events.MessageUpdate, (_old, message) => {
      this.onMessageUpdate(message).catch(logError("failed to update translations"));
    });
  }

  // キャッシュになければ翻訳する（userId の回数を使う）。回数を使い切っていれば null
  private async translate(
    originalId: string,
    text: string,
    to: Lang,
    userId: string,
  ): Promise<string | null> {
    const cached = this.index.cachedTranslation(originalId, to, text);
    if (cached) return cached;
    if (!this.limiter.tryTake(userId)) {
      console.warn(
        `reaction translation: skipped because user ${userId} reached ${this.options.ratePerMin} per minute`,
      );
      return null;
    }
    // 文字種で決められたときだけ元の言語を渡し、英語などは翻訳エンジンの判定に任せる
    const translated = (await this.translator.translate(text, { from: guessLang(text), to })).trim();
    if (translated) this.index.cacheTranslation(originalId, to, text, translated);
    return translated || null;
  }

  private async onReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    const lang = emojiLang(reaction.emoji);
    if (!lang || user.bot) return;
    const key = `${reaction.message.id}:${lang}`;
    this.markAdded(key);
    const running = this.pending.get(key);
    if (running) {
      // 処理中に外して付け直した。取り消しをやめる（元の発言が消えた取り消しはそのまま）
      if (running.cancel === "reaction") running.cancel = null;
      return;
    }
    // このあとの await の間に来た付け外しを扱えるよう、先に処理中として登録する
    const job: Job = { cancel: null };
    this.pending.set(key, job);
    try {
      await this.translateAndPost(reaction, user, lang, job);
    } finally {
      this.pending.delete(key);
    }
  }

  private async translateAndPost(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    lang: Lang,
    job: Job,
  ): Promise<void> {
    if ((user.partial ? await user.fetch() : user).bot) return;
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    // 自分の投稿（翻訳など）は訳さない
    if (!message.inGuild() || message.author.id === this.client.user?.id) return;

    const existing = this.index.get(message.id, lang);
    if (existing) {
      // 翻訳済み。ただし Bot が止まっている間に翻訳が手で消されていたら、対応を忘れて投稿し直す
      const alive = await message.channel.messages
        .fetch(existing.translationId)
        .catch((err: unknown) => {
          if (isGone(err)) return null;
          throw err;
        });
      if (alive) return;
      this.index.forgetTranslation(existing.translationId);
    }

    const full = sourceText(message);
    if (!full || !needsTranslation(full, lang)) return;
    // 投稿できないチャンネルで翻訳の料金だけかからないよう、先に権限を確かめる
    const me = message.guild.members.me ?? this.client.user!;
    const permissions = message.channel.permissionsFor(me);
    const send = message.channel.isThread()
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages;
    if (
      !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        send,
      ])
    ) {
      console.warn(
        `reaction translation: skipped because the bot cannot reply in #${message.channel.name}`,
      );
      return;
    }
    if (job.cancel) return;

    const { text, truncated } = truncateChars(full, this.options.maxChars);
    const translated = await this.translate(message.id, text, lang, user.id);
    if (!translated || job.cancel) return;
    // 翻訳の間に元の発言が消えていたら reply は失敗する（何も残らない）
    const reply = await message.reply({
      content: formatTranslation(translated, lang, truncated),
      allowedMentions: { parse: [], repliedUser: false },
      flags: MessageFlags.SuppressNotifications,
    });
    if (job.cancel) {
      await this.deleteMessage(message.channelId, reply.id);
      return;
    }
    this.index.set(message.id, lang, { translationId: reply.id, sourceText: full });
  }

  private markAdded(key: string): void {
    const now = Date.now();
    this.lastAdd.set(key, { seq: ++this.addSeq, at: now });
    if (this.lastAdd.size > 1_000) {
      for (const [k, v] of this.lastAdd) {
        if (now - v.at > RECENT_ADD_MS) this.lastAdd.delete(k);
      }
    }
  }

  private async onReactionRemove(
    reaction: MessageReaction | PartialMessageReaction,
  ): Promise<void> {
    const lang = emojiLang(reaction.emoji);
    if (!lang) return;
    const { message } = reaction;
    const key = `${message.id}:${lang}`;
    if (!this.index.get(message.id, lang) && !this.pending.has(key)) return;
    // キャッシュ上の件数は一部しか持っていないことがあるので、API から今のリアクションを取り直す
    const seqAtCheck = this.addSeq;
    const data = (await this.client.rest
      .get(Routes.channelMessage(message.channelId, message.id))
      .catch(() => null)) as APIMessage | null;
    if (!data) return; // 元の発言が消えた。MessageDelete の側で消す
    const remaining = (data.reactions ?? []).some(
      (r) => r.count > 0 && emojiLang(r.emoji) === lang,
    );
    // 確かめている間に付け直されたら、取り直した件数は古いかもしれないので消さない
    if (remaining || (this.lastAdd.get(key)?.seq ?? 0) > seqAtCheck) return;
    await this.deleteTranslations(message, lang, "reaction");
  }

  private async onMessageDelete(message: Message | PartialMessage): Promise<void> {
    // 消えたのが翻訳メッセージ自体なら、その対応を忘れる
    this.index.forgetTranslation(message.id);
    await this.deleteTranslations(message, null, "deleted");
  }

  // lang が null なら全言語の翻訳を消す（処理中の翻訳は取り消す）
  private async deleteTranslations(
    message: Message | PartialMessage,
    lang: Lang | null,
    reason: NonNullable<Job["cancel"]>,
  ): Promise<void> {
    const langs: Lang[] = lang ? [lang] : ["ko", "ja"];
    for (const l of langs) {
      const job = this.pending.get(`${message.id}:${l}`);
      if (job && job.cancel !== "deleted") job.cancel = reason;
    }
    const entries = this.index.entries(message.id).filter(([l]) => langs.includes(l));
    await Promise.all(
      entries.map(async ([, entry]) => {
        // 消せた（またはもうない）ときだけ対応を忘れる。失敗したら次の機会にまた消せるよう残す
        if (await this.deleteMessage(message.channelId, entry.translationId)) {
          this.index.forgetTranslation(entry.translationId);
        }
      }),
    );
  }

  // チャンネルのキャッシュに頼らずに消す。消せた・もうないなら true
  private async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    try {
      await this.client.rest.delete(Routes.channelMessage(channelId, messageId));
      return true;
    } catch (err) {
      if (isGone(err)) return true;
      logError("failed to delete translation message")(err);
      return false;
    }
  }

  private async onMessageUpdate(updated: Message | PartialMessage): Promise<void> {
    if (this.index.entries(updated.id).length === 0) return;
    const message = updated.partial ? await updated.fetch() : updated;
    const full = sourceText(message);
    this.latestEdit.set(message.id, full);
    try {
      // リンクの埋め込みが展開されたときなども Update が届くので、本文が変わったときだけ訳し直す
      for (const [lang, entry] of this.index.entries(message.id)) {
        if (entry.sourceText === full) continue;
        await this.updateTranslation(message, lang, entry.translationId, full).catch(
          logError("failed to update translation"),
        );
      }
    } finally {
      if (this.latestEdit.get(message.id) === full) this.latestEdit.delete(message.id);
    }
  }

  private async updateTranslation(
    message: Message,
    lang: Lang,
    translationId: string,
    full: string,
  ): Promise<void> {
    if (!full || !needsTranslation(full, lang)) {
      await this.deleteTranslations(message, lang, "reaction");
      return;
    }
    const { text, truncated } = truncateChars(full, this.options.maxChars);
    const translated = await this.translate(message.id, text, lang, message.author.id);
    if (!translated) return; // 回数を使い切った。本文を記録しないので次の編集でまた訳す
    // 翻訳の間にまた編集された・翻訳が消されたり差し替えられたりしたら、古い訳文で上書きしない
    if (
      this.latestEdit.get(message.id) !== full ||
      this.index.get(message.id, lang)?.translationId !== translationId
    ) {
      return;
    }
    try {
      await this.client.rest.patch(Routes.channelMessage(message.channelId, translationId), {
        body: {
          content: formatTranslation(translated, lang, truncated),
          allowed_mentions: { parse: [], replied_user: false },
        },
      });
    } catch (err) {
      if (isGone(err)) {
        this.index.forgetTranslation(translationId); // 翻訳が手で消されていた
        return;
      }
      throw err;
    }
    // 直せてから本文を記録する（失敗したら次の Update でまた訳す）
    this.index.updateSource(message.id, lang, full);
  }
}
