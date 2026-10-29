// Types shared by the server and the dashboard.

export const DIRECTIONS = ['wix_to_hubspot', 'hubspot_to_wix', 'bidirectional'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const TRANSFORMS = ['none', 'trim', 'lowercase', 'uppercase', 'titlecase'] as const;
export type Transform = (typeof TRANSFORMS)[number];

export const CONFLICT_STRATEGIES = ['last_updated_wins', 'hubspot_wins', 'wix_wins'] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

export interface FieldMapping {
  wixField: string;
  hubspotProperty: string;
  direction: Direction;
  transform: Transform;
  defaultValue?: string | null;
}

export interface WixFieldOption {
  key: string;
  label: string;
  type: 'text' | 'email' | 'phone' | 'date' | 'number';
  locked?: boolean;
}

export interface HubSpotPropertyOption {
  name: string;
  label: string;
  type: string;
  readOnly: boolean;
}

export interface StatusResponse {
  connected: boolean;
  portalId: string | null;
  hubDomain: string | null;
  scopes: string[];
  connectedAt: number | null;
  syncEnabled: boolean;
  conflictStrategy: ConflictStrategy;
  scriptEmbedded: boolean;
  stats: { linkedContacts: number; pendingJobs: number; failedJobs: number; formSubmissions: number };
}

export interface ActivityEntry {
  ts: number;
  direction: string;
  action: string;
  wixContactId: string | null;
  hubspotContactId: string | null;
  fields: string[];
  detail: string | null;
  syncId: string | null;
}

export interface FormEventEntry {
  ts: number;
  submissionId: string;
  formId: string | null;
  status: string;
  hubspotContactId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  latencyMs: number | null;
  detail: string | null;
}

export interface ValidationIssue {
  row: number | null;
  message: string;
}
