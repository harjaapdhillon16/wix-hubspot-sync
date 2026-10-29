import express, { json } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppContext } from './context.js';
import { apiRouter } from './routes/api.js';
import { oauthRouter } from './routes/oauth.js';
import { webhookRouter } from './routes/webhooks.js';
import { publicRouter } from './routes/public.js';

const ROOT = resolve(import.meta.dirname, '../..');

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    next();
  });

  app.get('/healthz', (_req, res) => void res.json({ ok: true }));

  // Raw-body routers first (signatures are computed over the exact bytes).
  app.use('/webhooks', webhookRouter(ctx));
  app.use('/public', publicRouter(ctx));
  app.get('/public/attribution.js', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(join(ROOT, 'public/attribution.js'));
  });

  app.use('/api', json({ limit: '256kb' }), apiRouter(ctx));
  app.use('/oauth', oauthRouter(ctx));

  // Dashboard page extension: Wix loads https://APP/dashboard?instance=... in an iframe.
  const dashboardDir = join(ROOT, 'dist/dashboard');
  if (existsSync(dashboardDir)) {
    app.use(
      '/dashboard',
      (_req, res, next) => {
        res.set('Content-Security-Policy', "frame-ancestors 'self' https://*.wix.com https://*.wixapps.net https://*.editorx.com");
        next();
      },
      express.static(dashboardDir, { index: 'index.html' }),
    );
  }
  return app;
}
