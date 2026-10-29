import type { Config } from '../config.js';
import type { SecretStore } from '../secrets/index.js';
import { hubspotTokenSecretName } from '../secrets/index.js';
import { log } from '../logger.js';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  portalId: string;
  scopes: string[];
}

export class HubSpotAuthError extends Error {}

/** HubSpot OAuth 2.0 (authorization code grant) + token lifecycle. */
export class HubSpotOAuth {
  private refreshing = new Map<string, Promise<StoredTokens>>();
  private cache = new Map<string, StoredTokens>();

  constructor(private cfg: Config, private secrets: SecretStore, private fetchFn: typeof fetch = fetch) {}

  get redirectUri() {
    return `${this.cfg.APP_BASE_URL}/oauth/hubspot/callback`;
  }

  authorizeUrl(state: string): string {
    const url = new URL('/oauth/authorize', this.cfg.HUBSPOT_AUTH_BASE);
    url.searchParams.set('client_id', this.cfg.HUBSPOT_CLIENT_ID);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', this.cfg.HUBSPOT_SCOPES);
    url.searchParams.set('state', state);
    return url.toString();
  }

  private async tokenRequest(params: Record<string, string>) {
    const res = await this.fetchFn(new URL('/oauth/v1/token', this.cfg.HUBSPOT_API_BASE), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.HUBSPOT_CLIENT_ID,
        client_secret: this.cfg.HUBSPOT_CLIENT_SECRET,
        ...params,
      }),
    });
    if (!res.ok) throw new HubSpotAuthError(`token endpoint returned ${res.status}`);
    return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  }

  /** Exchange the authorization code, look up the portal, persist tokens in the SecretStore. */
  async exchangeCode(instanceId: string, code: string): Promise<StoredTokens> {
    const t = await this.tokenRequest({ grant_type: 'authorization_code', redirect_uri: this.redirectUri, code });
    const info = await this.tokenInfo(t.access_token);
    const tokens: StoredTokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
      portalId: String(info.hub_id),
      scopes: info.scopes ?? [],
    };
    await this.save(instanceId, tokens);
    return tokens;
  }

  async tokenInfo(accessToken: string) {
    const res = await this.fetchFn(new URL(`/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`, this.cfg.HUBSPOT_API_BASE));
    if (!res.ok) throw new HubSpotAuthError(`token info returned ${res.status}`);
    return (await res.json()) as { hub_id: number; hub_domain?: string; scopes?: string[] };
  }

  private async save(instanceId: string, tokens: StoredTokens) {
    await this.secrets.put(hubspotTokenSecretName(this.cfg.SECRET_PREFIX, instanceId), JSON.stringify(tokens));
    this.cache.set(instanceId, tokens);
  }

  async load(instanceId: string): Promise<StoredTokens | null> {
    const cached = this.cache.get(instanceId);
    if (cached) return cached;
    const raw = await this.secrets.get(hubspotTokenSecretName(this.cfg.SECRET_PREFIX, instanceId));
    if (!raw) return null;
    const tokens = JSON.parse(raw) as StoredTokens;
    this.cache.set(instanceId, tokens);
    return tokens;
  }

  /** Returns a valid access token, refreshing it (once, even under concurrency) when near expiry. */
  async getAccessToken(instanceId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
    const tokens = await this.load(instanceId);
    if (!tokens) throw new HubSpotAuthError('HubSpot is not connected');
    if (!opts.forceRefresh && tokens.expiresAt - Date.now() > 5 * 60_000) return tokens.accessToken;
    return (await this.refresh(instanceId, tokens)).accessToken;
  }

  private refresh(instanceId: string, current: StoredTokens): Promise<StoredTokens> {
    const inflight = this.refreshing.get(instanceId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
        const next: StoredTokens = {
          ...current,
          accessToken: t.access_token,
          refreshToken: t.refresh_token || current.refreshToken, // rotate when HubSpot issues a new one
          expiresAt: Date.now() + t.expires_in * 1000,
        };
        await this.save(instanceId, next);
        log.info('hubspot token refreshed', { instanceId });
        return next;
      } finally {
        this.refreshing.delete(instanceId);
      }
    })();
    this.refreshing.set(instanceId, p);
    return p;
  }

  /** Revoke the refresh token at HubSpot (best effort) and delete it from the SecretStore. */
  async disconnect(instanceId: string) {
    const tokens = await this.load(instanceId);
    if (tokens) {
      try {
        await this.fetchFn(new URL(`/oauth/v1/refresh-tokens/${encodeURIComponent(tokens.refreshToken)}`, this.cfg.HUBSPOT_API_BASE), {
          method: 'DELETE',
        });
      } catch (err) {
        log.warn('hubspot token revoke failed', { instanceId, err });
      }
    }
    this.cache.delete(instanceId);
    await this.secrets.delete(hubspotTokenSecretName(this.cfg.SECRET_PREFIX, instanceId));
  }
}
