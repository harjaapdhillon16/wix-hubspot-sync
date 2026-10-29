/**
 * Boots the real app (real routes, engine, queue, OAuth, signatures) against the
 * HubSpot emulator and the fake Wix site. Used by the integration tests and `npm run dev:mock`.
 */
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/server/config.js';
import { createContext } from '../src/server/context.js';
import { createApp } from '../src/server/app.js';
import { registerJobs } from '../src/server/jobs.js';
import { signInstance } from '../src/server/wix/instance.js';
import { MockHubSpot } from './mock-hubspot.js';
import { FakeWix, FakeWixEventParser } from './fake-wix.js';

export const DEV_IDS = {
  WIX_APP_ID: 'a1b2c3d4-dev-wix-app',
  WIX_APP_SECRET: 'dev-wix-app-secret',
  HUBSPOT_APP_ID: '4242424',
  HUBSPOT_CLIENT_ID: 'dev-hubspot-client-id',
  HUBSPOT_CLIENT_SECRET: 'dev-hubspot-client-secret',
  WIX_WEBHOOK_SECRET: 'dev-wix-webhook-secret',
};

export async function startStack(opts: { port?: number; hubspotPort?: number; dbPath?: string; stampSourceId?: boolean; debounceMs?: number; instanceId?: string } = {}) {
  const hubspot = await new MockHubSpot({
    port: opts.hubspotPort,
    appId: DEV_IDS.HUBSPOT_APP_ID,
    clientId: DEV_IDS.HUBSPOT_CLIENT_ID,
    clientSecret: DEV_IDS.HUBSPOT_CLIENT_SECRET,
    stampSourceId: opts.stampSourceId,
  }).start();

  const cfg = loadConfig({
    ...DEV_IDS,
    NODE_ENV: 'development',
    HUBSPOT_API_BASE: hubspot.url,
    HUBSPOT_AUTH_BASE: hubspot.url,
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SECRET_STORE: 'local',
    DATABASE_PATH: opts.dbPath ?? ':memory:',
    WEBHOOK_DEBOUNCE_MS: String(opts.debounceMs ?? 60),
  });

  const wix = new FakeWix({ appId: DEV_IDS.WIX_APP_ID, webhookSecret: DEV_IDS.WIX_WEBHOOK_SECRET });
  const ctx = await createContext(cfg, { wix, wixEvents: new FakeWixEventParser(DEV_IDS.WIX_WEBHOOK_SECRET) });
  registerJobs(ctx);
  ctx.queue.start(40);

  const app = createApp(ctx);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port ?? 0, () => resolve(s));
  });
  const addr = server.address();
  cfg.APP_BASE_URL = `http://localhost:${typeof addr === 'object' && addr ? addr.port : opts.port}`;
  hubspot.opts.webhookUrl = `${cfg.APP_BASE_URL}/webhooks/hubspot`;
  wix.opts.webhookUrl = `${cfg.APP_BASE_URL}/webhooks/wix`;

  const instanceId = opts.instanceId ?? 'f0e1d2c3-0000-4000-8000-000000000001';
  const instance = () => signInstance({ instanceId, appDefId: DEV_IDS.WIX_APP_ID, signDate: new Date().toISOString(), uid: 'site-owner', permissions: 'OWNER' }, DEV_IDS.WIX_APP_SECRET);

  async function api<T = any>(method: string, path: string, body?: unknown, token: string | null = instance()): Promise<{ status: number; body: T }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await fetch(`${cfg.APP_BASE_URL}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Instance ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  /** Runs the real OAuth flow: connect -> HubSpot authorize -> callback. */
  async function connect() {
    const { body } = await api<{ authorizeUrl: string }>('POST', '/hubspot/connect');
    const url = new URL(body.authorizeUrl);
    const code = hubspot.issueCode(url.searchParams.get('redirect_uri')!);
    const cb = await fetch(`${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}`);
    return { status: cb.status, html: await cb.text(), authorizeUrl: url };
  }

  /** Wait until every webhook has been delivered and every job processed (incl. follow-up echoes). */
  async function settle() {
    for (let quiet = 0; quiet < 3; ) {
      const before = hubspot.webhooksSent + wix.webhooksSent;
      await hubspot.flush();
      await wix.flush();
      await ctx.queue.idle(15_000);
      await new Promise((r) => setTimeout(r, 30));
      quiet = hubspot.webhooksSent + wix.webhooksSent === before ? quiet + 1 : 0;
    }
  }

  async function stop() {
    ctx.queue.stop();
    await new Promise((r) => server.close(r));
    await hubspot.stop();
  }

  return { cfg, ctx, hubspot, wix, instanceId, instance, api, connect, settle, stop };
}

export type Stack = Awaited<ReturnType<typeof startStack>>;
