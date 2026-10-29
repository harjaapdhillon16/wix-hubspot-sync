import { Router, text } from 'express';
import type { AppContext } from '../context.js';
import { verifyHubSpotSignatureV3, isOwnHubSpotWrite, type HubSpotWebhookEvent } from '../hubspot/webhooks.js';
import { reconcileKey } from '../jobs.js';
import { log } from '../logger.js';

/**
 * Inbound webhooks. Both endpoints authenticate the sender (Wix JWT signed with the
 * app key pair / HubSpot HMAC v3 with the client secret), drop duplicate deliveries
 * and our own echoes, enqueue work, and answer 200 immediately.
 */
export function webhookRouter(ctx: AppContext) {
  const r = Router();
  const { store, queue, cfg } = ctx;
  r.use(text({ type: '*/*', limit: '1mb' }));

  r.post('/wix', async (req, res) => {
    let events;
    try {
      events = await ctx.wixEvents.parse(typeof req.body === 'string' ? req.body : '');
    } catch (err) {
      log.warn('rejected wix webhook', { err });
      return void res.status(401).send('invalid signature');
    }
    for (const e of events) {
      if (e.eventId && !store.markEventProcessed(`wix:${e.eventId}`)) continue;
      const inst = store.getInstallation(e.instanceId);
      if (e.type === 'app_removed') {
        queue.enqueue('uninstall', { instanceId: e.instanceId }, { instanceId: e.instanceId });
        continue;
      }
      if (!inst?.portalId) continue;

      if (e.type === 'contact_created' || e.type === 'contact_updated') {
        // Origin tag: changes made through our own app identity are echoes of our sync writes.
        if (e.identity?.identityType === 'APP' && e.identity.appId === cfg.WIX_APP_ID) {
          store.logSync({ instanceId: e.instanceId, direction: 'wix_to_hubspot', action: 'echo_ignored', wixContactId: e.entityId, detail: 'change made by this app (origin tag)' });
          continue;
        }
        queue.enqueue('reconcile', { instanceId: e.instanceId, wixContactId: e.entityId, trigger: 'wix' }, { instanceId: e.instanceId, dedupeKey: reconcileKey(e.instanceId, 'wix', e.entityId), delayMs: Math.round(cfg.WEBHOOK_DEBOUNCE_MS / 3) });
      } else if (e.type === 'contact_deleted') {
        store.deleteLink(e.instanceId, 'wix', e.entityId);
      } else if (e.type === 'submission_created') {
        // Small delay lets the site script's attribution beacon land first.
        queue.enqueue('form_submission', { instanceId: e.instanceId, submissionId: e.entityId, receivedAt: Date.now() }, { instanceId: e.instanceId, dedupeKey: `form:${e.instanceId}:${e.entityId}`, delayMs: cfg.WEBHOOK_DEBOUNCE_MS });
      }
    }
    res.status(200).send('ok');
  });

  r.post('/hubspot', (req, res) => {
    const rawBody = typeof req.body === 'string' ? req.body : '';
    const ok = verifyHubSpotSignatureV3({
      clientSecret: cfg.HUBSPOT_CLIENT_SECRET,
      method: 'POST',
      uri: `${cfg.APP_BASE_URL}${req.originalUrl}`,
      rawBody,
      signature: req.get('x-hubspot-signature-v3'),
      timestamp: req.get('x-hubspot-request-timestamp'),
    });
    if (!ok) return void res.status(401).send('invalid signature');

    let events: HubSpotWebhookEvent[];
    try {
      events = JSON.parse(rawBody);
    } catch {
      return void res.status(400).send('bad json');
    }
    const echoed = new Set<string>();
    for (const e of Array.isArray(events) ? events : []) {
      if (!store.markEventProcessed(`hs:${e.eventId}`)) continue;
      const objectId = String(e.objectId);
      for (const inst of store.installationsForPortal(String(e.portalId))) {
        if (isOwnHubSpotWrite(e, cfg.HUBSPOT_APP_ID)) {
          if (!echoed.has(inst.instanceId + objectId)) {
            echoed.add(inst.instanceId + objectId);
            store.logSync({ instanceId: inst.instanceId, direction: 'hubspot_to_wix', action: 'echo_ignored', hubspotContactId: objectId, detail: 'change made by this app (origin tag)' });
          }
          continue;
        }
        if (e.subscriptionType === 'contact.creation' || e.subscriptionType === 'contact.propertyChange') {
          // Debounce: HubSpot sends one event per changed property.
          queue.enqueue('reconcile', { instanceId: inst.instanceId, hubspotContactId: objectId, trigger: 'hubspot' }, { instanceId: inst.instanceId, dedupeKey: reconcileKey(inst.instanceId, 'hs', objectId), delayMs: cfg.WEBHOOK_DEBOUNCE_MS });
        } else if (e.subscriptionType === 'contact.deletion' || e.subscriptionType === 'contact.privacyDeletion') {
          store.deleteLink(inst.instanceId, 'hubspot', objectId);
        }
      }
    }
    res.status(200).send('ok');
  });

  return r;
}
