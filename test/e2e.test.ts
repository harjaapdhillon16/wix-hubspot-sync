/**
 * End-to-end: real app (HTTP routes, OAuth, webhook signatures, queue, engine) against
 * the HubSpot emulator and the fake Wix site, communicating over HTTP webhooks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startStack, type Stack } from '../dev/stack.js';
import { hubspotTokenSecretName } from '../src/server/secrets/index.js';

const wixInfo = (email: string, first: string, last: string, extra: Record<string, unknown> = {}) => ({
  name: { first, last },
  emails: { items: [{ email, tag: 'MAIN', primary: true }] },
  ...extra,
});

describe.each([
  ['origin tags on', true],
  ['origin tags off (hash/idempotency layer alone)', false],
])('bi-directional sync — %s', (_label, stampSourceId) => {
  let s: Stack;
  beforeEach(async () => {
    s = await startStack({ stampSourceId });
    expect((await s.connect()).status).toBe(200);
  });
  afterEach(() => s.stop());

  it('Wix create -> HubSpot contact with mapped properties, no ping-pong', async () => {
    const c = s.wix.userUpsert(s.instanceId, wixInfo('ann@example.com', 'Ann', 'Lee', { company: 'Acme', jobTitle: 'CTO' }));
    await s.settle();

    const hs = s.hubspot.byEmail('ann@example.com')!;
    expect(hs.properties).toMatchObject({ firstname: 'Ann', lastname: 'Lee', company: 'Acme', jobtitle: 'CTO' });
    expect(s.ctx.store.linkByWix(s.instanceId, c._id!)?.hubspotContactId).toBe(hs.id);
    // Exactly one HubSpot write and zero writes back into Wix.
    expect(s.hubspot.apiWrites.filter((w) => w.id === hs.id)).toHaveLength(1);
    expect(s.wix.appWrites).toHaveLength(0);
  });

  it('HubSpot update -> Wix update, and Wix update -> HubSpot update, each exactly once', async () => {
    const c = s.wix.userUpsert(s.instanceId, wixInfo('bo@example.com', 'Bo', 'Diaz'));
    await s.settle();
    const hs = s.hubspot.byEmail('bo@example.com')!;
    const writesBefore = s.hubspot.apiWrites.length;

    s.hubspot.uiUpsert({ firstname: 'Bobby', phone: '+1 555 0100' }, hs.id);
    await s.settle();
    const wixC = (await s.wix.getContact(s.instanceId, c._id!))!;
    expect(wixC.info?.name?.first).toBe('Bobby');
    expect(wixC.primaryInfo?.phone).toBe('+1 555 0100');
    expect(s.wix.appWrites).toHaveLength(1);
    expect(s.hubspot.apiWrites.length).toBe(writesBefore); // no echo back to HubSpot

    s.wix.userUpsert(s.instanceId, { company: 'Globex' }, c._id);
    await s.settle();
    expect(s.hubspot.contacts.get(hs.id)!.properties.company).toBe('Globex');
    expect(s.hubspot.apiWrites.length).toBe(writesBefore + 1);
    expect(s.wix.appWrites).toHaveLength(1); // still just the one from the HubSpot edit
  });

  it('HubSpot create -> Wix contact', async () => {
    s.hubspot.uiUpsert({ email: 'cy@example.com', firstname: 'Cy', lastname: 'Ng', jobtitle: 'PM' });
    await s.settle();
    const wixC = s.wix.allContacts(s.instanceId).find((c) => c.primaryInfo?.email === 'cy@example.com')!;
    expect(wixC.info).toMatchObject({ name: { first: 'Cy', last: 'Ng' }, jobTitle: 'PM' });
    expect(s.hubspot.apiWrites).toHaveLength(0);
  });
});

describe('conflicts, mapping, security, forms', () => {
  let s: Stack;
  beforeEach(async () => {
    s = await startStack();
    await s.connect();
  });
  afterEach(() => s.stop());

  it('matches existing contacts by email instead of duplicating, filling gaps on both sides', async () => {
    const hs = s.hubspot.uiUpsert({ email: 'dee@example.com', firstname: 'Dee', company: 'Initech' });
    await s.settle();
    const before = s.wix.allContacts(s.instanceId).length;
    expect(before).toBe(1);
    const wixC = s.wix.allContacts(s.instanceId)[0];
    s.wix.userUpsert(s.instanceId, { name: { first: 'Dee', last: 'Park' } }, wixC._id);
    await s.settle();
    expect(s.hubspot.contacts.size).toBe(1);
    expect(s.hubspot.contacts.get(hs.id)!.properties.lastname).toBe('Park');
  });

  it('conflict: last updated wins when both sides changed the same field', async () => {
    const c = s.wix.userUpsert(s.instanceId, wixInfo('eve@example.com', 'Eve', 'Old'));
    await s.settle();
    const hs = s.hubspot.byEmail('eve@example.com')!;
    // Pause processing so both edits land before reconciliation.
    s.ctx.queue.stop();
    s.wix.userUpsert(s.instanceId, { name: { first: 'Eve', last: 'FromWix' } }, c._id);
    await new Promise((r) => setTimeout(r, 15));
    s.hubspot.uiUpsert({ lastname: 'FromHubSpot' }, hs.id); // newer
    await s.wix.flush();
    await s.hubspot.flush();
    s.ctx.queue.start(40);
    await s.settle();
    expect((await s.wix.getContact(s.instanceId, c._id!))!.info?.name?.last).toBe('FromHubSpot');
    expect(s.hubspot.contacts.get(hs.id)!.properties.lastname).toBe('FromHubSpot');
    expect(s.ctx.store.recentActivity(s.instanceId).some((a) => a.detail?.includes('conflicts='))).toBe(true);
  });

  it('respects saved mapping rules: direction, transform and custom fields', async () => {
    const { body } = await s.api('GET', '/fields');
    expect(body.wixFields.map((f: { key: string }) => f.key)).toContain('custom.membership-tier');
    expect(body.wixFields.map((f: { key: string }) => f.key)).not.toContain('emailSubscriptions.effectiveEmail');
    expect(body.hubspotProperties.map((p: { name: string }) => p.name)).toContain('wix_utm_source'); // created on connect

    const mappings = [
      { wixField: 'email', hubspotProperty: 'email', direction: 'bidirectional', transform: 'lowercase' },
      { wixField: 'name.first', hubspotProperty: 'firstname', direction: 'wix_to_hubspot', transform: 'titlecase' },
      { wixField: 'custom.membership-tier', hubspotProperty: 'membership_tier', direction: 'bidirectional', transform: 'none', defaultValue: 'free' },
    ];
    const dupe = await s.api('PUT', '/mappings', { mappings: [...mappings, { wixField: 'name.last', hubspotProperty: 'firstname', direction: 'bidirectional', transform: 'none' }] });
    expect(dupe.status).toBe(422);
    expect((await s.api('PUT', '/mappings', { mappings })).status).toBe(200);

    const c = s.wix.userUpsert(s.instanceId, wixInfo('Fay@Example.com', 'fay', 'Wong'));
    await s.settle();
    const hs = s.hubspot.byEmail('fay@example.com')!;
    expect(hs.properties).toMatchObject({ firstname: 'Fay', membership_tier: 'free' });
    expect(hs.properties.lastname).toBeUndefined(); // not mapped any more

    s.hubspot.uiUpsert({ firstname: 'Changed', membership_tier: 'gold' }, hs.id);
    await s.settle();
    const wixC = (await s.wix.getContact(s.instanceId, c._id!))!;
    expect(wixC.info?.name?.first).toBe('fay'); // wix_to_hubspot only
    expect(wixC.info?.extendedFields?.items?.['custom.membership-tier']).toBe('gold');
  });

  it('Wix form submission -> HubSpot contact with UTM attribution within seconds', async () => {
    const inst = s.ctx.store.getInstallation(s.instanceId)!;
    expect(s.wix.embedded.get(s.instanceId)).toMatchObject({ siteKey: inst.siteKey });

    // The site script beacons attribution when the visitor submits.
    const beacon = await fetch(`${s.cfg.APP_BASE_URL}/public/attribution`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({
        siteKey: inst.siteKey,
        email: 'gus@example.com',
        attribution: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'spring', utm_term: 'crm', utm_content: 'ad1', first_utm_source: 'newsletter', landing_page: 'https://site.com/?utm_source=google', page_url: 'https://site.com/contact', referrer: 'https://www.google.com/', evil: '<x>' },
      }),
    });
    expect(beacon.status).toBe(204);

    const started = Date.now();
    s.wix.submitForm(s.instanceId, 'form-123', { first_name_ab12: 'Gus', last_name_cd34: 'Hale', email_ef56: 'gus@example.com', company_size_9f9f: '11-50' }, wixInfo('gus@example.com', 'Gus', 'Hale'));
    await s.settle();

    const hs = s.hubspot.byEmail('gus@example.com')!;
    expect(hs.properties).toMatchObject({
      firstname: 'Gus', lastname: 'Hale', lifecyclestage: 'lead',
      wix_utm_source: 'google', wix_utm_medium: 'cpc', wix_utm_campaign: 'spring', wix_utm_term: 'crm', wix_utm_content: 'ad1',
      wix_first_utm_source: 'newsletter', wix_page_url: 'https://site.com/contact', wix_referrer: 'https://www.google.com/', wix_form_id: 'form-123',
    });
    expect(hs.properties.wix_form_fields).toContain('company_size: 11-50');
    expect(hs.properties.wix_form_submitted_at).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(s.hubspot.contacts.size).toBe(1); // contact sync linked it instead of duplicating

    const form = (await s.api('GET', '/activity')).body.forms[0];
    // created or updated depending on whether the contact-sync webhook won the race; both are correct.
    expect(form).toMatchObject({ utmSource: 'google', utmCampaign: 'spring', hubspotContactId: hs.id });
    expect(['created', 'updated']).toContain(form.status);

    // Second submission: last-touch updates, first-touch is preserved.
    await fetch(`${s.cfg.APP_BASE_URL}/public/attribution`, { method: 'POST', body: JSON.stringify({ siteKey: inst.siteKey, email: 'gus@example.com', attribution: { utm_source: 'linkedin', first_utm_source: 'linkedin' } }) });
    s.wix.submitForm(s.instanceId, 'form-123', { email: 'gus@example.com' }, wixInfo('gus@example.com', 'Gus', 'Hale'));
    await s.settle();
    expect(s.hubspot.byEmail('gus@example.com')!.properties).toMatchObject({ wix_utm_source: 'linkedin', wix_first_utm_source: 'newsletter' });
  });

  it('falls back to hidden UTM form fields when no beacon arrived', async () => {
    s.wix.submitForm(s.instanceId, 'f2', { email: 'hal@example.com', utm_source: 'facebook', utm_campaign: 'promo' }, wixInfo('hal@example.com', 'Hal', ''));
    await s.settle();
    expect(s.hubspot.byEmail('hal@example.com')!.properties).toMatchObject({ wix_utm_source: 'facebook', wix_utm_campaign: 'promo' });
  });

  it('requires a valid Wix instance on every dashboard endpoint and keeps tokens server-side', async () => {
    expect((await s.api('GET', '/status', undefined, null)).status).toBe(401);
    expect((await s.api('GET', '/status', undefined, 'abc.def')).status).toBe(401);
    expect((await s.api('PUT', '/mappings', { mappings: [] }, null)).status).toBe(401);
    expect((await s.api('POST', '/sync/full', undefined, null)).status).toBe(401);

    const status = await s.api('GET', '/status');
    expect(status.body).toMatchObject({ connected: true, portalId: String(s.hubspot.portalId) });
    const everything = JSON.stringify([status.body, (await s.api('GET', '/activity')).body, (await s.api('GET', '/mappings')).body]);
    expect(everything).not.toMatch(/at-[0-9a-f]{8}|rt-[0-9a-f]{8}/);

    // Tokens are encrypted at rest, not in the installations table.
    const raw = s.ctx.db.prepare('SELECT ciphertext FROM secrets').all() as Array<{ ciphertext: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].ciphertext).not.toMatch(/rt-|at-/);
  });

  it('rejects unsigned / forged webhooks', async () => {
    const hs = await fetch(`${s.cfg.APP_BASE_URL}/webhooks/hubspot`, { method: 'POST', body: '[]', headers: { 'x-hubspot-signature-v3': 'nope', 'x-hubspot-request-timestamp': String(Date.now()) } });
    expect(hs.status).toBe(401);
    const wix = await fetch(`${s.cfg.APP_BASE_URL}/webhooks/wix`, { method: 'POST', body: JSON.stringify({ data: '[]', sig: 'bad' }) });
    expect(wix.status).toBe(401);
  });

  it('refreshes expired access tokens transparently', async () => {
    s.hubspot.expireAllAccessTokens();
    s.wix.userUpsert(s.instanceId, wixInfo('ivy@example.com', 'Ivy', 'Ro'));
    await s.settle();
    expect(s.hubspot.byEmail('ivy@example.com')).toBeTruthy();
  });

  it('disconnect revokes the refresh token, deletes the secret and stops sync', async () => {
    const secretName = hubspotTokenSecretName(s.cfg.SECRET_PREFIX, s.instanceId);
    expect(await s.ctx.secrets.get(secretName)).toBeTruthy();
    expect((await s.api('POST', '/hubspot/disconnect')).status).toBe(200);
    expect(await s.ctx.secrets.get(secretName)).toBeNull();
    expect(s.hubspot.revokedRefreshTokens.size).toBe(1);
    expect((await s.api('GET', '/status')).body.connected).toBe(false);

    s.wix.userUpsert(s.instanceId, wixInfo('jay@example.com', 'Jay', 'Ko'));
    await s.settle();
    expect(s.hubspot.byEmail('jay@example.com')).toBeUndefined();
  });

  it('OAuth state is single use', async () => {
    const { body } = await s.api<{ authorizeUrl: string }>('POST', '/hubspot/connect');
    const url = new URL(body.authorizeUrl);
    const cb = (code: string) => fetch(`${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}`);
    expect((await cb(s.hubspot.issueCode(url.searchParams.get('redirect_uri')!))).status).toBe(200);
    expect((await cb(s.hubspot.issueCode(url.searchParams.get('redirect_uri')!))).status).toBe(400);
    expect(url.searchParams.get('scope')).toBe('oauth crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write');
  });

  it('"Sync now" reconciles existing contacts on both sides', async () => {
    await s.api('PUT', '/settings', { syncEnabled: false });
    s.wix.userUpsert(s.instanceId, wixInfo('kim@example.com', 'Kim', 'Wu'));
    s.hubspot.uiUpsert({ email: 'lee@example.com', firstname: 'Lee' });
    await s.settle();
    expect(s.hubspot.contacts.size).toBe(1);
    await s.api('PUT', '/settings', { syncEnabled: true });
    expect((await s.api('POST', '/sync/full')).status).toBe(202);
    await s.settle();
    expect(s.hubspot.byEmail('kim@example.com')).toBeTruthy();
    expect(s.wix.allContacts(s.instanceId).some((c) => c.primaryInfo?.email === 'lee@example.com')).toBe(true);
    expect((await s.api('GET', '/status')).body.stats.linkedContacts).toBe(2);
  });
});

describe('Wix embedded-script parameter escaping', () => {
  it('serves the script and accepts beacons on the doubled-slash paths browsers produce from "\\/"', async () => {
    const s = await startStack();
    try {
      expect((await fetch(`${s.cfg.APP_BASE_URL}//public//attribution.js`)).status).toBe(200);
      expect((await fetch(`${s.cfg.APP_BASE_URL}//public//attribution`, { method: 'POST', body: '{}' })).status).toBe(400); // reached the route (body invalid)
    } finally {
      await s.stop();
    }
  });
});
