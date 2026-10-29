import { Router, text } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { piiHash } from '../crypto.js';
import { sanitizeAttribution } from '../forms/attribution.js';

const beaconSchema = z.object({
  siteKey: z.string().min(8).max(64),
  email: z.string().email().max(320),
  attribution: z.record(z.string(), z.unknown()),
});

/**
 * Public, unauthenticated endpoint hit by the embedded site script when a visitor
 * submits a form. It can only *add* attribution rows for a site (scoped by the
 * non-secret site key); it cannot read anything back. The email is stored only as
 * a keyed hash used to join with the form submission webhook.
 */
export function publicRouter(ctx: AppContext) {
  const r = Router();
  const hits = new Map<string, { n: number; reset: number }>();

  r.options('/attribution', (_req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '86400' }).sendStatus(204);
  });

  r.post('/attribution', text({ type: '*/*', limit: '8kb' }), (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) hits.set(ip, { n: 1, reset: now + 60_000 });
    else if (++h.n > 30) return void res.sendStatus(429);
    if (hits.size > 10_000) hits.clear();

    let body: unknown;
    try {
      body = JSON.parse(typeof req.body === 'string' ? req.body : '');
    } catch {
      return void res.sendStatus(400);
    }
    const parsed = beaconSchema.safeParse(body);
    if (!parsed.success) return void res.sendStatus(400);
    const inst = ctx.store.getInstallationBySiteKey(parsed.data.siteKey);
    if (!inst?.portalId) return void res.sendStatus(204);
    const attribution = sanitizeAttribution(parsed.data.attribution);
    if (Object.keys(attribution).length) {
      const email = parsed.data.email.trim().toLowerCase();
      ctx.store.saveAttribution(inst.instanceId, piiHash(ctx.hashKey, `${inst.instanceId}\u0000${email}`), attribution as Record<string, string>);
    }
    res.sendStatus(204);
  });

  return r;
}
