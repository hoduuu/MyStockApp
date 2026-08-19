import { DatabaseSync } from "node:sqlite";

/**
 * Phase 0 subset of the schema in docs/DESIGN.md §8:
 * articles / event / event_articles / job_runs / llm_usage.
 *
 * Two deliberate omissions, per §0.5 ("the collector must not know about users"):
 * there is no `user_id` anywhere, and no UI state (read/unread, filters).
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id            TEXT PRIMARY KEY,
      url_canonical TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      title_norm    TEXT NOT NULL,
      source        TEXT NOT NULL,
      snippet       TEXT NOT NULL DEFAULT '',
      published_at  TEXT NOT NULL,
      fetched_at    TEXT NOT NULL,
      asset_symbol  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_articles_asset_pub
      ON articles(asset_symbol, published_at DESC);

    CREATE TABLE IF NOT EXISTS events (
      id                TEXT PRIMARY KEY,
      asset_symbol      TEXT NOT NULL,
      title             TEXT NOT NULL,
      summary           TEXT NOT NULL,
      importance        INTEGER NOT NULL,
      category          TEXT NOT NULL,
      certainty         TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'open',
      first_seen_at     TEXT NOT NULL,
      last_updated_at   TEXT NOT NULL,
      followup_count    INTEGER NOT NULL DEFAULT 0,
      importance_reason TEXT NOT NULL DEFAULT '',
      -- 'mock' | 'anthropic'. Which backend wrote this summary, so the brief can
      -- say so rather than passing sample text off as analysis.
      provider          TEXT NOT NULL DEFAULT 'mock',
      embedding         BLOB
    );

    CREATE INDEX IF NOT EXISTS idx_events_asset_seen
      ON events(asset_symbol, first_seen_at DESC);

    CREATE TABLE IF NOT EXISTS event_articles (
      event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      is_primary INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (event_id, article_id)
    );

    -- Tracks every collection attempt so gaps are visible rather than silent.
    -- docs/DESIGN.md §3: "별일 없음" and "수집 실패" must never look alike.
    CREATE TABLE IF NOT EXISTS job_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job          TEXT NOT NULL,
      asset_symbol TEXT,
      started_at   TEXT NOT NULL,
      finished_at  TEXT,
      ok           INTEGER,
      error        TEXT,
      stats_json   TEXT
    );

    -- Small key/value store. Holds last_visit_at, which is what makes
    -- "since you last looked" the app's default window (docs/DESIGN.md §12.3).
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_usage (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                    TEXT NOT NULL,
      job_run_id            INTEGER,
      model                 TEXT NOT NULL,
      asset_symbol          TEXT,
      input_tokens          INTEGER NOT NULL,
      output_tokens         INTEGER NOT NULL,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd              REAL NOT NULL
    );
  `);

  // A database created before the provider column existed holds rows that could
  // only have come from the paid API, since mock did not exist yet.
  addColumnIfMissing(db, "events", "provider", "TEXT NOT NULL DEFAULT 'anthropic'");
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, decl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Float32Array <-> BLOB. SQLite has no vector type; Phase 0 scans in JS. */
export function vecToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToVec(b: Uint8Array): Float32Array {
  // Copy: the view must not alias SQLite's buffer, which is reused.
  return new Float32Array(b.slice().buffer);
}
