import { describe, it, expect } from 'vitest';
import { verifyInstance, signInstance, InstanceAuthError } from '../src/server/wix/instance.js';
import { verifyHubSpotSignatureV3, signHubSpotV3, isOwnHubSpotWrite } from '../src/server/hubspot/webhooks.js';
import { validateMappings, applyTransform, project } from '../src/server/sync/mapping.js';
import { resolveConflict } from '../src/server/sync/engine.js';
import { WixFieldCatalog } from '../src/server/wix/fields.js';
import { scrub, scrubString } from '../src/server/logger.js';
import { parseSubmission } from '../src/server/forms/submissions.js';
import { encrypt, decrypt } from '../src/server/crypto.js';
import { DEFAULT_MAPPINGS } from '../src/server/store.js';
import type { FieldMapping, HubSpotPropertyOption } from '../src/shared/types.js';

const SECRET = 'app-secret';
const opts = { appId: 'app-1', maxAgeHours: 24 };

describe('Wix instance token', () => {
  it('accepts a valid signature and returns the instance id', () => {
    const t = signInstance({ instanceId: 'inst-1', appDefId: 'app-1', signDate: new Date().toISOString() }, SECRET);
    expect(verifyInstance(t, SECRET, opts).instanceId).toBe('inst-1');
  });
  it('rejects tampered payloads, other apps and stale tokens', () => {
    const t = signInstance({ instanceId: 'inst-1', appDefId: 'app-1' }, SECRET);
    const [sig] = t.split('.');
    const forged = `${sig}.${Buffer.from(JSON.stringify({ instanceId: 'victim' })).toString('base64url')}`;
    expect(() => verifyInstance(forged, SECRET, opts)).toThrow(InstanceAuthError);
    expect(() => verifyInstance(signInstance({ instanceId: 'i', appDefId: 'other' }, SECRET), SECRET, opts)).toThrow(/another app/);
    const old = signInstance({ instanceId: 'i', signDate: new Date(Date.now() - 48 * 3600_000).toISOString() }, SECRET);
    expect(() => verifyInstance(old, SECRET, opts)).toThrow(/expired/);
    expect(() => verifyInstance('garbage', SECRET, opts)).toThrow();
  });
});

describe('HubSpot signature v3', () => {
  const uri = 'https://app.example.com/webhooks/hubspot';
  it('verifies a correctly signed request and rejects wrong body / old timestamp', () => {
    const ts = String(Date.now());
    const sig = signHubSpotV3('cs', 'POST', uri, '[{"a":1}]', ts);
    expect(verifyHubSpotSignatureV3({ clientSecret: 'cs', method: 'POST', uri, rawBody: '[{"a":1}]', signature: sig, timestamp: ts })).toBe(true);
    expect(verifyHubSpotSignatureV3({ clientSecret: 'cs', method: 'POST', uri, rawBody: '[{"a":2}]', signature: sig, timestamp: ts })).toBe(false);
    const oldTs = String(Date.now() - 10 * 60_000);
    const oldSig = signHubSpotV3('cs', 'POST', uri, '[]', oldTs);
    expect(verifyHubSpotSignatureV3({ clientSecret: 'cs', method: 'POST', uri, rawBody: '[]', signature: oldSig, timestamp: oldTs })).toBe(false);
  });
  it('detects our own writes by origin tag', () => {
    const base = { eventId: 1, subscriptionType: 'contact.propertyChange', portalId: 1, objectId: 1, occurredAt: 0 };
    expect(isOwnHubSpotWrite({ ...base, changeSource: 'INTEGRATION', sourceId: '99' }, '99')).toBe(true);
    expect(isOwnHubSpotWrite({ ...base, changeSource: 'CRM_UI', sourceId: 'userId:5' }, '99')).toBe(false);
    expect(isOwnHubSpotWrite({ ...base, changeSource: 'INTEGRATION', sourceId: '12' }, '99')).toBe(false);
  });
});

describe('field mapping validation', () => {
  const catalog = new WixFieldCatalog([{ key: 'custom.tier', displayName: 'Tier', dataType: 'TEXT' }]);
  const props: HubSpotPropertyOption[] = [
    { name: 'email', label: 'Email', type: 'string', readOnly: false },
    { name: 'firstname', label: 'First', type: 'string', readOnly: false },
    { name: 'lastname', label: 'Last', type: 'string', readOnly: false },
    { name: 'phone', label: 'Phone', type: 'string', readOnly: false },
    { name: 'company', label: 'Company', type: 'string', readOnly: false },
    { name: 'jobtitle', label: 'Job', type: 'string', readOnly: false },
    { name: 'createdate', label: 'Create date', type: 'datetime', readOnly: true },
  ];
  it('accepts the defaults', () => {
    expect(validateMappings(DEFAULT_MAPPINGS, catalog, props)).toEqual([]);
  });
  it('rejects duplicate HubSpot targets, read-only targets, unknown fields and a missing email row', () => {
    const bad: FieldMapping[] = [
      { wixField: 'name.first', hubspotProperty: 'firstname', direction: 'bidirectional', transform: 'none' },
      { wixField: 'name.last', hubspotProperty: 'firstname', direction: 'wix_to_hubspot', transform: 'none' },
      { wixField: 'company', hubspotProperty: 'createdate', direction: 'wix_to_hubspot', transform: 'none' },
      { wixField: 'nope', hubspotProperty: 'phone', direction: 'hubspot_to_wix', transform: 'none' },
    ];
    const msgs = validateMappings(bad, catalog, props).map((i) => i.message).join('\n');
    expect(msgs).toMatch(/email/i);
    expect(msgs).toMatch(/already written by row 1/);
    expect(msgs).toMatch(/read-only/);
    expect(msgs).toMatch(/Unknown Wix field/);
  });
  it('allows the same HubSpot property to feed two Wix fields when it is only read', () => {
    const ok: FieldMapping[] = [
      ...DEFAULT_MAPPINGS,
      { wixField: 'custom.tier', hubspotProperty: 'company', direction: 'hubspot_to_wix', transform: 'none' },
    ];
    expect(validateMappings(ok, catalog, props)).toEqual([]);
  });
});

describe('transforms and conflict rule', () => {
  it('applies transforms and defaults', () => {
    expect(applyTransform('trim', '  a ')).toBe('a');
    expect(applyTransform('lowercase', ' A@B.COM ')).toBe('a@b.com');
    expect(applyTransform('titlecase', "mary-jane o'neil")).toBe("Mary-Jane O'Neil");
    expect(project({ wixField: 'company', hubspotProperty: 'company', direction: 'bidirectional', transform: 'uppercase', defaultValue: 'n/a' }, '')).toBe('N/A');
  });
  it('last updated wins, with deterministic priorities', () => {
    expect(resolveConflict('last_updated_wins', 200, 100, 'hubspot')).toBe('wix');
    expect(resolveConflict('last_updated_wins', 100, 200, 'wix')).toBe('hubspot');
    expect(resolveConflict('last_updated_wins', 0, 0, 'hubspot')).toBe('hubspot');
    expect(resolveConflict('hubspot_wins', 999, 1, 'wix')).toBe('hubspot');
    expect(resolveConflict('wix_wins', 1, 999, 'hubspot')).toBe('wix');
  });
});

describe('Wix field catalog', () => {
  it('reads and builds ContactInfo patches without dropping other emails/phones', () => {
    const cat = new WixFieldCatalog();
    const contact = {
      _id: 'c1',
      primaryInfo: { email: 'a@x.com' },
      info: { name: { first: 'Ann', last: 'Lee' }, emails: { items: [{ email: 'a@x.com', primary: true }, { email: 'work@x.com', tag: 'WORK' }] } },
    };
    expect(cat.get(contact, 'name.first')).toBe('Ann');
    const info = cat.buildInfo(contact, { 'name.first': 'Anna', email: 'new@x.com', 'address.city': 'Pune' });
    expect(info.name).toEqual({ first: 'Anna', last: 'Lee' });
    expect(info.emails?.items?.map((e) => e.email)).toEqual(['new@x.com', 'work@x.com']);
    expect(info.addresses?.items?.[0].address?.city).toBe('Pune');
    expect(cat.buildInfo(contact, { email: '' }).emails).toBeUndefined(); // identity is never cleared
  });
});

describe('safe logging', () => {
  it('redacts tokens and PII', () => {
    const out = JSON.stringify(scrub({ accessToken: 'at-123', instanceId: 'i-1', err: new Error('failed for bob@example.com with Bearer abc.def'), properties: { email: 'x@y.z' } }));
    expect(out).not.toContain('at-123');
    expect(out).not.toContain('bob@example.com');
    expect(out).not.toContain('abc.def');
    expect(out).not.toContain('x@y.z');
    expect(out).toContain('i-1');
    expect(scrubString('token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc')).not.toContain('eyJ');
  });
  it('encrypts secrets at rest', () => {
    const key = Buffer.alloc(32, 7);
    const ct = encrypt(key, 'refresh-token');
    expect(ct).not.toContain('refresh');
    expect(decrypt(key, ct)).toBe('refresh-token');
  });
});

describe('form submission parsing', () => {
  it('finds email/name/phone/hidden UTM fields from Wix Forms keys', () => {
    const p = parseSubmission({ first_name_a1b2: 'Ann', last_name_c3d4: 'Lee', email_5e6f: 'ANN@X.COM', phone_77aa: '+1 555', utm_source: 'google', company_size: '50', consent: true });
    expect(p).toMatchObject({ email: 'ann@x.com', firstName: 'Ann', lastName: 'Lee', phone: '+1 555', hidden: { utm_source: 'google' } });
    expect(Object.keys(p.rest)).toEqual(['company_size', 'consent']);
  });
  it('splits a single full-name field', () => {
    expect(parseSubmission({ name: 'Ann Marie Lee', contact: 'a@b.co' })).toMatchObject({ firstName: 'Ann', lastName: 'Marie Lee', email: 'a@b.co' });
  });
});
