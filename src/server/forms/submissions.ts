import type { Store } from '../store.js';
import type { HubSpotClient } from '../hubspot/client.js';
import type { HubSpotPropertyOption } from '../../shared/types.js';
import { piiHash } from '../crypto.js';
import { normalize } from '../wix/fields.js';
import { FIRST_TOUCH_KEYS, UTM_KEYS, sanitizeAttribution, type Attribution } from './attribution.js';

export interface FormSubmissionInput {
  id: string;
  formId?: string | null;
  contactId?: string | null;
  createdDate?: string | Date | null;
  values: Record<string, unknown>;
}

export interface FormCaptureDeps {
  store: Store;
  hubspot(instanceId: string): HubSpotClient;
  hubspotProperties(instanceId: string): Promise<HubSpotPropertyOption[]>;
  hashKey: Buffer;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Wix Forms field keys look like "first_name_9a1b" — strip the random suffix.
const baseKey = (k: string) => k.toLowerCase().replace(/[_-][0-9a-f]{3,}$/i, '').replace(/[^a-z0-9_]/g, '_');

function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', ');
  if (typeof v === 'object') return Object.values(v as object).map(asText).filter(Boolean).join(', ');
  return String(v).trim();
}

/** Pull well-known fields out of a Wix Forms submission. */
export function parseSubmission(values: Record<string, unknown>) {
  const used = new Set<string>();
  const find = (re: RegExp, accept: (v: string) => boolean = (v) => v !== '') => {
    for (const [k, v] of Object.entries(values)) {
      const t = asText(v);
      if (!used.has(k) && re.test(baseKey(k)) && accept(t)) {
        used.add(k);
        return t;
      }
    }
    return '';
  };
  let email = find(/e_?mail/, (v) => EMAIL_RE.test(v));
  if (!email) email = find(/.*/, (v) => EMAIL_RE.test(v));
  let firstName = find(/^first_?name|^given_?name|^fname/);
  let lastName = find(/^last_?name|^surname|^family_?name|^lname/);
  if (!firstName && !lastName) {
    const full = find(/^(full_?)?name$/);
    [firstName, lastName] = [full.split(/\s+/)[0] ?? '', full.split(/\s+/).slice(1).join(' ')];
  }
  const phone = find(/phone|mobile|tel/);
  const hidden: Record<string, string> = {};
  for (const k of [...UTM_KEYS, 'page_url', 'referrer', 'landing_page']) {
    const v = find(new RegExp(`^${k}$`));
    if (v) hidden[k] = v;
  }
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (!used.has(k) && asText(v)) rest[k] = asText(v);
  return { email: email.toLowerCase(), firstName, lastName, phone, hidden, rest };
}

/**
 * Feature #2 — Wix Forms as the UI, HubSpot as the destination.
 * On `wix.forms.v4.submission_created` we create/update the HubSpot contact by email and
 * attach attribution: UTM (last + first touch), landing page, page URL, referrer, timestamp.
 */
export class FormCapture {
  constructor(private deps: FormCaptureDeps) {}

  async handle(instanceId: string, sub: FormSubmissionInput, receivedAt: number) {
    const { store } = this.deps;
    const parsed = parseSubmission(sub.values);
    if (!parsed.email) {
      store.logFormEvent({ instanceId, submissionId: sub.id, formId: sub.formId, wixContactId: sub.contactId, status: 'skipped', detail: 'no email field in submission' });
      return { status: 'skipped' as const };
    }

    // Attribution: prefer what the site script captured (keyed by hashed email), fall back to hidden fields.
    const beacon = store.latestAttribution(instanceId, piiHash(this.deps.hashKey, `${instanceId}\u0000${parsed.email}`), 30 * 60_000) ?? {};
    const attr: Attribution = { ...sanitizeAttribution(parsed.hidden), ...sanitizeAttribution(beacon) };

    const hs = this.deps.hubspot(instanceId);
    const hsProps = await this.deps.hubspotProperties(instanceId);
    const writable = new Map(hsProps.filter((p) => !p.readOnly).map((p) => [p.name, p]));

    const props: Record<string, string> = { email: parsed.email };
    if (parsed.firstName) props.firstname = parsed.firstName;
    if (parsed.lastName) props.lastname = parsed.lastName;
    if (parsed.phone) props.phone = parsed.phone;

    // Custom fields: a field whose key matches a HubSpot property name maps onto it; the rest is kept as text.
    const extras: string[] = [];
    for (const [k, v] of Object.entries(parsed.rest)) {
      const name = baseKey(k);
      if (writable.has(name) && !(name in props) && !name.startsWith('wix_')) props[name] = v;
      else extras.push(`${name}: ${v}`);
    }

    for (const k of UTM_KEYS) if (attr[k]) props[`wix_${k}`] = attr[k]!;
    if (attr.page_url) props.wix_page_url = attr.page_url;
    if (attr.referrer) props.wix_referrer = attr.referrer;
    props.wix_form_submitted_at = new Date(sub.createdDate ?? receivedAt).toISOString();
    if (sub.formId) props.wix_form_id = sub.formId;
    if (extras.length) props.wix_form_fields = extras.join('\n').slice(0, 5000);

    const firstTouch: Record<string, string> = {};
    for (const k of FIRST_TOUCH_KEYS) {
      const v = attr[`first_${k}`] ?? attr[k];
      if (v) firstTouch[`wix_first_${k}`] = v;
    }
    if (attr.landing_page) firstTouch.wix_landing_page = attr.landing_page;

    // The contact may already exist — e.g. contact sync created it from the Wix contact the
    // form produced. First-touch values and the lead stage are only filled when empty.
    const existing = await hs.findByEmail(parsed.email, [...Object.keys(firstTouch), 'lifecyclestage']);
    let contactId: string;
    if (existing) {
      for (const [k, v] of Object.entries(firstTouch)) if (!normalize(existing.properties[k])) props[k] = v;
      if (!normalize(existing.properties.lifecyclestage)) props.lifecyclestage = 'lead';
      contactId = (await hs.updateContact(existing.id, props)).id;
    } else {
      contactId = (await hs.createContact({ ...props, ...firstTouch, lifecyclestage: 'lead' })).id;
    }

    store.logFormEvent({
      instanceId,
      submissionId: sub.id,
      formId: sub.formId,
      wixContactId: sub.contactId,
      hubspotContactId: contactId,
      status: existing ? 'updated' : 'created',
      utm: attr as Record<string, string>,
      latencyMs: Date.now() - receivedAt,
      detail: Object.keys(attr).length ? `attribution: ${Object.keys(attr).join(', ')}` : 'no attribution captured',
    });
    return { status: existing ? ('updated' as const) : ('created' as const), hubspotContactId: contactId };
  }
}
