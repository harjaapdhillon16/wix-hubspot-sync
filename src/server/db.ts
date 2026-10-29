import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

/**
 * App database. Holds configuration and sync state only — never OAuth tokens
 * (those live in the SecretStore) and never raw contact PII (only HMAC hashes).
 */
const MIGRATIONS = [
  `
  CREATE TABLE installations (
    instance_id        TEXT PRIMARY KEY,
    site_key           TEXT NOT NULL UNIQUE,          -- public, non-secret id used by the attribution script
    hubspot_portal_id  TEXT,
    hubspot_hub_domain TEXT,
    hubspot_scopes     TEXT,
    connected_at       INTEGER,
    conflict_strategy  TEXT NOT NULL DEFAULT 'last_updated_wins',
    sync_enabled       INTEGER NOT NULL DEFAULT 1,
    poll_cursor        INTEGER,
    script_embedded    INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX idx_inst_portal ON installations(hubspot_portal_id);

  CREATE TABLE field_mappings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id      TEXT NOT NULL,
    position         INTEGER NOT NULL,
    wix_field        TEXT NOT NULL,
    hubspot_property TEXT NOT NULL,
    direction        TEXT NOT NULL,
    transform        TEXT NOT NULL DEFAULT 'none',
    default_value    TEXT
  );
  CREATE INDEX idx_map_inst ON field_mappings(instance_id);

  -- External ID mapping WixContactId <-> HubSpotContactId plus the per-field
  -- hashes of the values last known to be in sync (the "base" for 3-way merge).
  CREATE TABLE contact_links (
    instance_id         TEXT NOT NULL,
    wix_contact_id      TEXT NOT NULL,
    hubspot_contact_id  TEXT NOT NULL,
    wix_hashes          TEXT NOT NULL DEFAULT '{}',
    hubspot_hashes      TEXT NOT NULL DEFAULT '{}',
    last_sync_id        TEXT,
    last_sync_source    TEXT,
    last_synced_at      INTEGER,
    PRIMARY KEY (instance_id, wix_contact_id),
    UNIQUE (instance_id, hubspot_contact_id)
  );

  -- Durable job queue. A pending job with the same dedupe_key collapses new
  -- enqueues (debounces HubSpot's one-webhook-per-property bursts).
  CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,
    instance_id TEXT,
    dedupe_key  TEXT,
    payload     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    attempts    INTEGER NOT NULL DEFAULT 0,
    run_at      INTEGER NOT NULL,
    last_error  TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_jobs_due ON jobs(status, run_at);
  CREATE UNIQUE INDEX idx_jobs_dedupe ON jobs(dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL;

  -- Webhook delivery dedupe (both Wix and HubSpot retry deliveries).
  CREATE TABLE processed_events (
    event_id    TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL
  );

  CREATE TABLE oauth_states (
    nonce       TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  -- Attribution captured by the site script, keyed by HMAC(email) — no raw email stored.
  CREATE TABLE attribution (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL,
    email_hash  TEXT NOT NULL,
    data        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_attr_lookup ON attribution(instance_id, email_hash, created_at);

  -- Observability for form capture (no PII: ids, UTM values, status, latency).
  CREATE TABLE form_events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id        TEXT NOT NULL,
    submission_id      TEXT NOT NULL,
    form_id            TEXT,
    wix_contact_id     TEXT,
    hubspot_contact_id TEXT,
    status             TEXT NOT NULL,
    utm_source         TEXT,
    utm_medium         TEXT,
    utm_campaign       TEXT,
    latency_ms         INTEGER,
    detail             TEXT,
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX idx_forms_inst ON form_events(instance_id, created_at);

  CREATE TABLE sync_log (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id        TEXT NOT NULL,
    ts                 INTEGER NOT NULL,
    sync_id            TEXT,
    direction          TEXT NOT NULL,
    action             TEXT NOT NULL,
    wix_contact_id     TEXT,
    hubspot_contact_id TEXT,
    fields             TEXT,
    detail             TEXT
  );
  CREATE INDEX idx_log_inst ON sync_log(instance_id, ts);

  -- Used by the "local" SecretStore only (AES-256-GCM ciphertext).
  CREATE TABLE secrets (
    name       TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  for (; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[version]);
    db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
    db.exec('COMMIT');
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
