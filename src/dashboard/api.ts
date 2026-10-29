import type { ActivityEntry, ConflictStrategy, FieldMapping, FormEventEntry, HubSpotPropertyOption, StatusResponse, ValidationIssue, WixFieldOption } from '../shared/types';

// Wix opens the dashboard page as https://APP/dashboard?instance=<signed token>.
// The token is the only credential the browser holds; HubSpot tokens never reach it.
const instance = new URLSearchParams(window.location.search).get('instance') ?? '';

export class ApiError extends Error {
  constructor(message: string, public status: number, public issues: ValidationIssue[] = []) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { authorization: `Instance ${instance}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status, data?.issues);
  return data as T;
}

export const api = {
  hasInstance: () => Boolean(instance),
  status: () => call<StatusResponse>('GET', '/status'),
  connect: () => call<{ authorizeUrl: string }>('POST', '/hubspot/connect'),
  disconnect: () => call<{ ok: true }>('POST', '/hubspot/disconnect'),
  fields: () => call<{ wixFields: WixFieldOption[]; hubspotProperties: HubSpotPropertyOption[] }>('GET', '/fields'),
  mappings: () => call<{ mappings: FieldMapping[] }>('GET', '/mappings'),
  saveMappings: (mappings: FieldMapping[]) => call<{ mappings: FieldMapping[] }>('PUT', '/mappings', { mappings }),
  saveSettings: (s: { conflictStrategy?: ConflictStrategy; syncEnabled?: boolean }) => call<{ ok: true }>('PUT', '/settings', s),
  fullSync: () => call<{ queued: true }>('POST', '/sync/full'),
  activity: () => call<{ sync: ActivityEntry[]; forms: FormEventEntry[] }>('GET', '/activity'),
};
