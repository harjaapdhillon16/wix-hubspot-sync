import type { WixFieldOption } from '../../shared/types.js';

/** Subset of the Wix Contacts v4 `Contact` shape that we read and write. */
export interface WixContact {
  _id?: string;
  revision?: number;
  _updatedDate?: Date | string | null;
  primaryInfo?: { email?: string | null; phone?: string | null };
  info?: WixContactInfo;
}

export interface WixContactInfo {
  name?: { first?: string | null; last?: string | null };
  emails?: { items?: Array<{ email?: string; tag?: string; primary?: boolean | null }> };
  phones?: { items?: Array<{ phone?: string; tag?: string; primary?: boolean | null; countryCode?: string | null }> };
  addresses?: { items?: Array<{ tag?: string; address?: Record<string, string | null | undefined> }> };
  company?: string | null;
  jobTitle?: string | null;
  birthdate?: string | null;
  locale?: string | null;
  extendedFields?: { items?: Record<string, unknown> };
}

interface FieldDef extends WixFieldOption {
  get(c: WixContact): unknown;
  set(info: WixContactInfo, current: WixContact, value: string): void;
}

function primaryOf<T extends { primary?: boolean | null }>(items: T[] | undefined): T | undefined {
  return items?.find((i) => i.primary) ?? items?.[0];
}

function addressField(part: string, label: string): FieldDef {
  return {
    key: `address.${part}`,
    label,
    type: 'text',
    get: (c) => c.info?.addresses?.items?.[0]?.address?.[part],
    set: (info, current, value) => {
      // Arrays are replaced as a whole by updateContact, so start from the current list.
      info.addresses ??= { items: structuredClone(current.info?.addresses?.items ?? []) };
      const items = info.addresses.items!;
      if (!items[0]) items.push({ tag: 'HOME', address: {} });
      items[0].address = { ...(items[0].address ?? {}), [part]: value || null };
    },
  };
}

const STANDARD_FIELDS: FieldDef[] = [
  {
    key: 'email',
    label: 'Primary email',
    type: 'email',
    locked: true,
    get: (c) => c.primaryInfo?.email ?? primaryOf(c.info?.emails?.items)?.email,
    set: (info, current, value) => {
      if (!value) return; // never clear the identity field
      const items = structuredClone(current.info?.emails?.items ?? []);
      const primary = primaryOf(items);
      if (primary) primary.email = value;
      else items.unshift({ email: value, tag: 'MAIN', primary: true });
      info.emails = { items };
    },
  },
  { key: 'name.first', label: 'First name', type: 'text', get: (c) => c.info?.name?.first, set: (i, cur, v) => void (i.name = { ...(i.name ?? cur.info?.name), first: v }) },
  { key: 'name.last', label: 'Last name', type: 'text', get: (c) => c.info?.name?.last, set: (i, cur, v) => void (i.name = { ...(i.name ?? cur.info?.name), last: v }) },
  {
    key: 'phone',
    label: 'Primary phone',
    type: 'phone',
    get: (c) => c.primaryInfo?.phone ?? primaryOf(c.info?.phones?.items)?.phone,
    set: (info, current, value) => {
      let items = structuredClone(current.info?.phones?.items ?? []);
      const primary = primaryOf(items);
      if (!value) items = items.filter((p) => p !== primary);
      else if (primary) primary.phone = value;
      else items.unshift({ phone: value, tag: 'MAIN', primary: true });
      info.phones = { items };
    },
  },
  { key: 'company', label: 'Company', type: 'text', get: (c) => c.info?.company, set: (i, _c, v) => void (i.company = v) },
  { key: 'jobTitle', label: 'Job title', type: 'text', get: (c) => c.info?.jobTitle, set: (i, _c, v) => void (i.jobTitle = v) },
  { key: 'birthdate', label: 'Birthdate (YYYY-MM-DD)', type: 'date', get: (c) => c.info?.birthdate, set: (i, _c, v) => void (i.birthdate = v || null) },
  { key: 'locale', label: 'Locale', type: 'text', get: (c) => c.info?.locale, set: (i, _c, v) => void (i.locale = v || null) },
  addressField('addressLine1', 'Address line 1'),
  addressField('addressLine2', 'Address line 2'),
  addressField('city', 'City'),
  addressField('subdivision', 'State / region'),
  addressField('postalCode', 'Postal code'),
  addressField('country', 'Country (ISO code)'),
];

/** Extended fields come from the site's custom contact fields (Wix "custom.*" keys). */
function extendedField(key: string, label: string, type: WixFieldOption['type']): FieldDef {
  return {
    key,
    label,
    type,
    get: (c) => c.info?.extendedFields?.items?.[key],
    set: (info, current, value) => {
      info.extendedFields ??= { items: { ...(current.info?.extendedFields?.items ?? {}) } };
      info.extendedFields.items![key] = value === '' ? null : type === 'number' ? Number(value) : value;
    },
  };
}

export class WixFieldCatalog {
  private byKey = new Map<string, FieldDef>();

  constructor(extended: Array<{ key: string; displayName: string; dataType?: string }> = []) {
    for (const f of STANDARD_FIELDS) this.byKey.set(f.key, f);
    for (const e of extended) {
      if (!e.key.startsWith('custom.')) continue; // system extended fields (emailSubscriptions.*, etc.) are not user-mappable
      const type = e.dataType === 'NUMBER' ? 'number' : e.dataType === 'DATE' ? 'date' : 'text';
      this.byKey.set(e.key, extendedField(e.key, `${e.displayName} (custom)`, type));
    }
  }

  options(): WixFieldOption[] {
    return [...this.byKey.values()].map(({ key, label, type, locked }) => ({ key, label, type, locked }));
  }

  has(key: string) {
    return this.byKey.has(key);
  }

  get(contact: WixContact, key: string): string {
    return normalize(this.byKey.get(key)?.get(contact));
  }

  /** Build a ContactInfo patch from {fieldKey: value} on top of the current contact. */
  buildInfo(current: WixContact, values: Record<string, string>): WixContactInfo {
    const info: WixContactInfo = {};
    for (const [key, value] of Object.entries(values)) this.byKey.get(key)?.set(info, current, value);
    return info;
  }
}

export function normalize(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
