/**
 * In-memory stand-in for the Wix side (Contacts v4, Forms submissions, embedded scripts,
 * webhooks). Writes made through the gateway are stamped with identity {APP, appId} — exactly
 * what Wix puts on webhooks for changes an app makes — while `userUpsert`/`submitForm`
 * simulate the site owner / a visitor.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { WixGateway } from '../src/server/wix/gateway.js';
import type { WixContact, WixContactInfo } from '../src/server/wix/fields.js';
import type { WixEvent, WixEventParser } from '../src/server/wix/events.js';
import type { FormSubmissionInput } from '../src/server/forms/submissions.js';
import { safeEqual } from '../src/server/crypto.js';

export class FakeWix implements WixGateway {
  contacts = new Map<string, WixContact>(); // key: instanceId/contactId
  submissions = new Map<string, FormSubmissionInput>();
  embedded = new Map<string, Record<string, string>>();
  appWrites: Array<{ id: string; fields: string[] }> = [];
  webhooksSent = 0;
  private pending: Promise<unknown>[] = [];
  private lastTs = 0;

  constructor(public opts: { appId: string; webhookSecret: string; webhookUrl?: string }) {}

  // ---------- WixGateway ----------
  async getContact(instanceId: string, id: string) {
    const c = this.contacts.get(`${instanceId}/${id}`);
    return c ? structuredClone(c) : null;
  }

  async findContactByEmail(instanceId: string, email: string) {
    for (const [k, c] of this.contacts) if (k.startsWith(instanceId + '/') && c.primaryInfo?.email?.toLowerCase() === email.toLowerCase()) return structuredClone(c);
    return null;
  }

  async createContact(instanceId: string, info: WixContactInfo) {
    return this.write(instanceId, null, info, { identityType: 'APP', appId: this.opts.appId });
  }

  async updateContact(instanceId: string, id: string, info: WixContactInfo, revision: number) {
    const cur = this.contacts.get(`${instanceId}/${id}`);
    if (!cur) throw Object.assign(new Error('Contact not found'), { response: { status: 404 } });
    if (cur.revision !== revision) throw new Error('revision mismatch');
    return this.write(instanceId, id, info, { identityType: 'APP', appId: this.opts.appId });
  }

  async *iterateContacts(instanceId: string) {
    for (const [k, c] of this.contacts) if (k.startsWith(instanceId + '/')) yield structuredClone(c);
  }

  async listExtendedFields() {
    return [
      { key: 'custom.membership-tier', displayName: 'Membership tier', dataType: 'TEXT' },
      { key: 'emailSubscriptions.effectiveEmail', displayName: 'Effective email', dataType: 'TEXT' },
    ];
  }

  async embedAttributionScript(instanceId: string, parameters: Record<string, string>) {
    this.embedded.set(instanceId, parameters);
  }

  async getFormSubmission(instanceId: string, submissionId: string) {
    return this.submissions.get(`${instanceId}/${submissionId}`) ?? null;
  }

  // ---------- simulation helpers ----------
  /** The site owner creates/edits a contact in the Wix dashboard. */
  userUpsert(instanceId: string, info: WixContactInfo, id?: string) {
    return this.write(instanceId, id ?? null, info, { identityType: 'WIX_USER' });
  }

  /** A visitor submits a Wix form: Wix Forms creates/updates the contact and the submission. */
  submitForm(instanceId: string, formId: string, values: Record<string, unknown>, contactInfo: WixContactInfo) {
    const email = contactInfo.emails?.items?.[0]?.email ?? '';
    const existing = [...this.contacts.entries()].find(([k, c]) => k.startsWith(instanceId + '/') && c.primaryInfo?.email === email)?.[1];
    const contact = this.write(instanceId, existing?._id ?? null, contactInfo, { identityType: 'APP', appId: 'wix-forms-app' });
    const sub: FormSubmissionInput = { id: randomUUID(), formId, contactId: contact._id, createdDate: new Date().toISOString(), values };
    this.submissions.set(`${instanceId}/${sub.id}`, sub);
    this.emit({ type: 'submission_created', instanceId, entityId: sub.id, eventId: randomUUID() });
    return sub;
  }

  async flush() {
    while (this.pending.length) await Promise.allSettled(this.pending.splice(0));
  }

  allContacts(instanceId: string) {
    return [...this.contacts.entries()].filter(([k]) => k.startsWith(instanceId + '/')).map(([, c]) => c);
  }

  private write(instanceId: string, id: string | null, info: WixContactInfo, identity: WixEvent['identity']): WixContact {
    const key = id ? `${instanceId}/${id}` : null;
    const cur = key ? this.contacts.get(key) : undefined;
    const next: WixContact = cur ? structuredClone(cur) : { _id: randomUUID(), revision: 0, info: {} };
    next.info = { ...next.info, ...structuredClone(info) };
    if (info.extendedFields) next.info.extendedFields = { items: { ...(cur?.info?.extendedFields?.items ?? {}), ...info.extendedFields.items } };
    next.revision = (next.revision ?? 0) + 1;
    this.lastTs = Math.max(Date.now(), this.lastTs + 1);
    next._updatedDate = new Date(this.lastTs);
    const pe = next.info.emails?.items?.find((e) => e.primary) ?? next.info.emails?.items?.[0];
    const pp = next.info.phones?.items?.find((p) => p.primary) ?? next.info.phones?.items?.[0];
    next.primaryInfo = { email: pe?.email ?? null, phone: pp?.phone ?? null };
    this.contacts.set(`${instanceId}/${next._id}`, next);
    if (identity?.appId === this.opts.appId) this.appWrites.push({ id: next._id!, fields: Object.keys(info) });
    this.emit({ type: cur ? 'contact_updated' : 'contact_created', instanceId, entityId: next._id!, eventId: randomUUID(), identity });
    return structuredClone(next);
  }

  private emit(e: WixEvent) {
    if (!this.opts.webhookUrl) return;
    const body = FakeWixEventParser.sign([e], this.opts.webhookSecret);
    const p = new Promise((r) => setTimeout(r, 20)).then(() =>
      fetch(this.opts.webhookUrl!, { method: 'POST', body, headers: { 'content-type': 'text/plain' } })
        .then(() => void this.webhooksSent++)
        .catch(() => undefined),
    );
    this.pending.push(p);
  }
}

/** Dev/test replacement for the SDK JWT verification: HMAC-signed JSON envelope. */
export class FakeWixEventParser implements WixEventParser {
  constructor(private secret: string) {}

  static sign(events: WixEvent[], secret: string) {
    const data = JSON.stringify(events);
    return JSON.stringify({ data, sig: createHmac('sha256', secret).update(data).digest('hex') });
  }

  async parse(raw: string): Promise<WixEvent[]> {
    const { data, sig } = JSON.parse(raw) as { data: string; sig: string };
    if (!safeEqual(createHmac('sha256', this.secret).update(data).digest('hex'), sig ?? '')) throw new Error('bad signature');
    return JSON.parse(data);
  }
}
