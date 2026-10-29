import type { Config } from './config.js';
import { openDb, type DB } from './db.js';
import { Store } from './store.js';
import { decodeKey } from './crypto.js';
import { LocalEncryptedSecretStore, type SecretStore } from './secrets/index.js';
import { HubSpotOAuth } from './hubspot/oauth.js';
import { HubSpotClient } from './hubspot/client.js';
import { SdkWixGateway, type WixGateway } from './wix/gateway.js';
import { SdkWixEventParser, type WixEventParser } from './wix/events.js';
import { WixFieldCatalog } from './wix/fields.js';
import { SyncEngine } from './sync/engine.js';
import { JobQueue } from './sync/queue.js';
import { FormCapture } from './forms/submissions.js';
import type { HubSpotPropertyOption } from '../shared/types.js';
import { log } from './logger.js';

export interface ContextOverrides {
  db?: DB;
  secrets?: SecretStore;
  wix?: WixGateway;
  wixEvents?: WixEventParser;
  fetchFn?: typeof fetch;
}

/** Wires every service together. Tests and the mock stack swap the Wix side and `fetch`. */
export async function createContext(cfg: Config, o: ContextOverrides = {}) {
  const db = o.db ?? openDb(cfg.DATABASE_PATH);
  const store = new Store(db);
  const key = decodeKey(cfg.TOKEN_ENCRYPTION_KEY);
  let secrets = o.secrets;
  if (!secrets) {
    if (cfg.SECRET_STORE === 'gcp') {
      const { GcpSecretManagerStore } = await import('./secrets/gcp.js');
      secrets = new GcpSecretManagerStore(cfg.GCP_PROJECT_ID);
    } else {
      secrets = new LocalEncryptedSecretStore(db, key);
    }
  }
  const fetchFn = o.fetchFn ?? fetch;
  const oauth = new HubSpotOAuth(cfg, secrets, fetchFn);
  const wix = o.wix ?? new SdkWixGateway(cfg.WIX_APP_ID, cfg.WIX_APP_SECRET);
  const wixEvents = o.wixEvents ?? new SdkWixEventParser(cfg.WIX_APP_ID, cfg.WIX_PUBLIC_KEY.replace(/\\n/g, '\n'));

  const hubspot = (instanceId: string) => new HubSpotClient(oauth, instanceId, cfg.HUBSPOT_API_BASE, fetchFn);

  // Small TTL caches for schema lookups (fields don't change often; mapping UI refreshes them).
  const ttl = 10 * 60_000;
  const propCache = new Map<string, { at: number; value: HubSpotPropertyOption[] }>();
  const catalogCache = new Map<string, { at: number; value: WixFieldCatalog }>();

  const hubspotProperties = async (instanceId: string, fresh = false) => {
    const hit = propCache.get(instanceId);
    if (!fresh && hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await hubspot(instanceId).listProperties();
    propCache.set(instanceId, { at: Date.now(), value });
    return value;
  };

  const catalog = async (instanceId: string, fresh = false) => {
    const hit = catalogCache.get(instanceId);
    if (!fresh && hit && Date.now() - hit.at < ttl) return hit.value;
    let extended: Awaited<ReturnType<WixGateway['listExtendedFields']>> = [];
    try {
      extended = await wix.listExtendedFields(instanceId);
    } catch (err) {
      log.warn('could not list Wix extended fields', { instanceId, err });
    }
    const value = new WixFieldCatalog(extended);
    catalogCache.set(instanceId, { at: Date.now(), value });
    return value;
  };

  const engine = new SyncEngine({ store, wix, hubspot, catalog, hashKey: key });
  const forms = new FormCapture({ store, hubspot, hubspotProperties, hashKey: key });
  const queue = new JobQueue(db);

  return { cfg, db, store, secrets, oauth, wix, wixEvents, hubspot, hubspotProperties, catalog, engine, forms, queue, hashKey: key, fetchFn };
}

export type AppContext = Awaited<ReturnType<typeof createContext>>;
