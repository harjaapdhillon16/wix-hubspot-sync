/**
 * In-memory HubSpot emulator used by the tests and `npm run dev:mock`.
 * Implements the slice of HubSpot the app uses: OAuth (authorize/token/token-info/revoke),
 * CRM v3 contacts (get/list/create/patch/search), properties + groups, and signed
 * v3 webhooks (one event per changed property, like HubSpot).
 */
import express, { json, urlencoded, type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { signHubSpotV3 } from '../src/server/hubspot/webhooks.js';

interface Contact { id: string; properties: Record<string, string>; createdAt: string; updatedAt: string }

const STANDARD_PROPS = [
  ['email', 'Email', 'string'], ['firstname', 'First Name', 'string'], ['lastname', 'Last Name', 'string'], ['phone', 'Phone Number', 'string'],
  ['company', 'Company Name', 'string'], ['jobtitle', 'Job Title', 'string'], ['city', 'City', 'string'], ['state', 'State/Region', 'string'],
  ['zip', 'Postal Code', 'string'], ['country', 'Country/Region', 'string'], ['website', 'Website URL', 'string'], ['date_of_birth', 'Date of birth', 'string'],
  ['lifecyclestage', 'Lifecycle Stage', 'enumeration'], ['membership_tier', 'Membership tier', 'string'],
  ['hs_object_id', 'Record ID', 'number', true], ['createdate', 'Create Date', 'datetime', true], ['lastmodifieddate', 'Last Modified Date', 'datetime', true],
] as const;

export interface MockHubSpotOptions {
  port?: number;
  appId: string;
  clientId: string;
  clientSecret: string;
  portalId?: number;
  /** Where to deliver webhooks (the app's /webhooks/hubspot). */
  webhookUrl?: string;
  /** Set false to omit sourceId on API writes, forcing the app to rely on hash-based loop prevention. */
  stampSourceId?: boolean;
  accessTokenTtlSec?: number;
}

export class MockHubSpot {
  contacts = new Map<string, Contact>();
  properties = new Map<string, { name: string; label: string; type: string; readOnly: boolean; groupName?: string }>();
  groups = new Set<string>();
  apiWrites: Array<{ id: string; props: string[] }> = [];
  webhooksSent = 0;
  revokedRefreshTokens = new Set<string>();
  private codes = new Map<string, string>(); // code -> redirect_uri
  private access = new Map<string, number>(); // token -> expiresAt
  private refresh = new Set<string>();
  private nextId = 1001;
  private server?: Server;
  private pending: Promise<unknown>[] = [];
  url = '';

  constructor(public opts: MockHubSpotOptions) {
    for (const [name, label, type, ro] of STANDARD_PROPS) this.properties.set(name, { name, label, type, readOnly: !!ro });
  }

  get portalId() {
    return this.opts.portalId ?? 12345678;
  }

  async start() {
    const app = express();
    app.use(urlencoded({ extended: false }));
    app.use(json());

    // ---- OAuth ----
    app.get('/oauth/authorize', (req, res) => {
      const { client_id, redirect_uri, state, scope } = req.query as Record<string, string>;
      if (client_id !== this.opts.clientId) return void res.status(400).send('unknown client_id');
      const code = this.issueCode(redirect_uri);
      res.send(`<!doctype html><html><body style="font-family:system-ui;padding:40px;max-width:520px;margin:auto">
        <h2>Mock HubSpot — authorize app</h2><p>Portal <b>${this.portalId}</b> will grant: <code>${scope}</code></p>
        <a id="approve" href="${redirect_uri}?code=${code}&state=${encodeURIComponent(state)}" style="background:#ff7a59;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none">Connect app</a>
        &nbsp; <a href="${redirect_uri}?error=access_denied&state=${encodeURIComponent(state)}">Cancel</a></body></html>`);
    });

    app.post('/oauth/v1/token', (req, res) => {
      const b = req.body as Record<string, string>;
      if (b.client_id !== this.opts.clientId || b.client_secret !== this.opts.clientSecret) return void res.status(401).json({ status: 'BAD_CLIENT' });
      if (b.grant_type === 'authorization_code') {
        if (this.codes.get(b.code) !== b.redirect_uri) return void res.status(400).json({ status: 'BAD_AUTH_CODE' });
        this.codes.delete(b.code);
        const refresh_token = 'rt-' + randomBytes(12).toString('hex');
        this.refresh.add(refresh_token);
        return void res.json({ access_token: this.issueAccess(), refresh_token, expires_in: this.opts.accessTokenTtlSec ?? 1800 });
      }
      if (b.grant_type === 'refresh_token') {
        if (!this.refresh.has(b.refresh_token)) return void res.status(400).json({ status: 'BAD_REFRESH_TOKEN' });
        return void res.json({ access_token: this.issueAccess(), refresh_token: b.refresh_token, expires_in: this.opts.accessTokenTtlSec ?? 1800 });
      }
      res.status(400).json({ status: 'BAD_GRANT_TYPE' });
    });

    app.get('/oauth/v1/access-tokens/:token', (req, res) => {
      if (!this.access.has(req.params.token)) return void res.status(404).end();
      res.json({ hub_id: this.portalId, hub_domain: 'mock-portal.hubspot.com', scopes: ['oauth', 'crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.schemas.contacts.read', 'crm.schemas.contacts.write'] });
    });

    app.delete('/oauth/v1/refresh-tokens/:token', (req, res) => {
      this.refresh.delete(req.params.token);
      this.revokedRefreshTokens.add(req.params.token);
      res.status(204).end();
    });

    // ---- CRM (bearer auth) ----
    const auth = (req: Request, res: Response, next: NextFunction) => {
      const t = (req.get('authorization') ?? '').replace(/^Bearer /, '');
      const exp = this.access.get(t);
      if (!exp || exp < Date.now()) return void res.status(401).json({ category: 'EXPIRED_AUTHENTICATION' });
      next();
    };
    app.use('/crm', auth);

    app.get('/crm/v3/objects/contacts/:id', (req, res) => {
      const c = this.contacts.get(req.params.id);
      if (!c) return void res.status(404).json({ category: 'OBJECT_NOT_FOUND' });
      res.json(this.view(c, String(req.query.properties ?? '').split(',').filter(Boolean)));
    });

    app.get('/crm/v3/objects/contacts', (req, res) => {
      const all = [...this.contacts.values()];
      const start = Number(req.query.after ?? 0);
      const limit = Number(req.query.limit ?? 10);
      const page = all.slice(start, start + limit);
      res.json({ results: page.map((c) => this.view(c, [])), ...(start + limit < all.length ? { paging: { next: { after: String(start + limit) } } } : {}) });
    });

    app.post('/crm/v3/objects/contacts', (req, res) => {
      const props = clean(req.body.properties);
      const dupe = props.email && this.byEmail(props.email);
      if (dupe) return void res.status(409).json({ status: 'error', message: `Contact already exists. Existing ID: ${dupe.id}`, category: 'CONFLICT' });
      const c = this.create(props, 'api');
      res.status(201).json(this.view(c, Object.keys(props)));
    });

    app.patch('/crm/v3/objects/contacts/:id', (req, res) => {
      const c = this.contacts.get(req.params.id);
      if (!c) return void res.status(404).json({ category: 'OBJECT_NOT_FOUND' });
      const props = clean(req.body.properties);
      for (const k of Object.keys(props)) if (this.properties.get(k)?.readOnly) return void res.status(400).json({ message: `${k} is read only` });
      this.update(c, props, 'api');
      res.json(this.view(c, Object.keys(props)));
    });

    app.post('/crm/v3/objects/contacts/search', (req, res) => {
      const filters: Array<{ propertyName: string; operator: string; value: string }> = req.body.filterGroups?.[0]?.filters ?? [];
      let results = [...this.contacts.values()].filter((c) =>
        filters.every((f) =>
          f.operator === 'EQ' ? (c.properties[f.propertyName] ?? '').toLowerCase() === String(f.value).toLowerCase()
            : f.operator === 'GTE' ? Date.parse(c.properties[f.propertyName] ?? '') >= Number(f.value) : true,
        ),
      );
      results.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
      const start = Number(req.body.after ?? 0);
      const limit = Number(req.body.limit ?? 10);
      const total = results.length;
      results = results.slice(start, start + limit);
      res.json({ total, results: results.map((c) => this.view(c, req.body.properties ?? [])), ...(start + limit < total ? { paging: { next: { after: String(start + limit) } } } : {}) });
    });

    app.get('/crm/v3/properties/contacts', (_req, res) => {
      res.json({ results: [...this.properties.values()].map((p) => ({ name: p.name, label: p.label, type: p.type, groupName: p.groupName ?? 'contactinformation', modificationMetadata: { readOnlyValue: p.readOnly } })) });
    });
    app.post('/crm/v3/properties/contacts/groups', (req, res) => {
      if (this.groups.has(req.body.name)) return void res.status(409).json({ message: 'group exists' });
      this.groups.add(req.body.name);
      res.status(201).json(req.body);
    });
    app.post('/crm/v3/properties/contacts', (req, res) => {
      if (this.properties.has(req.body.name)) return void res.status(409).json({ message: 'property exists' });
      this.properties.set(req.body.name, { name: req.body.name, label: req.body.label, type: req.body.type, readOnly: false, groupName: req.body.groupName });
      res.status(201).json(req.body);
    });

    // ---- "HubSpot UI" for the mock stack: a human editing contacts in HubSpot ----
    app.get('/_ui', (_req, res) => res.send(this.uiPage()));
    app.post('/_ui/contacts', (req, res) => {
      const props = clean(req.body);
      const existing = req.body.id ? this.contacts.get(req.body.id) : undefined;
      delete props.id;
      if (existing) this.update(existing, props, 'ui');
      else this.create(props, 'ui');
      res.redirect('/_ui');
    });
    app.get('/_ui/contacts.json', (_req, res) => res.json([...this.contacts.values()]));

    await new Promise<void>((resolve) => {
      this.server = app.listen(this.opts.port ?? 0, () => resolve());
    });
    const addr = this.server!.address();
    this.url = `http://localhost:${typeof addr === 'object' && addr ? addr.port : this.opts.port}`;
    return this;
  }

  async stop() {
    await this.flush();
    await new Promise((r) => this.server?.close(r));
  }

  /** Wait for in-flight webhook deliveries. */
  async flush() {
    while (this.pending.length) await Promise.allSettled(this.pending.splice(0));
  }

  issueCode(redirectUri: string) {
    const code = 'code-' + randomBytes(8).toString('hex');
    this.codes.set(code, redirectUri);
    return code;
  }

  private issueAccess() {
    const t = 'at-' + randomBytes(16).toString('hex');
    this.access.set(t, Date.now() + (this.opts.accessTokenTtlSec ?? 1800) * 1000);
    return t;
  }

  expireAllAccessTokens() {
    for (const k of this.access.keys()) this.access.set(k, 0);
  }

  byEmail(email: string) {
    return [...this.contacts.values()].find((c) => c.properties.email?.toLowerCase() === email.toLowerCase());
  }

  /** Simulate a user editing in HubSpot (emits webhooks with changeSource CRM_UI). */
  uiUpsert(props: Record<string, string>, id?: string): Contact {
    const c = id ? this.contacts.get(id) : undefined;
    if (c) {
      this.update(c, props, 'ui');
      return c;
    }
    return this.create(props, 'ui');
  }

  private create(props: Record<string, string>, by: 'api' | 'ui'): Contact {
    const id = String(this.nextId++);
    const now = this.tick();
    const c: Contact = { id, properties: { ...props, hs_object_id: id, createdate: now, lastmodifieddate: now }, createdAt: now, updatedAt: now };
    if (c.properties.email) c.properties.email = c.properties.email.toLowerCase(); // HubSpot normalises email
    this.contacts.set(id, c);
    if (by === 'api') this.apiWrites.push({ id, props: Object.keys(props) });
    this.emit([{ subscriptionType: 'contact.creation', objectId: id }], by);
    return c;
  }

  private update(c: Contact, props: Record<string, string>, by: 'api' | 'ui') {
    const changed = Object.keys(props).filter((k) => (c.properties[k] ?? '') !== props[k]);
    Object.assign(c.properties, props);
    if (props.email) c.properties.email = props.email.toLowerCase();
    c.updatedAt = c.properties.lastmodifieddate = this.tick();
    if (by === 'api') this.apiWrites.push({ id: c.id, props: Object.keys(props) });
    this.emit(changed.map((p) => ({ subscriptionType: 'contact.propertyChange', objectId: c.id, propertyName: p, propertyValue: props[p] })), by);
  }

  // Monotonic ms timestamps so "last updated wins" comparisons are deterministic.
  private lastTs = 0;
  private tick() {
    this.lastTs = Math.max(Date.now(), this.lastTs + 1);
    return new Date(this.lastTs).toISOString();
  }

  private view(c: Contact, props: string[]) {
    const keep = new Set([...props, 'createdate', 'lastmodifieddate', 'hs_object_id', 'email', 'firstname', 'lastname']);
    const properties: Record<string, string | null> = {};
    for (const k of keep) properties[k] = c.properties[k] ?? null;
    return { id: c.id, properties, createdAt: c.createdAt, updatedAt: c.updatedAt, archived: false };
  }

  private emit(events: Array<Record<string, unknown>>, by: 'api' | 'ui') {
    if (!this.opts.webhookUrl || events.length === 0) return;
    const body = JSON.stringify(
      events.map((e) => ({
        eventId: Math.floor(Math.random() * 1e12),
        subscriptionId: 1,
        portalId: this.portalId,
        appId: Number(this.opts.appId),
        occurredAt: Date.now(),
        attemptNumber: 0,
        changeSource: by === 'api' ? 'INTEGRATION' : 'CRM_UI',
        ...(by === 'api' ? (this.opts.stampSourceId === false ? {} : { sourceId: this.opts.appId }) : { sourceId: 'userId:1' }),
        ...e,
        objectId: Number(e.objectId),
      })),
    );
    const ts = String(Date.now());
    const sig = signHubSpotV3(this.opts.clientSecret, 'POST', this.opts.webhookUrl, body, ts);
    const p = new Promise((r) => setTimeout(r, 30)).then(() =>
      fetch(this.opts.webhookUrl!, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': ts }, body })
        .then(() => void this.webhooksSent++)
        .catch(() => undefined),
    );
    this.pending.push(p);
  }

  private uiPage() {
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    const cols = ['email', 'firstname', 'lastname', 'phone', 'company', 'jobtitle', 'wix_utm_source', 'wix_utm_medium', 'wix_utm_campaign', 'wix_first_utm_source', 'wix_page_url', 'wix_referrer', 'wix_form_submitted_at', 'lifecyclestage'];
    const editable = ['email', 'firstname', 'lastname', 'phone', 'company', 'jobtitle'];
    const rows = [...this.contacts.values()]
      .map((c) => `<tr><td>${c.id}</td>${cols.map((k) => `<td>${esc(c.properties[k])}</td>`).join('')}<td><form method="post" action="/_ui/contacts" style="display:flex;gap:4px"><input type="hidden" name="id" value="${c.id}">
        ${editable.map((k) => `<input name="${k}" value="${esc(c.properties[k])}" placeholder="${k}" size="9">`).join('')}<button>Save</button></form></td></tr>`)
      .join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Mock HubSpot CRM</title><meta http-equiv="refresh" content="8">
      <style>body{font-family:system-ui;margin:24px;color:#33475b}table{border-collapse:collapse;font-size:12px}td,th{border:1px solid #cbd6e2;padding:4px 6px;text-align:left}th{background:#f5f8fa}h1{color:#ff7a59}</style></head>
      <body><h1>Mock HubSpot CRM — portal ${this.portalId}</h1><p>Edits here behave like a user editing in HubSpot (webhooks with changeSource=CRM_UI).</p>
      <table><tr><th>id</th>${cols.map((c) => `<th>${c}</th>`).join('')}<th>edit</th></tr>${rows}</table>
      <h3>New contact</h3><form method="post" action="/_ui/contacts">${editable.map((k) => `<input name="${k}" placeholder="${k}">`).join(' ')} <button>Create</button></form></body></html>`;
  }
}

function clean(input: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}
