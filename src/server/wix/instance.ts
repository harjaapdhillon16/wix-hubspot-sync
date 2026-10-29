import { createHmac } from 'node:crypto';
import { safeEqual } from '../crypto.js';

/**
 * Wix appends a signed `instance` query param when it loads the app's dashboard
 * page: base64url(HMAC-SHA256(appSecret, payload)) + "." + base64url(JSON payload).
 * The dashboard forwards it on every API call; the server verifies it with the app
 * secret, so only the site owner/collaborators of that installation can call
 * the sync/mapping/connection endpoints for it.
 */
export interface WixInstance {
  instanceId: string;
  appDefId?: string;
  signDate?: string;
  uid?: string;
  permissions?: string;
  siteOwnerId?: string;
}

export class InstanceAuthError extends Error {}

export function verifyInstance(token: string, appSecret: string, opts: { appId: string; maxAgeHours: number; now?: number }): WixInstance {
  const [sig, payload] = token.split('.');
  if (!sig || !payload) throw new InstanceAuthError('malformed instance');
  const expected = createHmac('sha256', appSecret).update(payload).digest('base64url');
  if (!safeEqual(expected, sig.replace(/=+$/, ''))) throw new InstanceAuthError('bad instance signature');

  let data: WixInstance;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new InstanceAuthError('bad instance payload');
  }
  if (!data.instanceId) throw new InstanceAuthError('instance missing instanceId');
  if (data.appDefId && data.appDefId !== opts.appId) throw new InstanceAuthError('instance for another app');
  if (data.signDate) {
    const age = (opts.now ?? Date.now()) - Date.parse(data.signDate);
    if (Number.isFinite(age) && age > opts.maxAgeHours * 3600_000) throw new InstanceAuthError('instance expired');
  }
  return data;
}

/** Used by tests and the local mock stack to mint instance tokens the way Wix does. */
export function signInstance(payload: WixInstance, appSecret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', appSecret).update(body).digest('base64url');
  return `${sig}.${body}`;
}
