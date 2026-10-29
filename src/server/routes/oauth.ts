import { Router } from 'express';
import type { AppContext } from '../context.js';
import { ensureAttributionProperties } from '../forms/attribution.js';
import { log } from '../logger.js';

const page = (title: string, body: string, origin: string, ok: boolean) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#162d3d}div{text-align:center;max-width:420px}</style></head>
<body><div><h2>${title}</h2><p>${body}</p></div>
<script>
  try { window.opener && window.opener.postMessage({ type: 'hubspot-oauth', ok: ${ok} }, ${JSON.stringify(origin)}); } catch (e) {}
  setTimeout(function () { window.close(); }, ${ok ? 1200 : 6000});
</script></body></html>`;

/**
 * HubSpot OAuth callback. The `state` is a single-use, 10-minute nonce bound
 * server-side to the Wix instance that started the flow (CSRF protection), so the
 * browser never chooses which installation the tokens are stored for.
 */
export function oauthRouter(ctx: AppContext) {
  const r = Router();
  const origin = new URL(ctx.cfg.APP_BASE_URL).origin;

  r.get('/hubspot/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const instanceId = state ? ctx.store.consumeOAuthState(state) : null;
    if (error || !code || !instanceId) {
      return void res.status(400).send(page('Connection failed', error ? 'HubSpot authorization was cancelled.' : 'This link is invalid or has expired. Start again from the Wix dashboard.', origin, false));
    }
    try {
      const tokens = await ctx.oauth.exchangeCode(instanceId, code);
      const info = await ctx.oauth.tokenInfo(tokens.accessToken);
      ctx.store.setConnection(instanceId, { portalId: tokens.portalId, hubDomain: info.hub_domain ?? null, scopes: tokens.scopes });
      ctx.store.logSync({ instanceId, direction: 'both', action: 'connected', detail: `portal ${tokens.portalId}` });

      // Non-fatal setup steps: attribution properties in HubSpot + the UTM capture script on the site.
      try {
        await ensureAttributionProperties(ctx.hubspot(instanceId));
      } catch (err) {
        log.warn('could not create attribution properties', { instanceId, err });
      }
      try {
        const inst = ctx.store.getInstallation(instanceId)!;
        await ctx.wix.embedAttributionScript(instanceId, { siteKey: inst.siteKey, scriptUrl: `${ctx.cfg.APP_BASE_URL}/public/attribution.js`, endpoint: `${ctx.cfg.APP_BASE_URL}/public/attribution` });
        ctx.store.setScriptEmbedded(instanceId, true);
      } catch (err) {
        log.warn('could not embed attribution script', { instanceId, err });
      }
      res.send(page('HubSpot connected', 'You can close this window and return to the Wix dashboard.', origin, true));
    } catch (err) {
      log.error('hubspot oauth callback failed', { instanceId, err });
      res.status(502).send(page('Connection failed', 'HubSpot did not accept the authorization. Please try again.', origin, false));
    }
  });

  return r;
}
