import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';

/**
 * Where OAuth tokens live. Tokens never touch the app database in plaintext,
 * never go to the browser and never get logged.
 */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** Secret names are derived from the instance id, hashed so ids aren't enumerable in the console. */
export function hubspotTokenSecretName(prefix: string, instanceId: string): string {
  return `${prefix}-hs-${createHash('sha256').update(instanceId).digest('hex').slice(0, 40)}`;
}

/** Development store: AES-256-GCM ciphertext in SQLite. */
export class LocalEncryptedSecretStore implements SecretStore {
  constructor(private db: DB, private key: Buffer) {}

  async get(name: string) {
    const row = this.db.prepare('SELECT ciphertext FROM secrets WHERE name = ?').get(name) as { ciphertext: string } | undefined;
    return row ? decrypt(this.key, row.ciphertext) : null;
  }

  async put(name: string, value: string) {
    this.db
      .prepare(
        `INSERT INTO secrets (name, ciphertext, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      )
      .run(name, encrypt(this.key, value), Date.now());
  }

  async delete(name: string) {
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }
}
