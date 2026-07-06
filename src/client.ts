import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  loadDotenvSafely,
  readEnvVar,
  buildQueryString,
  formatApiError,
  createHelpfulError,
  McpToolError,
  RateLimitError,
  UnreachableError,
  createOAuth2Refresher,
  createThrottle,
  type Throttle,
} from '@chrischall/mcp-utils';
import { VERSION } from './version.js';

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. the
// mcpb bundle). `loadDotenvSafely` swallows a missing dotenv module and never
// lets .env override a host-provided value.
const __dirname = dirname(fileURLToPath(import.meta.url));
await loadDotenvSafely({ path: join(__dirname, '..', '.env'), override: false });

const WS_BASE = 'https://musicbrainz.org/ws/2';
const CAA_BASE = 'https://coverartarchive.org';
const OAUTH_TOKEN_URL = 'https://musicbrainz.org/oauth2/token';
const SERVICE = 'MusicBrainz';
// > 1s so we never trip the 1-request/second limit (which returns 503).
const MIN_INTERVAL_MS = 1100;
const REQUEST_TIMEOUT_MS = 20_000;
// Retry budget for a 503/429 (rate-limit) response after the throttle.
const MAX_RATE_RETRIES = 2;
// Ceiling on an honored `Retry-After` (mirroring viator's 30s cap). Because the
// backoff sleeps *inside* the serialized throttle slot, an uncapped value (a CDN
// can emit `Retry-After: 3600`) would park every queued call for that long.
const MAX_RETRY_AFTER_MS = 30_000;
// Every write must carry `client=<appname>-<version>` (MusicBrainz requirement).
const CLIENT_PARAM = `musicbrainz-mcp-${VERSION}`;
export const XML_CONTENT_TYPE = 'application/xml; charset=utf-8';

/** Query params for a GET/write — undefined/null/empty members are dropped. */
export type Query = Record<string, string | number | string[] | undefined>;

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface ClientOptions {
  /** Injectable fetch (for tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable throttle (tests pass a pass-through). Defaults to a 1.1s spacer. */
  throttle?: Throttle;
  /** Injectable clock (token-expiry checks). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep (rate-limit backoff). Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Override the default `User-Agent`. */
  userAgent?: string;
  /** OAuth credentials. `null` leaves the write path unconfigured. */
  oauth?: OAuthConfig | null;
}

function defaultUserAgent(): string {
  return `musicbrainz-mcp/${VERSION} ( https://github.com/chrischall/musicbrainz-mcp )`;
}

function readOAuthFromEnv(): OAuthConfig | null {
  const clientId = readEnvVar('MUSICBRAINZ_OAUTH_CLIENT_ID');
  const clientSecret = readEnvVar('MUSICBRAINZ_OAUTH_CLIENT_SECRET');
  const refreshToken = readEnvVar('MUSICBRAINZ_OAUTH_REFRESH_TOKEN');
  if (clientId && clientSecret && refreshToken) return { clientId, clientSecret, refreshToken };
  return null;
}

export class MusicBrainzClient {
  private readonly ua: string;
  private readonly fetchImpl: typeof fetch;
  private readonly throttle: Throttle;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  // OAuth (writes only). Reads are open, so there is no read-side config error.
  private readonly refresh: (() => Promise<{ accessToken: string; expiresAt?: Date }>) | null;
  private readonly oauthConfigError: McpToolError | null;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(opts: ClientOptions = {}) {
    this.ua = opts.userAgent ?? readEnvVar('MUSICBRAINZ_USER_AGENT') ?? defaultUserAgent();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.throttle = opts.throttle ?? createThrottle({ minIntervalMs: MIN_INTERVAL_MS });

    const oauth = opts.oauth !== undefined ? opts.oauth : readOAuthFromEnv();
    if (oauth) {
      this.refresh = createOAuth2Refresher({
        endpoint: OAUTH_TOKEN_URL,
        refreshToken: oauth.refreshToken,
        params: { client_id: oauth.clientId, client_secret: oauth.clientSecret },
        retry: { count: 1, delayMs: 1000 },
        fetchImpl: this.fetchImpl,
      });
      this.oauthConfigError = null;
    } else {
      this.refresh = null;
      this.oauthConfigError = createHelpfulError(
        'MusicBrainz OAuth is not configured — the write tools (tags, ratings, collections) need credentials.',
        {
          hint: 'Register an application at https://musicbrainz.org/account/applications, complete the OAuth flow, and set MUSICBRAINZ_OAUTH_CLIENT_ID, MUSICBRAINZ_OAUTH_CLIENT_SECRET, and MUSICBRAINZ_OAUTH_REFRESH_TOKEN.',
        },
      );
    }
  }

  /** Whether the OAuth write path is configured. */
  get oauthConfigured(): boolean {
    return this.oauthConfigError === null;
  }

  // One throttled HTTP attempt-loop: spacing is enforced by the queue; a 503/429
  // is retried (honoring Retry-After) up to MAX_RATE_RETRIES inside the same slot.
  private send(method: string, url: string, init: { headers: Record<string, string>; body?: string }): Promise<Response> {
    return this.throttle(async () => {
      let attempt = 0;
      for (;;) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            method,
            headers: init.headers,
            ...(init.body !== undefined ? { body: init.body } : {}),
            signal: controller.signal,
          });
        } catch (e) {
          throw e instanceof Error && e.name === 'AbortError'
            ? new UnreachableError(SERVICE)
            : new UnreachableError(SERVICE);
        } finally {
          clearTimeout(timer);
        }

        if ((res.status === 503 || res.status === 429) && attempt < MAX_RATE_RETRIES) {
          attempt += 1;
          const retryAfter = Number(res.headers.get('retry-after'));
          await this.sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : MIN_INTERVAL_MS);
          continue;
        }
        return res;
      }
    });
  }

  private async parseJson<T>(res: Response, method: string, path: string): Promise<T> {
    if (res.status === 401) {
      throw createHelpfulError(`Unauthorized (401) from ${SERVICE}.`, {
        hint: 'The OAuth access token is missing, invalid, or lacks the required scope — re-authenticate.',
      });
    }
    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new RateLimitError(SERVICE, retryAfter > 0 ? retryAfter : undefined);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new McpToolError(formatApiError(res.status, method, path, text, { service: SERVICE }));
    }
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** Read request against the /ws/2 web service. Always JSON; no auth. */
  async get<T>(path: string, query: Query = {}): Promise<T> {
    const qs = buildQueryString({ ...query, fmt: 'json' });
    const res = await this.send('GET', `${WS_BASE}${path}${qs}`, {
      headers: { 'User-Agent': this.ua, Accept: 'application/json' },
    });
    return this.parseJson<T>(res, 'GET', path);
  }

  /** Cover Art Archive lookup (a separate host) for a release / release-group. */
  async coverArt<T>(entity: 'release' | 'release-group', mbid: string): Promise<T> {
    const path = `/${entity}/${encodeURIComponent(mbid)}`;
    const res = await this.send('GET', `${CAA_BASE}${path}`, {
      headers: { 'User-Agent': this.ua, Accept: 'application/json' },
    });
    if (res.status === 404) {
      throw createHelpfulError(`No cover art found for ${entity} ${mbid}.`, {
        hint: 'The Cover Art Archive has no images for this MBID. Try a different release in the release-group.',
      });
    }
    return this.parseJson<T>(res, 'GET', path);
  }

  private async accessToken(): Promise<string> {
    if (this.oauthConfigError) throw this.oauthConfigError;
    const now = this.now();
    // Refresh ~1 min before expiry so an in-flight write never races the deadline.
    if (this.cachedToken && this.cachedToken.expiresAt - 60_000 > now) return this.cachedToken.token;
    const r = await this.refresh!();
    this.cachedToken = {
      token: r.accessToken,
      expiresAt: r.expiresAt ? r.expiresAt.getTime() : now + 3_600_000,
    };
    return this.cachedToken.token;
  }

  /**
   * OAuth-authenticated write against the /ws/2 web service. Attaches the bearer
   * token and the mandatory `client=` param centrally; `xmlBody` (when present)
   * is sent as `application/xml`. Collection PUT/DELETE pass no body. Returns the
   * raw response body — MusicBrainz answers writes with an XML
   * `<message><text>OK</text></message>`, not JSON, so we never JSON.parse it.
   */
  async write(method: 'POST' | 'PUT' | 'DELETE', path: string, opts: { query?: Query; xmlBody?: string } = {}): Promise<string> {
    const token = await this.accessToken();
    const qs = buildQueryString({ ...opts.query, client: CLIENT_PARAM });
    const headers: Record<string, string> = {
      'User-Agent': this.ua,
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (opts.xmlBody !== undefined) headers['Content-Type'] = XML_CONTENT_TYPE;
    const res = await this.send(method, `${WS_BASE}${path}${qs}`, {
      headers,
      ...(opts.xmlBody !== undefined ? { body: opts.xmlBody } : {}),
    });

    if (res.status === 401) {
      throw createHelpfulError(`Unauthorized (401) from ${SERVICE}.`, {
        hint: 'The OAuth access token is missing, invalid, or lacks the required scope (tag/rating/collection) — re-authenticate.',
      });
    }
    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new RateLimitError(SERVICE, retryAfter > 0 ? retryAfter : undefined);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new McpToolError(formatApiError(res.status, method, path, text, { service: SERVICE }));
    }
    return text;
  }
}

/**
 * Module-level singleton shared by every tool module. Constructing it here (not
 * in `index.ts`) keeps the deferred-config-error pattern: the server boots and
 * answers the host's install-time tools/list smoke test even when OAuth creds
 * are absent — the write-config error only surfaces on the first write call.
 */
export const client = new MusicBrainzClient();
