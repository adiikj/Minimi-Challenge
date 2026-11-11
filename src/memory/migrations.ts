export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "profiles, threads, messages, sources, traces, search cache",
    sql: `
      CREATE TABLE devices (
        id         TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE users (
        id           TEXT PRIMARY KEY,
        device_id    TEXT REFERENCES devices(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        tz           TEXT NOT NULL DEFAULT 'UTC',
        is_demo      INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX users_device ON users(device_id);

      CREATE TABLE threads (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX threads_user_updated ON threads(user_id, updated_at DESC);

      CREATE TABLE messages (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'stopped', 'error')),
        created_at TEXT NOT NULL,
        tz         TEXT NOT NULL,
        local_date TEXT NOT NULL
      );
      CREATE INDEX messages_thread ON messages(thread_id, created_at);
      CREATE INDEX messages_user_date ON messages(user_id, local_date);

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content, content='messages', content_rowid='rowid', tokenize='porter unicode61'
      );
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TABLE message_sources (
        message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label        TEXT NOT NULL,
        url          TEXT NOT NULL,
        domain       TEXT NOT NULL,
        title        TEXT NOT NULL,
        published_at TEXT,
        retrieved_at TEXT NOT NULL,
        excerpt      TEXT NOT NULL,
        PRIMARY KEY (message_id, label)
      );

      CREATE TABLE turn_traces (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        trace      TEXT NOT NULL,
        cost_usd   REAL NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE search_cache (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "bitemporal claims ledger, entities, spend log",
    sql: `
      CREATE TABLE claims (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        thread_id      TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        message_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        entity         TEXT NOT NULL,
        plan           TEXT,
        attribute      TEXT NOT NULL,
        value          TEXT NOT NULL,
        previous_value TEXT,
        source_label   TEXT,
        observed_at    TEXT NOT NULL,
        effective_from TEXT,
        confidence     TEXT NOT NULL CHECK (confidence IN ('high', 'low')),
        superseded_by  TEXT REFERENCES claims(id) ON DELETE SET NULL,
        confirmed_at   TEXT,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX claims_message ON claims(message_id);
      CREATE INDEX claims_user_entity ON claims(user_id, entity);

      CREATE TABLE entities (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        domain     TEXT,
        PRIMARY KEY (message_id, name)
      );

      CREATE TABLE spend_log (
        id         INTEGER PRIMARY KEY,
        kind       TEXT NOT NULL,
        model      TEXT NOT NULL,
        cost_usd   REAL NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
];
