import type { HubSpotClient } from '../hubspot/client.js';

export const ATTRIBUTION_GROUP = { name: 'wix_integration', label: 'Wix integration' };

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
export const FIRST_TOUCH_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'] as const;

type PropDef = { name: string; label: string; type: 'string' | 'datetime'; fieldType: 'text' | 'textarea' | 'date'; description: string };

/**
 * Custom HubSpot contact properties created on connect (Properties API) so that
 * attribution is visible on the contact record, filterable and usable in lists/reports.
 * "Last touch" values are overwritten on every submission; "first touch" values are
 * only written when empty.
 */
export const ATTRIBUTION_PROPERTIES: PropDef[] = [
  ...UTM_KEYS.map((k) => ({ name: `wix_${k}`, label: `Wix ${k} (last touch)`, type: 'string' as const, fieldType: 'text' as const, description: `${k} of the visit that led to the latest Wix form submission.` })),
  ...FIRST_TOUCH_KEYS.map((k) => ({ name: `wix_first_${k}`, label: `Wix ${k} (first touch)`, type: 'string' as const, fieldType: 'text' as const, description: `${k} of the visitor's first tracked visit to the Wix site.` })),
  { name: 'wix_landing_page', label: 'Wix landing page', type: 'string', fieldType: 'text', description: 'First page the visitor landed on (with UTM parameters).' },
  { name: 'wix_page_url', label: 'Wix form page URL', type: 'string', fieldType: 'text', description: 'Page URL where the Wix form was submitted.' },
  { name: 'wix_referrer', label: 'Wix referrer', type: 'string', fieldType: 'text', description: 'document.referrer when the visitor arrived.' },
  { name: 'wix_form_submitted_at', label: 'Wix form submitted at', type: 'datetime', fieldType: 'date', description: 'Timestamp of the latest Wix form submission.' },
  { name: 'wix_form_id', label: 'Wix form ID', type: 'string', fieldType: 'text', description: 'ID of the Wix form that was submitted.' },
  { name: 'wix_form_fields', label: 'Wix form extra fields', type: 'string', fieldType: 'textarea', description: 'Form fields that are not mapped to a HubSpot property.' },
];

export async function ensureAttributionProperties(hs: HubSpotClient) {
  await hs.ensurePropertyGroup(ATTRIBUTION_GROUP.name, ATTRIBUTION_GROUP.label);
  for (const p of ATTRIBUTION_PROPERTIES) await hs.ensureProperty({ ...p, groupName: ATTRIBUTION_GROUP.name });
}

/** Shape stored per (site, hashed email) by the attribution beacon. */
export interface Attribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  first_utm_source?: string;
  first_utm_medium?: string;
  first_utm_campaign?: string;
  landing_page?: string;
  page_url?: string;
  referrer?: string;
}

const ATTR_KEYS = new Set<string>([...UTM_KEYS, ...FIRST_TOUCH_KEYS.map((k) => `first_${k}`), 'landing_page', 'page_url', 'referrer']);

export function sanitizeAttribution(input: unknown): Attribution {
  const out: Record<string, string> = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      if (ATTR_KEYS.has(k) && typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, k.endsWith('url') || k === 'referrer' || k === 'landing_page' ? 1000 : 200);
    }
  }
  return out;
}
