import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Lang } from "./translator.js";

export type TranslationEntry = {
  // Bot が投稿した翻訳メッセージの ID
  translationId: string;
  // 翻訳した時点の元の本文。編集で本文が変わったかを見分けるのに使う
  sourceText: string;
};

type Row = { lang: Lang; translation_id: string; source_text: string };

const toEntry = (row: Row): TranslationEntry => ({
  translationId: row.translation_id,
  sourceText: row.source_text,
});

const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * 元の発言 ID → 言語ごとの翻訳メッセージの対応と、訳文のキャッシュ。
 * Bot を再起動しても元の発言の削除や編集に追随できるよう SQLite に保存する。
 * 対応（元の発言×言語の 1 組）が上限を超えたら古いものから忘れる。忘れた翻訳は、
 * 元の発言が消えても残る。キャッシュも同じ上限で古いものから消す。
 */
export class TranslationIndex {
  private readonly db: DatabaseSync;
  private readonly stmt: Record<
    | "get"
    | "entries"
    | "upsert"
    | "updateSource"
    | "remove"
    | "byTranslation"
    | "prune"
    | "cacheGet"
    | "cachePut"
    | "cachePrune",
    StatementSync
  >;

  // path に ":memory:" を渡すとメモリ上だけに持つ（テスト用）
  constructor(
    path: string,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS translations (
        original_id    TEXT    NOT NULL,
        lang           TEXT    NOT NULL,
        translation_id TEXT    NOT NULL UNIQUE,
        source_text    TEXT    NOT NULL,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (original_id, lang)
      );
      CREATE INDEX IF NOT EXISTS translations_created_at ON translations (created_at);
      -- リアクションの付け外しで同じ本文を翻訳し直さないためのキャッシュ
      CREATE TABLE IF NOT EXISTS translation_cache (
        original_id TEXT    NOT NULL,
        lang        TEXT    NOT NULL,
        source_text TEXT    NOT NULL,
        translated  TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (original_id, lang)
      );
      CREATE INDEX IF NOT EXISTS translation_cache_created_at ON translation_cache (created_at);
    `);
    const cols = "lang, translation_id, source_text";
    this.stmt = {
      get: this.db.prepare(`SELECT ${cols} FROM translations WHERE original_id = ? AND lang = ?`),
      entries: this.db.prepare(
        `SELECT ${cols} FROM translations WHERE original_id = ? ORDER BY lang`,
      ),
      upsert: this.db.prepare(
        `INSERT OR REPLACE INTO translations (original_id, lang, translation_id, source_text, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      updateSource: this.db.prepare(
        "UPDATE translations SET source_text = ? WHERE original_id = ? AND lang = ?",
      ),
      remove: this.db.prepare("DELETE FROM translations WHERE original_id = ? AND lang = ?"),
      byTranslation: this.db.prepare(
        "SELECT original_id, lang FROM translations WHERE translation_id = ?",
      ),
      prune: this.db.prepare(
        `DELETE FROM translations WHERE rowid IN (
           SELECT rowid FROM translations ORDER BY created_at, rowid
           LIMIT max(0, (SELECT COUNT(*) FROM translations) - ?))`,
      ),
      cacheGet: this.db.prepare(
        "SELECT translated FROM translation_cache WHERE original_id = ? AND lang = ? AND source_text = ?",
      ),
      cachePut: this.db.prepare(
        `INSERT OR REPLACE INTO translation_cache (original_id, lang, source_text, translated, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      cachePrune: this.db.prepare(
        `DELETE FROM translation_cache WHERE rowid IN (
           SELECT rowid FROM translation_cache ORDER BY created_at, rowid
           LIMIT max(0, (SELECT COUNT(*) FROM translation_cache) - ?))`,
      ),
    };
  }

  get(originalId: string, lang: Lang): TranslationEntry | undefined {
    const row = this.stmt.get.get(originalId, lang) as Row | undefined;
    return row && toEntry(row);
  }

  entries(originalId: string): [Lang, TranslationEntry][] {
    return (this.stmt.entries.all(originalId) as unknown as Row[]).map((row) => [
      row.lang,
      toEntry(row),
    ]);
  }

  set(originalId: string, lang: Lang, entry: TranslationEntry): void {
    this.stmt.upsert.run(originalId, lang, entry.translationId, entry.sourceText, Date.now());
    this.stmt.prune.run(this.maxEntries);
  }

  // 元の発言の編集で翻訳を直したとき、記録しておく元の本文を差し替える
  updateSource(originalId: string, lang: Lang, sourceText: string): void {
    this.stmt.updateSource.run(sourceText, originalId, lang);
  }

  // 翻訳メッセージ自体が消えたとき、その対応を忘れる（付け直せばまた投稿される）
  forgetTranslation(translationId: string): void {
    const ref = this.stmt.byTranslation.get(translationId) as
      | { original_id: string; lang: Lang }
      | undefined;
    if (ref) this.stmt.remove.run(ref.original_id, ref.lang);
  }

  // 同じ本文を同じ言語へ翻訳したことがあれば、その訳文
  cachedTranslation(originalId: string, lang: Lang, sourceText: string): string | undefined {
    const row = this.stmt.cacheGet.get(originalId, lang, sourceText) as
      | { translated: string }
      | undefined;
    return row?.translated;
  }

  cacheTranslation(originalId: string, lang: Lang, sourceText: string, translated: string): void {
    this.stmt.cachePut.run(originalId, lang, sourceText, translated, Date.now());
    this.stmt.cachePrune.run(this.maxEntries);
  }

  close(): void {
    this.db.close();
  }
}
