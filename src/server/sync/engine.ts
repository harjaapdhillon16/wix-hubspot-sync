import type { Store, ContactLink } from '../store.js';
import type { WixGateway } from '../wix/gateway.js';
import { normalize, type WixContact, type WixFieldCatalog } from '../wix/fields.js';
import type { HubSpotClient, HsContact } from '../hubspot/client.js';
import { piiHash, randomId } from '../crypto.js';
import { project, writesToHubSpot, writesToWix } from './mapping.js';
import type { ConflictStrategy, FieldMapping } from '../../shared/types.js';
import { log } from '../logger.js';

export type Side = 'wix' | 'hubspot';
export type Trigger = 'wix' | 'hubspot' | 'poll' | 'full_sync' | 'form';

export interface SyncDeps {
  store: Store;
  wix: WixGateway;
  hubspot(instanceId: string): HubSpotClient;
  catalog(instanceId: string): Promise<WixFieldCatalog>;
  hashKey: Buffer;
}

export interface ReconcileResult {
  action: 'created' | 'updated' | 'no_change' | 'skipped';
  syncId?: string;
  wixContactId?: string;
  hubspotContactId?: string;
  wroteToWix: string[];
  wroteToHubSpot: string[];
  conflicts: string[];
  reason?: string;
}

/**
 * Bi-directional contact sync.
 *
 * Every trigger (Wix webhook, HubSpot webhook, poll, form) ends up here as
 * "reconcile this contact pair". The engine is *state based*, not event based:
 * it re-reads both records and compares each mapped field to the hash of the
 * value that was last known to be in sync (stored per link, so no PII is stored).
 *
 *   only Wix changed      -> copy Wix -> HubSpot (if the row allows that direction)
 *   only HubSpot changed  -> copy HubSpot -> Wix
 *   both changed          -> conflict rule (last updated wins / HubSpot wins / Wix wins)
 *   neither changed       -> nothing to do  <- this is what kills ping-pong
 *
 * Only differing values are written (idempotent), and after each write the new
 * hashes are stored, so the webhook echo of our own write finds "nothing changed".
 * Webhook origin tags (Wix identity.appId / HubSpot sourceId) and event-id dedupe
 * drop most echoes even earlier, before any API call is made.
 */
export class SyncEngine {
  constructor(private deps: SyncDeps) {}

  private hash(instanceId: string, value: string) {
    return piiHash(this.deps.hashKey, `${instanceId}\u0000${value}`);
  }

  private hashes(instanceId: string, mappings: FieldMapping[], wix: WixContact, hs: HsContact, catalog: WixFieldCatalog) {
    const wixHashes: Record<string, string> = {};
    const hubspotHashes: Record<string, string> = {};
    for (const m of mappings) {
      wixHashes[m.wixField] = this.hash(instanceId, catalog.get(wix, m.wixField));
      hubspotHashes[m.hubspotProperty] = this.hash(instanceId, normalize(hs.properties[m.hubspotProperty]));
    }
    return { wixHashes, hubspotHashes };
  }

  async reconcile(instanceId: string, ref: { wixContactId?: string; hubspotContactId?: string }, trigger: Trigger): Promise<ReconcileResult> {
    const { store, wix } = this.deps;
    const result: ReconcileResult = { action: 'skipped', wroteToWix: [], wroteToHubSpot: [], conflicts: [] };
    const inst = store.getInstallation(instanceId);
    if (!inst?.portalId) return { ...result, reason: 'not_connected' };
    if (!inst.syncEnabled) return { ...result, reason: 'sync_disabled' };

    const mappings = store.getMappings(instanceId);
    const catalog = await this.deps.catalog(instanceId);
    const hs = this.deps.hubspot(instanceId);
    const hsProps = [...new Set(['email', ...mappings.map((m) => m.hubspotProperty)])];
    const source: Side = ref.wixContactId ? 'wix' : 'hubspot';

    let link: ContactLink | null = ref.wixContactId ? store.linkByWix(instanceId, ref.wixContactId) : store.linkByHubSpot(instanceId, ref.hubspotContactId!);
    const wixId = ref.wixContactId ?? link?.wixContactId;
    const hsId = ref.hubspotContactId ?? link?.hubspotContactId;
    let wixContact = wixId ? await wix.getContact(instanceId, wixId) : null;
    let hsContact = hsId ? await hs.getContact(hsId, hsProps) : null;

    // The triggering record disappeared (deleted / merged) -> forget the link, never delete on the other side.
    if ((source === 'wix' && !wixContact) || (source === 'hubspot' && !hsContact)) {
      if (link) store.deleteLink(instanceId, source, source === 'wix' ? link.wixContactId : link.hubspotContactId);
      return { ...result, reason: 'source_missing' };
    }
    // The counterpart vanished -> drop the stale link and re-match by email below.
    if (link && (!wixContact || !hsContact)) {
      store.deleteLink(instanceId, source, source === 'wix' ? link.wixContactId : link.hubspotContactId);
      link = null;
    }

    const email = source === 'wix' ? catalog.get(wixContact!, 'email') : normalize(hsContact!.properties.email);
    if (!link) {
      if (!email) {
        store.logSync({ instanceId, direction: source === 'wix' ? 'wix_to_hubspot' : 'hubspot_to_wix', action: 'skipped', wixContactId: wixId, hubspotContactId: hsId, detail: 'contact has no email' });
        return { ...result, reason: 'no_email' };
      }
      if (source === 'wix') hsContact = await hs.findByEmail(email.trim(), hsProps);
      else wixContact = await wix.findContactByEmail(instanceId, email.trim());
    }

    const syncId = randomId(8);
    result.syncId = syncId;

    // ---- create flow: the counterpart doesn't exist yet ----
    if (!wixContact || !hsContact) {
      if (source === 'wix') {
        const props: Record<string, string> = {};
        for (const m of mappings.filter(writesToHubSpot)) {
          const v = project(m, catalog.get(wixContact!, m.wixField));
          if (v !== '') props[m.hubspotProperty] = v;
        }
        hsContact = await hs.createContact(props);
        hsContact.properties = { ...props, ...hsContact.properties };
        result.wroteToHubSpot = Object.keys(props);
      } else {
        const values: Record<string, string> = {};
        for (const m of mappings.filter(writesToWix)) {
          const v = project(m, normalize(hsContact!.properties[m.hubspotProperty]));
          if (v !== '') values[m.wixField] = v;
        }
        wixContact = await wix.createContact(instanceId, catalog.buildInfo({}, values));
        result.wroteToWix = Object.keys(values);
      }
      this.saveLink(instanceId, mappings, wixContact!, hsContact!, catalog, syncId, source);
      store.logSync({
        instanceId, syncId, direction: source === 'wix' ? 'wix_to_hubspot' : 'hubspot_to_wix', action: 'created',
        wixContactId: wixContact!._id, hubspotContactId: hsContact!.id, fields: source === 'wix' ? result.wroteToHubSpot : result.wroteToWix, detail: `trigger=${trigger}`,
      });
      return { ...result, action: 'created', wixContactId: wixContact!._id, hubspotContactId: hsContact!.id };
    }

    // ---- update flow: field-level three-way merge ----
    const wixTs = toMs(wixContact._updatedDate);
    const hsTs = toMs(hsContact.properties.lastmodifieddate ?? hsContact.updatedAt);
    const wixPatch: Record<string, string> = {};
    const hsPatch: Record<string, string> = {};

    for (const m of mappings) {
      const wv = catalog.get(wixContact, m.wixField);
      const hv = normalize(hsContact.properties[m.hubspotProperty]);
      const wBase = link?.wixHashes[m.wixField];
      const hBase = link?.hubspotHashes[m.hubspotProperty];
      const wChanged = wBase === undefined || wBase !== this.hash(instanceId, wv);
      const hChanged = hBase === undefined || hBase !== this.hash(instanceId, hv);
      if (!wChanged && !hChanged) continue;

      let winner: Side | null;
      if (m.direction === 'wix_to_hubspot') winner = wChanged ? 'wix' : null;
      else if (m.direction === 'hubspot_to_wix') winner = hChanged ? 'hubspot' : null;
      else if (wChanged && !hChanged) winner = 'wix';
      else if (hChanged && !wChanged) winner = 'hubspot';
      else {
        if (project(m, wv) === hv || project(m, hv) === wv) continue; // already consistent
        const firstSync = wBase === undefined || hBase === undefined;
        if (firstSync && (wv === '' || hv === '')) {
          // First time this pair/row is synced: fill gaps instead of blanking data.
          winner = wv === '' ? 'hubspot' : 'wix';
        } else {
          winner = resolveConflict(inst.conflictStrategy, wixTs, hsTs, source);
          result.conflicts.push(`${m.wixField}↔${m.hubspotProperty}:${winner}`);
        }
      }

      if (winner === 'wix') {
        const t = project(m, wv);
        if (t !== hv && !(m.hubspotProperty === 'email' && t === '')) hsPatch[m.hubspotProperty] = t;
      } else if (winner === 'hubspot') {
        const t = project(m, hv);
        if (t !== wv && !(m.wixField === 'email' && t === '')) wixPatch[m.wixField] = t;
      }
    }

    if (Object.keys(hsPatch).length) {
      const updated = await hs.updateContact(hsContact.id, hsPatch);
      hsContact = { ...hsContact, properties: { ...hsContact.properties, ...hsPatch, ...pick(updated.properties, hsProps) } };
      result.wroteToHubSpot = Object.keys(hsPatch);
    }
    if (Object.keys(wixPatch).length) {
      wixContact = await wix.updateContact(instanceId, wixContact._id!, catalog.buildInfo(wixContact, wixPatch), wixContact.revision ?? 0);
      result.wroteToWix = Object.keys(wixPatch);
    }

    this.saveLink(instanceId, mappings, wixContact, hsContact, catalog, syncId, source);
    const changed = result.wroteToHubSpot.length + result.wroteToWix.length > 0;
    if (changed || trigger === 'wix' || trigger === 'hubspot') {
      store.logSync({
        instanceId, syncId,
        direction: result.wroteToHubSpot.length && result.wroteToWix.length ? 'both' : result.wroteToHubSpot.length ? 'wix_to_hubspot' : result.wroteToWix.length ? 'hubspot_to_wix' : source === 'wix' ? 'wix_to_hubspot' : 'hubspot_to_wix',
        action: changed ? 'updated' : 'no_change',
        wixContactId: wixContact._id, hubspotContactId: hsContact.id,
        fields: [...result.wroteToHubSpot, ...result.wroteToWix],
        detail: [`trigger=${trigger}`, result.conflicts.length ? `conflicts=${result.conflicts.join(',')}` : '', changed ? '' : 'idempotent: values already in sync'].filter(Boolean).join(' '),
      });
    }
    log.debug('reconciled', { instanceId, wixContactId: wixContact._id, hubspotContactId: hsContact.id, fieldCount: result.wroteToHubSpot.length + result.wroteToWix.length });
    return { ...result, action: changed ? 'updated' : 'no_change', wixContactId: wixContact._id, hubspotContactId: hsContact.id };
  }

  private saveLink(instanceId: string, mappings: FieldMapping[], wix: WixContact, hs: HsContact, catalog: WixFieldCatalog, syncId: string, source: Side) {
    this.deps.store.upsertLink({
      instanceId,
      wixContactId: wix._id!,
      hubspotContactId: hs.id,
      ...this.hashes(instanceId, mappings, wix, hs, catalog),
      lastSyncId: syncId,
      lastSyncSource: source,
    });
  }
}

export function resolveConflict(strategy: ConflictStrategy, wixTs: number, hsTs: number, source: Side): Side {
  if (strategy === 'wix_wins') return 'wix';
  if (strategy === 'hubspot_wins') return 'hubspot';
  if (wixTs && hsTs && wixTs !== hsTs) return wixTs > hsTs ? 'wix' : 'hubspot';
  return source; // tie / unknown timestamps: the side that produced the event is the most recent
}

function toMs(v: unknown): number {
  if (!v) return 0;
  const n = v instanceof Date ? v.getTime() : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  return Number.isFinite(n) ? n : 0;
}

function pick(obj: Record<string, string | null> | undefined, keys: string[]) {
  const out: Record<string, string | null> = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
}
