import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { verifyInstance, InstanceAuthError } from '../wix/instance.js';
import { mappingsSchema, validateMappings } from '../sync/mapping.js';
import { CONFLICT_STRATEGIES, type StatusResponse } from '../../shared/types.js';
import { randomId } from '../crypto.js';
import { log } from '../logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    instanceId?: string;
  }
}

/**
 * Dashboard API. Every route requires the Wix-signed instance token
 * (Authorization: Instance <token>), so a caller can only read/modify the
 * installation the token was issued for. No HubSpot token ever leaves the server.
 */
export function apiRouter(ctx: AppContext) {
  const r = Router();
  const { store, cfg } = ctx;

  r.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Instance ') ? header.slice('Instance '.length) : '';
    try {
      const inst = verifyInstance(token, cfg.WIX_APP_SECRET, { appId: cfg.WIX_APP_ID, maxAgeHours: cfg.INSTANCE_TOKEN_MAX_AGE_HOURS });
      req.instanceId = inst.instanceId;
      store.ensureInstallation(inst.instanceId);
      next();
    } catch (err) {
      res.status(401).json({ error: err instanceof InstanceAuthError ? err.message : 'unauthorized' });
    }
  });

  r.get('/status', (req, res) => {
    const inst = store.getInstallation(req.instanceId!)!;
    const body: StatusResponse = {
      connected: !!inst.portalId,
      portalId: inst.portalId,
      hubDomain: inst.hubDomain,
      scopes: inst.scopes,
      connectedAt: inst.connectedAt,
      syncEnabled: inst.syncEnabled,
      conflictStrategy: inst.conflictStrategy,
      scriptEmbedded: inst.scriptEmbedded,
      stats: store.stats(req.instanceId!),
    };
    res.json(body);
  });

  r.post('/hubspot/connect', (req, res) => {
    const nonce = randomId(24);
    store.saveOAuthState(nonce, req.instanceId!, 10 * 60_000);
    res.json({ authorizeUrl: ctx.oauth.authorizeUrl(nonce) });
  });

  r.post('/hubspot/disconnect', async (req, res) => {
    await ctx.oauth.disconnect(req.instanceId!);
    store.setConnection(req.instanceId!, null);
    store.logSync({ instanceId: req.instanceId!, direction: 'both', action: 'disconnected' });
    res.json({ ok: true });
  });

  r.get('/fields', async (req, res) => {
    const catalog = await ctx.catalog(req.instanceId!, true);
    const connected = !!store.getInstallation(req.instanceId!)?.portalId;
    const hubspotProperties = connected ? await ctx.hubspotProperties(req.instanceId!, true) : [];
    res.json({ wixFields: catalog.options(), hubspotProperties });
  });

  r.get('/mappings', (req, res) => {
    res.json({ mappings: store.getMappings(req.instanceId!) });
  });

  r.put('/mappings', async (req, res) => {
    const parsed = mappingsSchema.safeParse(req.body?.mappings);
    if (!parsed.success) return void res.status(400).json({ issues: [{ row: null, message: 'Malformed mapping payload.' }] });
    const connected = !!store.getInstallation(req.instanceId!)?.portalId;
    const issues = validateMappings(parsed.data, await ctx.catalog(req.instanceId!), connected ? await ctx.hubspotProperties(req.instanceId!) : null);
    if (issues.length) return void res.status(422).json({ issues });
    store.saveMappings(req.instanceId!, parsed.data);
    store.logSync({ instanceId: req.instanceId!, direction: 'both', action: 'mapping_saved', fields: parsed.data.map((m) => `${m.wixField}→${m.hubspotProperty}`) });
    res.json({ mappings: store.getMappings(req.instanceId!) });
  });

  r.put('/settings', (req, res) => {
    const parsed = z.object({ conflictStrategy: z.enum(CONFLICT_STRATEGIES).optional(), syncEnabled: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid settings' });
    store.updateSettings(req.instanceId!, parsed.data);
    res.json({ ok: true });
  });

  r.post('/sync/full', (req, res) => {
    if (!store.getInstallation(req.instanceId!)?.portalId) return void res.status(409).json({ error: 'HubSpot is not connected' });
    ctx.queue.enqueue('full_sync', { instanceId: req.instanceId }, { instanceId: req.instanceId, dedupeKey: `full:${req.instanceId}` });
    res.status(202).json({ queued: true });
  });

  r.get('/activity', (req, res) => {
    res.json({ sync: store.recentActivity(req.instanceId!), forms: store.recentFormEvents(req.instanceId!) });
  });

  r.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    log.error('api error', { path: req.path, instanceId: req.instanceId, err });
    res.status(502).json({ error: 'Upstream request failed. Check the HubSpot connection and try again.' });
  });

  return r;
}
