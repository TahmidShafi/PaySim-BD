import Database, { type Database as DatabaseType } from 'better-sqlite3';

export function runMigrations(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      invoice TEXT NOT NULL,
      amount_paisa INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'BDT',
      mode TEXT NOT NULL DEFAULT '0011',
      intent TEXT NOT NULL DEFAULT 'sale',
      payer_reference TEXT,
      customer_msisdn TEXT,
      callback_url TEXT NOT NULL,
      status TEXT NOT NULL,
      trx_id TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id_token TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      id_expires_at INTEGER NOT NULL,
      refresh_expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payment_id TEXT,
      request JSON,
      response JSON,
      chaos_applied TEXT
    );

    CREATE TABLE IF NOT EXISTS ipn_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id TEXT NOT NULL,
      sns_message_id TEXT NOT NULL,
      sns_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      signature TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      locked_until INTEGER DEFAULT 0,
      last_http_status INTEGER,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING'
    );

    CREATE TABLE IF NOT EXISTS chaos_rules (
      id TEXT PRIMARY KEY,
      match_json TEXT NOT NULL,
      action TEXT NOT NULL,
      params_json TEXT NOT NULL,
      seed INTEGER
    );

    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      target_url TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      token TEXT NOT NULL,
      topic_arn TEXT NOT NULL,
      confirmed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_payments_trx_id ON payments(trx_id);
    CREATE INDEX IF NOT EXISTS idx_ipn_outbox_status ON ipn_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_events_payment_id ON events(payment_id);
  `);
}

export function createDatabase(dbPath: string = ':memory:', options?: Database.Options): DatabaseType {
  const db = new Database(dbPath, options);

  // Set required PRAGMAs
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Run migrations idempotently
  runMigrations(db);

  return db;
}
