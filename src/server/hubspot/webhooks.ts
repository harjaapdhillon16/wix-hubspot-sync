import { createHmac } from 'node:crypto';
import { safeEqual } from '../crypto.js';

/**
 * HubSpot request signature v3:
 *   base64(HMAC-SHA256(clientSecret, method + uri + rawBody + timestamp))
 * sent in X-HubSpot-Signature-v3 with X-HubSpot-Request-Timestamp (ms).
 * Requests older than 5 minutes are rejected to stop replays.
 */
export function verifyHubSpotSignatureV3(opts: {
  clientSecret: string;
  method: string;
  uri: string;
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  now?: number;
}): boolean {
  if (!opts.signature || !opts.timestamp) return false;
  const ts = Number(opts.timestamp);
  if (!Number.isFinite(ts) || Math.abs((opts.now ?? Date.now()) - ts) > 5 * 60_000) return false;
  const expected = signHubSpotV3(opts.clientSecret, opts.method, opts.uri, opts.rawBody, opts.timestamp);
  return safeEqual(expected, opts.signature);
}

export function signHubSpotV3(clientSecret: string, method: string, uri: string, rawBody: string, timestamp: string): string {
  return createHmac('sha256', clientSecret).update(`${method}${decodeHubSpotUri(uri)}${rawBody}${timestamp}`).digest('base64');
}

// HubSpot signs the URI with these characters decoded.
function decodeHubSpotUri(uri: string): string {
  return uri.replace(/%3A/gi, ':').replace(/%2F/gi, '/').replace(/%3F/gi, '?').replace(/%40/gi, '@').replace(/%21/gi, '!')
    .replace(/%24/gi, '$').replace(/%27/gi, "'").replace(/%28/gi, '(').replace(/%29/gi, ')').replace(/%2A/gi, '*')
    .replace(/%2C/gi, ',').replace(/%3B/gi, ';');
}

export interface HubSpotWebhookEvent {
  eventId: number | string;
  subscriptionType: string; // contact.creation | contact.propertyChange | contact.deletion | contact.merge ...
  portalId: number;
  objectId: number;
  occurredAt: number;
  propertyName?: string;
  propertyValue?: string;
  changeSource?: string;
  sourceId?: string;
  appId?: number;
}

/**
 * Origin tag check: HubSpot stamps changes made through an app's OAuth token with
 * changeSource INTEGRATION/API and sourceId = that app's id. Those are our own writes.
 */
export function isOwnHubSpotWrite(e: HubSpotWebhookEvent, hubspotAppId: string): boolean {
  if (!hubspotAppId || !e.sourceId) return false;
  const src = String(e.sourceId).replace(/^app(Id)?:/i, '');
  return (e.changeSource === 'INTEGRATION' || e.changeSource === 'API') && src === hubspotAppId;
}
