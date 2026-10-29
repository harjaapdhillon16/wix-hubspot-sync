import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { SecretStore } from './index.js';

/**
 * Production store: Google Cloud Secret Manager.
 * One secret per Wix instance; every token refresh adds a version and destroys
 * the previous ones so stale refresh tokens don't linger.
 * The service account only needs roles/secretmanager.admin on the secrets it creates
 * (or secretAccessor + secretVersionManager + a pre-created secret per instance).
 */
export class GcpSecretManagerStore implements SecretStore {
  private client = new SecretManagerServiceClient();

  constructor(private projectId: string) {}

  private secretPath(name: string) {
    return `projects/${this.projectId}/secrets/${name}`;
  }

  async get(name: string) {
    try {
      const [version] = await this.client.accessSecretVersion({ name: `${this.secretPath(name)}/versions/latest` });
      return version.payload?.data ? Buffer.from(version.payload.data as Uint8Array).toString('utf8') : null;
    } catch (err) {
      if ((err as { code?: number }).code === 5) return null; // NOT_FOUND
      throw err;
    }
  }

  async put(name: string, value: string) {
    try {
      await this.client.createSecret({
        parent: `projects/${this.projectId}`,
        secretId: name,
        secret: { replication: { automatic: {} }, labels: { app: 'wix-hubspot-sync' } },
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 6) throw err; // ALREADY_EXISTS is fine
    }
    const [added] = await this.client.addSecretVersion({
      parent: this.secretPath(name),
      payload: { data: Buffer.from(value, 'utf8') },
    });
    const [versions] = await this.client.listSecretVersions({ parent: this.secretPath(name), filter: 'state:ENABLED' });
    await Promise.all(
      versions
        .filter((v) => v.name && v.name !== added.name)
        .map((v) => this.client.destroySecretVersion({ name: v.name! })),
    );
  }

  async delete(name: string) {
    try {
      await this.client.deleteSecret({ name: this.secretPath(name) });
    } catch (err) {
      if ((err as { code?: number }).code !== 5) throw err;
    }
  }
}
