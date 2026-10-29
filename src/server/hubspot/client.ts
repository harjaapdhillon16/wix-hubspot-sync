import type { HubSpotOAuth } from './oauth.js';
import type { HubSpotPropertyOption } from '../../shared/types.js';

export interface HsContact {
  id: string;
  properties: Record<string, string | null>;
  updatedAt?: string;
}

export class HubSpotApiError extends Error {
  constructor(message: string, public status: number, public retryAfterMs?: number) {
    super(message);
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

/** Thin client over the HubSpot CRM v3 Contacts + Properties APIs, scoped to one Wix instance. */
export class HubSpotClient {
  constructor(
    private oauth: HubSpotOAuth,
    private instanceId: string,
    private apiBase: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T | null> {
    const token = await this.oauth.getAccessToken(this.instanceId, { forceRefresh: retried });
    const res = await this.fetchFn(new URL(path, this.apiBase), {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried) return this.request<T>(method, path, body, true);
    if (res.status === 404) return null;
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      // Don't surface the response body: HubSpot echoes submitted values (PII) in errors.
      const detail = res.status === 409 ? await res.text() : '';
      throw new HubSpotApiError(`HubSpot ${method} ${path.split('?')[0]} -> ${res.status}${detail ? ` ${detail}` : ''}`, res.status, retryAfter ? retryAfter * 1000 : undefined);
    }
    if (res.status === 204) return null;
    return (await res.json()) as T;
  }

  getContact(id: string, properties: string[]) {
    const qs = new URLSearchParams({ properties: [...new Set([...properties, 'lastmodifieddate'])].join(',') });
    return this.request<HsContact>('GET', `/crm/v3/objects/contacts/${encodeURIComponent(id)}?${qs}`);
  }

  async findByEmail(email: string, properties: string[]): Promise<HsContact | null> {
    const res = await this.request<{ results: HsContact[] }>('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: [...new Set([...properties, 'lastmodifieddate'])],
      limit: 1,
    });
    return res?.results[0] ?? null;
  }

  async createContact(properties: Record<string, string>): Promise<HsContact> {
    try {
      return (await this.request<HsContact>('POST', '/crm/v3/objects/contacts', { properties }))!;
    } catch (err) {
      // Race with another writer: the email already exists -> update that contact instead.
      const existing = err instanceof HubSpotApiError && err.status === 409 ? /Existing ID: (\d+)/.exec(err.message)?.[1] : undefined;
      if (!existing) throw err;
      return this.updateContact(existing, properties);
    }
  }

  async updateContact(id: string, properties: Record<string, string>): Promise<HsContact> {
    return (await this.request<HsContact>('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { properties }))!;
  }

  /** Contacts modified at/after `sinceMs` — used by the polling fallback. */
  async modifiedSince(sinceMs: number, after?: string) {
    return (await this.request<{ results: HsContact[]; paging?: { next?: { after: string } } }>('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(sinceMs) }] }],
      sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
      properties: ['lastmodifieddate'],
      limit: 100,
      ...(after ? { after } : {}),
    }))!;
  }

  async listContactIds(after?: string) {
    const qs = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) });
    return (await this.request<{ results: HsContact[]; paging?: { next?: { after: string } } }>('GET', `/crm/v3/objects/contacts?${qs}`))!;
  }

  async listProperties(): Promise<HubSpotPropertyOption[]> {
    const res = await this.request<{ results: Array<{ name: string; label: string; type: string; hidden?: boolean; calculated?: boolean; modificationMetadata?: { readOnlyValue?: boolean } }> }>(
      'GET',
      '/crm/v3/properties/contacts',
    );
    return (res?.results ?? [])
      .filter((p) => !p.hidden)
      .map((p) => ({ name: p.name, label: p.label, type: p.type, readOnly: Boolean(p.calculated || p.modificationMetadata?.readOnlyValue) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async ensurePropertyGroup(name: string, label: string) {
    try {
      await this.request('POST', '/crm/v3/properties/contacts/groups', { name, label, displayOrder: -1 });
    } catch (err) {
      if (!(err instanceof HubSpotApiError && err.status === 409)) throw err;
    }
  }

  async ensureProperty(def: { name: string; label: string; type: 'string' | 'datetime'; fieldType: 'text' | 'textarea' | 'date'; groupName: string; description: string }) {
    try {
      await this.request('POST', '/crm/v3/properties/contacts', def);
    } catch (err) {
      if (!(err instanceof HubSpotApiError && err.status === 409)) throw err;
    }
  }
}
