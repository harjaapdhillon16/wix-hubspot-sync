import type { AppContext } from './context.js';
import type { Trigger } from './sync/engine.js';
import { log } from './logger.js';

export const reconcileKey = (instanceId: string, side: 'wix' | 'hs', id: string) => `${side}:${instanceId}:${id}`;

export function registerJobs(ctx: AppContext) {
  const { queue, store, engine } = ctx;

  queue.register('reconcile', async (p: { instanceId: string; wixContactId?: string; hubspotContactId?: string; trigger: Trigger }) => {
    await engine.reconcile(p.instanceId, { wixContactId: p.wixContactId, hubspotContactId: p.hubspotContactId }, p.trigger);
  });

  queue.register('form_submission', async (p: { instanceId: string; submissionId: string; receivedAt: number }) => {
    const inst = store.getInstallation(p.instanceId);
    if (!inst?.portalId) return;
    const sub = await ctx.wix.getFormSubmission(p.instanceId, p.submissionId);
    if (!sub) return;
    await ctx.forms.handle(p.instanceId, sub, p.receivedAt);
    // Make sure the Wix contact the form created is linked to the HubSpot contact.
    if (sub.contactId && !store.linkByWix(p.instanceId, sub.contactId)) {
      queue.enqueue('reconcile', { instanceId: p.instanceId, wixContactId: sub.contactId, trigger: 'form' }, { instanceId: p.instanceId, dedupeKey: reconcileKey(p.instanceId, 'wix', sub.contactId) });
    }
  });

  // "Sync now": reconcile every contact on both sides (idempotent, so safe to re-run).
  queue.register('full_sync', async (p: { instanceId: string }) => {
    let n = 0;
    for await (const c of ctx.wix.iterateContacts(p.instanceId)) {
      queue.enqueue('reconcile', { instanceId: p.instanceId, wixContactId: c._id, trigger: 'full_sync' }, { instanceId: p.instanceId, dedupeKey: reconcileKey(p.instanceId, 'wix', c._id!) });
      n++;
    }
    const hs = ctx.hubspot(p.instanceId);
    let after: string | undefined;
    do {
      const page = await hs.listContactIds(after);
      for (const c of page.results) {
        if (store.linkByHubSpot(p.instanceId, c.id)) continue; // already covered from the Wix side
        queue.enqueue('reconcile', { instanceId: p.instanceId, hubspotContactId: c.id, trigger: 'full_sync' }, { instanceId: p.instanceId, dedupeKey: reconcileKey(p.instanceId, 'hs', c.id) });
        n++;
      }
      after = page.paging?.next?.after;
    } while (after);
    store.logSync({ instanceId: p.instanceId, direction: 'both', action: 'full_sync_started', detail: `${n} contacts queued` });
  });

  // Polling fallback for HubSpot -> Wix (covers properties without webhook subscriptions and missed deliveries).
  queue.register('poll', async (p: { instanceId: string }) => {
    const inst = store.getInstallation(p.instanceId);
    if (!inst?.portalId || !inst.syncEnabled) return;
    const since = (inst.pollCursor ?? Date.now()) - 60_000; // overlap: lastmodifieddate is eventually consistent
    const hs = ctx.hubspot(p.instanceId);
    let cursor = inst.pollCursor ?? Date.now();
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await hs.modifiedSince(since, after);
      for (const c of page.results) {
        queue.enqueue('reconcile', { instanceId: p.instanceId, hubspotContactId: c.id, trigger: 'poll' }, { instanceId: p.instanceId, dedupeKey: reconcileKey(p.instanceId, 'hs', c.id) });
        const ts = Date.parse(c.properties.lastmodifieddate ?? '');
        if (Number.isFinite(ts)) cursor = Math.max(cursor, ts);
      }
      after = page.paging?.next?.after;
    } while (after && ++pages < 50);
    store.setPollCursor(p.instanceId, cursor);
  });

  queue.register('uninstall', async (p: { instanceId: string }) => {
    await ctx.oauth.disconnect(p.instanceId);
    store.deleteInstallation(p.instanceId);
    log.info('app removed, installation data deleted', { instanceId: p.instanceId });
  });
}

export function startPoller(ctx: AppContext): NodeJS.Timeout {
  return setInterval(() => {
    for (const inst of ctx.store.connectedInstallations()) {
      ctx.queue.enqueue('poll', { instanceId: inst.instanceId }, { instanceId: inst.instanceId, dedupeKey: `poll:${inst.instanceId}` });
    }
    ctx.store.pruneProcessedEvents(3 * 24 * 3600_000);
  }, ctx.cfg.POLL_INTERVAL_SECONDS * 1000);
}
