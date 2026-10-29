import type { DB } from './db.js';
import { randomId } from './crypto.js';
import type { ConflictStrategy, FieldMapping, Direction, Transform, ActivityEntry, FormEventEntry } from '../shared/types.js';

export interface Installation {
  instanceId: string;
  siteKey: string;
  portalId: string | null;
  hubDomain: string | null;
  scopes: string[];
  connectedAt: number | null;
  conflictStrategy: ConflictStrategy;
  syncEnabled: boolean;
  pollCursor: number | null;
  scriptEmbedded: boolean;
}

export interface ContactLink {
  instanceId: string;
  wixContactId: string;
  hubspotContactId: string;
  wixHashes: Record<string, string>;
  hubspotHashes: Record<string, string>;
  lastSyncId: string | null;
  lastSyncSource: string | null;
  lastSyncedAt: number | null;
}

export const DEFAULT_MAPPINGS: FieldMapping[] = [
  { wixField: 'email', hubspotProperty: 'email', direction: 'bidirectional', transform: 'trim' },
  { wixField: 'name.first', hubspotProperty: 'firstname', direction: 'bidirectional', transform: 'none' },
  { wixField: 'name.last', hubspotProperty: 'lastname', direction: 'bidirectional', transform: 'none' },
  { wixField: 'phone', hubspotProperty: 'phone', direction: 'bidirectional', transform: 'none' },
  { wixField: 'company', hubspotProperty: 'company', direction: 'bidirectional', transform: 'none' },
  { wixField: 'jobTitle', hubspotProperty: 'jobtitle', direction: 'bidirectional', transform: 'none' },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

function toInstallation(r: Row): Installation {
  return {
    instanceId: r.instance_id,
    siteKey: r.site_key,
    portalId: r.hubspot_portal_id,
    hubDomain: r.hubspot_hub_domain,
    scopes: r.hubspot_scopes ? String(r.hubspot_scopes).split(' ') : [],
    connectedAt: r.connected_at,
    conflictStrategy: r.conflict_strategy,
    syncEnabled: !!r.sync_enabled,
    pollCursor: r.poll_cursor,
    scriptEmbedded: !!r.script_embedded,
  };
}

function toLink(r: Row): ContactLink {
  return {
    instanceId: r.instance_id,
    wixContactId: r.wix_contact_id,
    hubspotContactId: r.hubspot_contact_id,
    wixHashes: JSON.parse(r.wix_hashes),
    hubspotHashes: JSON.parse(r.hubspot_hashes),
    lastSyncId: r.last_sync_id,
    lastSyncSource: r.last_sync_source,
    lastSyncedAt: r.last_synced_at,
  };
}

export class Store {
  constructor(public db: DB) {}

  // ---- installations ----
  ensureInstallation(instanceId: string): Installation {
    this.db
      .prepare('INSERT OR IGNORE INTO installations (instance_id, site_key, created_at) VALUES (?, ?, ?)')
      .run(instanceId, randomId(12), Date.now());
    const inst = this.getInstallation(instanceId)!;
    if (this.getMappings(instanceId).length === 0) this.saveMappings(instanceId, DEFAULT_MAPPINGS);
    return inst;
  }

  getInstallation(instanceId: string): Installation | null {
    const r = this.db.prepare('SELECT * FROM installations WHERE instance_id = ?').get(instanceId) as Row | undefined;
    return r ? toInstallation(r) : null;
  }

  getInstallationBySiteKey(siteKey: string): Installation | null {
    const r = this.db.prepare('SELECT * FROM installations WHERE site_key = ?').get(siteKey) as Row | undefined;
    return r ? toInstallation(r) : null;
  }

  installationsForPortal(portalId: string): Installation[] {
    return (this.db.prepare('SELECT * FROM installations WHERE hubspot_portal_id = ?').all(portalId) as Row[]).map(toInstallation);
  }

  connectedInstallations(): Installation[] {
    return (this.db.prepare('SELECT * FROM installations WHERE hubspot_portal_id IS NOT NULL').all() as Row[]).map(toInstallation);
  }

  setConnection(instanceId: string, c: { portalId: string; hubDomain: string | null; scopes: string[] } | null) {
    const prev = this.getInstallation(instanceId);
    if (c && prev?.portalId && prev.portalId !== c.portalId) this.clearLinks(instanceId); // different HubSpot account
    this.db
      .prepare('UPDATE installations SET hubspot_portal_id = ?, hubspot_hub_domain = ?, hubspot_scopes = ?, connected_at = ?, poll_cursor = ? WHERE instance_id = ?')
      .run(c?.portalId ?? null, c?.hubDomain ?? null, c?.scopes.join(' ') ?? null, c ? Date.now() : null, c ? Date.now() : null, instanceId);
  }

  updateSettings(instanceId: string, s: { conflictStrategy?: ConflictStrategy; syncEnabled?: boolean }) {
    if (s.conflictStrategy) this.db.prepare('UPDATE installations SET conflict_strategy = ? WHERE instance_id = ?').run(s.conflictStrategy, instanceId);
    if (s.syncEnabled !== undefined) this.db.prepare('UPDATE installations SET sync_enabled = ? WHERE instance_id = ?').run(s.syncEnabled ? 1 : 0, instanceId);
  }

  setPollCursor(instanceId: string, cursor: number) {
    this.db.prepare('UPDATE installations SET poll_cursor = ? WHERE instance_id = ?').run(cursor, instanceId);
  }

  setScriptEmbedded(instanceId: string, embedded: boolean) {
    this.db.prepare('UPDATE installations SET script_embedded = ? WHERE instance_id = ?').run(embedded ? 1 : 0, instanceId);
  }

  deleteInstallation(instanceId: string) {
    for (const t of ['field_mappings', 'contact_links', 'jobs', 'attribution', 'form_events', 'sync_log', 'oauth_states', 'installations']) {
      this.db.prepare(`DELETE FROM ${t} WHERE instance_id = ?`).run(instanceId);
    }
  }

  // ---- mappings ----
  getMappings(instanceId: string): FieldMapping[] {
    return (this.db.prepare('SELECT * FROM field_mappings WHERE instance_id = ? ORDER BY position').all(instanceId) as Row[]).map((r) => ({
      wixField: r.wix_field,
      hubspotProperty: r.hubspot_property,
      direction: r.direction as Direction,
      transform: r.transform as Transform,
      defaultValue: r.default_value,
    }));
  }

  saveMappings(instanceId: string, mappings: FieldMapping[]) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM field_mappings WHERE instance_id = ?').run(instanceId);
      const ins = this.db.prepare(
        'INSERT INTO field_mappings (instance_id, position, wix_field, hubspot_property, direction, transform, default_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      mappings.forEach((m, i) => ins.run(instanceId, i, m.wixField, m.hubspotProperty, m.direction, m.transform, m.defaultValue || null));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- contact links ----
  linkByWix(instanceId: string, wixContactId: string): ContactLink | null {
    const r = this.db.prepare('SELECT * FROM contact_links WHERE instance_id = ? AND wix_contact_id = ?').get(instanceId, wixContactId) as Row | undefined;
    return r ? toLink(r) : null;
  }

  linkByHubSpot(instanceId: string, hubspotContactId: string): ContactLink | null {
    const r = this.db.prepare('SELECT * FROM contact_links WHERE instance_id = ? AND hubspot_contact_id = ?').get(instanceId, hubspotContactId) as Row | undefined;
    return r ? toLink(r) : null;
  }

  upsertLink(l: Omit<ContactLink, 'lastSyncedAt'>) {
    // A contact may only be linked once on each side; drop any stale link that would collide.
    this.db.prepare('DELETE FROM contact_links WHERE instance_id = ? AND (wix_contact_id = ? OR hubspot_contact_id = ?)').run(l.instanceId, l.wixContactId, l.hubspotContactId);
    this.db
      .prepare(
        `INSERT INTO contact_links (instance_id, wix_contact_id, hubspot_contact_id, wix_hashes, hubspot_hashes, last_sync_id, last_sync_source, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(l.instanceId, l.wixContactId, l.hubspotContactId, JSON.stringify(l.wixHashes), JSON.stringify(l.hubspotHashes), l.lastSyncId, l.lastSyncSource, Date.now());
  }

  deleteLink(instanceId: string, side: 'wix' | 'hubspot', id: string) {
    const col = side === 'wix' ? 'wix_contact_id' : 'hubspot_contact_id';
    this.db.prepare(`DELETE FROM contact_links WHERE instance_id = ? AND ${col} = ?`).run(instanceId, id);
  }

  clearLinks(instanceId: string) {
    this.db.prepare('DELETE FROM contact_links WHERE instance_id = ?').run(instanceId);
  }

  // ---- webhook dedupe ----
  /** Returns false if this event id was already processed. */
  markEventProcessed(eventId: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO processed_events (event_id, received_at) VALUES (?, ?)').run(eventId, Date.now());
    return r.changes > 0;
  }

  pruneProcessedEvents(olderThanMs: number) {
    this.db.prepare('DELETE FROM processed_events WHERE received_at < ?').run(Date.now() - olderThanMs);
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(Date.now());
    this.db.prepare('DELETE FROM attribution WHERE created_at < ?').run(Date.now() - 7 * 24 * 3600_000);
  }

  // ---- oauth state ----
  saveOAuthState(nonce: string, instanceId: string, ttlMs: number) {
    this.db.prepare('INSERT INTO oauth_states (nonce, instance_id, expires_at) VALUES (?, ?, ?)').run(nonce, instanceId, Date.now() + ttlMs);
  }

  consumeOAuthState(nonce: string): string | null {
    const r = this.db.prepare('DELETE FROM oauth_states WHERE nonce = ? AND expires_at > ? RETURNING instance_id').get(nonce, Date.now()) as Row | undefined;
    return r?.instance_id ?? null;
  }

  // ---- attribution ----
  saveAttribution(instanceId: string, emailHash: string, data: Record<string, string>) {
    this.db.prepare('INSERT INTO attribution (instance_id, email_hash, data, created_at) VALUES (?, ?, ?, ?)').run(instanceId, emailHash, JSON.stringify(data), Date.now());
  }

  latestAttribution(instanceId: string, emailHash: string, withinMs: number): Record<string, string> | null {
    const r = this.db
      .prepare('SELECT data FROM attribution WHERE instance_id = ? AND email_hash = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1')
      .get(instanceId, emailHash, Date.now() - withinMs) as Row | undefined;
    return r ? JSON.parse(r.data) : null;
  }

  // ---- observability ----
  logSync(e: { instanceId: string; syncId?: string | null; direction: string; action: string; wixContactId?: string | null; hubspotContactId?: string | null; fields?: string[]; detail?: string | null }) {
    this.db
      .prepare('INSERT INTO sync_log (instance_id, ts, sync_id, direction, action, wix_contact_id, hubspot_contact_id, fields, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.instanceId, Date.now(), e.syncId ?? null, e.direction, e.action, e.wixContactId ?? null, e.hubspotContactId ?? null, JSON.stringify(e.fields ?? []), e.detail ?? null);
  }

  recentActivity(instanceId: string, limit = 50): ActivityEntry[] {
    return (this.db.prepare('SELECT * FROM sync_log WHERE instance_id = ? ORDER BY id DESC LIMIT ?').all(instanceId, limit) as Row[]).map((r) => ({
      ts: r.ts,
      direction: r.direction,
      action: r.action,
      wixContactId: r.wix_contact_id,
      hubspotContactId: r.hubspot_contact_id,
      fields: JSON.parse(r.fields ?? '[]'),
      detail: r.detail,
      syncId: r.sync_id,
    }));
  }

  logFormEvent(e: { instanceId: string; submissionId: string; formId?: string | null; wixContactId?: string | null; hubspotContactId?: string | null; status: string; utm?: Record<string, string>; latencyMs?: number; detail?: string }) {
    this.db
      .prepare(
        `INSERT INTO form_events (instance_id, submission_id, form_id, wix_contact_id, hubspot_contact_id, status, utm_source, utm_medium, utm_campaign, latency_ms, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.instanceId, e.submissionId, e.formId ?? null, e.wixContactId ?? null, e.hubspotContactId ?? null, e.status, e.utm?.utm_source ?? null, e.utm?.utm_medium ?? null, e.utm?.utm_campaign ?? null, e.latencyMs ?? null, e.detail ?? null, Date.now());
  }

  recentFormEvents(instanceId: string, limit = 25): FormEventEntry[] {
    return (this.db.prepare('SELECT * FROM form_events WHERE instance_id = ? ORDER BY id DESC LIMIT ?').all(instanceId, limit) as Row[]).map((r) => ({
      ts: r.created_at,
      submissionId: r.submission_id,
      formId: r.form_id,
      status: r.status,
      hubspotContactId: r.hubspot_contact_id,
      utmSource: r.utm_source,
      utmMedium: r.utm_medium,
      utmCampaign: r.utm_campaign,
      latencyMs: r.latency_ms,
      detail: r.detail,
    }));
  }

  stats(instanceId: string) {
    const one = (sql: string) => Number((this.db.prepare(sql).get(instanceId) as Row).n);
    return {
      linkedContacts: one('SELECT COUNT(*) n FROM contact_links WHERE instance_id = ?'),
      pendingJobs: one("SELECT COUNT(*) n FROM jobs WHERE instance_id = ? AND status IN ('pending','running')"),
      failedJobs: one("SELECT COUNT(*) n FROM jobs WHERE instance_id = ? AND status = 'dead'"),
      formSubmissions: one('SELECT COUNT(*) n FROM form_events WHERE instance_id = ?'),
    };
  }
}
