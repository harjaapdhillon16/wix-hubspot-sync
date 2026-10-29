import { z } from 'zod';
import { DIRECTIONS, TRANSFORMS, type FieldMapping, type Transform, type ValidationIssue, type HubSpotPropertyOption } from '../../shared/types.js';
import type { WixFieldCatalog } from '../wix/fields.js';

export const mappingSchema = z.object({
  wixField: z.string().min(1),
  hubspotProperty: z.string().min(1),
  direction: z.enum(DIRECTIONS),
  transform: z.enum(TRANSFORMS).default('none'),
  defaultValue: z.string().max(500).nullish(),
});

export const mappingsSchema = z.array(mappingSchema).max(100);

export const writesToHubSpot = (m: FieldMapping) => m.direction !== 'hubspot_to_wix';
export const writesToWix = (m: FieldMapping) => m.direction !== 'wix_to_hubspot';

/**
 * Validation rules for the mapping table:
 *  - the identity row (Wix primary email <-> HubSpot email, bi-directional) must exist
 *  - fields/properties must exist; HubSpot read-only properties can't be write targets
 *  - a HubSpot property can be written by only one row (no duplicate targets)
 *  - a Wix field can be written by only one row
 */
export function validateMappings(mappings: FieldMapping[], wix: WixFieldCatalog, hsProps: HubSpotPropertyOption[] | null): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const props = hsProps ? new Map(hsProps.map((p) => [p.name, p])) : null;

  if (!mappings.some((m) => m.wixField === 'email' && m.hubspotProperty === 'email' && m.direction === 'bidirectional')) {
    issues.push({ row: null, message: 'The Primary email ↔ email (bi-directional) row is required: it is how contacts are matched.' });
  }

  const hsTargets = new Map<string, number>();
  const wixTargets = new Map<string, number>();
  mappings.forEach((m, i) => {
    const row = i + 1;
    if (!wix.has(m.wixField)) issues.push({ row, message: `Unknown Wix field "${m.wixField}".` });
    const prop = props?.get(m.hubspotProperty);
    if (props && !prop) issues.push({ row, message: `Unknown HubSpot property "${m.hubspotProperty}".` });
    if (prop?.readOnly && writesToHubSpot(m)) issues.push({ row, message: `HubSpot property "${prop.label}" is read-only; use direction HubSpot → Wix.` });

    if (writesToHubSpot(m)) {
      const prev = hsTargets.get(m.hubspotProperty);
      if (prev) issues.push({ row, message: `HubSpot property "${m.hubspotProperty}" is already written by row ${prev}.` });
      else hsTargets.set(m.hubspotProperty, row);
    }
    if (writesToWix(m)) {
      const prev = wixTargets.get(m.wixField);
      if (prev) issues.push({ row, message: `Wix field "${m.wixField}" is already written by row ${prev}.` });
      else wixTargets.set(m.wixField, row);
    }
  });
  return issues;
}

export function applyTransform(t: Transform, value: string): string {
  switch (t) {
    case 'trim':
      return value.trim();
    case 'lowercase':
      return value.trim().toLowerCase();
    case 'uppercase':
      return value.trim().toUpperCase();
    case 'titlecase':
      return value.trim().toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
    default:
      return value;
  }
}

/** Source value -> target value for one mapping row (default applies when the source is empty). */
export function project(m: FieldMapping, sourceValue: string): string {
  const v = sourceValue === '' && m.defaultValue ? m.defaultValue : sourceValue;
  return applyTransform(m.transform, v);
}
