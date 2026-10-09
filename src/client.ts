import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  loadDotenvSafely,
  readEnvVar,
  createApiClient,
  ApiError,
  createHelpfulError,
  McpToolError,
  RateLimitError,
  UnreachableError,
  createOAuth2Refresher,
  createCachedTokenSource,
  createThrottle,
  currentCallSignal,
  type CachedTokenSource,
  type ReactiveTokenSource,
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
// Retry budget for a 503/429 (rate-limit) response.
const MAX_RATE_RETRIES = 2;
const RATE_STATUSES = [429, 503];
// Ceiling on an honored `Retry-After` (mirroring viator's 30s cap) — an
// uncapped value (a CDN can emit `Retry-After: 3600`) would pin a tool call
// open for an hour.
const MAX_RETRY_AFTER_MS = 30_000;
const READ_401_HINT = 'The OAuth access token is missing, invalid, or lacks the required scope — re-authenticate.';
// A read of the user's own data (user-* inc, a private collection) without
// OAuth configured: nothing to re-authenticate, the server has no credentials.
const ACCOUNT_READ_401_HINT =
  'This read asks for your own MusicBrainz data (a user-* inc such as user-tags/user-ratings, or a private collection), which needs your account: set MUSICBRAINZ_OAUTH_CLIENT_ID, MUSICBRAINZ_OAUTH_CLIENT_SECRET, and MUSICBRAINZ_OAUTH_REFRESH_TOKEN.';
const WRITE_401_HINT =
  'The OAuth access token is missing, invalid, or lacks the required scope (tag/rating/collection) — re-authenticate.';
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
  // The cached-token source single-flights the refresh and re-mints ~1 min
  // before expiry; it's null until OAuth is configured.
  private readonly tokenSource: CachedTokenSource | null;
  private readonly oauthConfigError: McpToolError | null;

  constructor(opts: ClientOptions = {}) {
    this.ua = opts.userAgent ?? readEnvVar('MUSICBRAINZ_USER_AGENT') ?? defaultUserAgent();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.throttle = opts.throttle ?? createThrottle({ minIntervalMs: MIN_INTERVAL_MS });

    const oauth = opts.oauth !== undefined ? opts.oauth : readOAuthFromEnv();
    if (oauth) {
      const refresh = createOAuth2Refresher({
        endpoint: OAUTH_TOKEN_URL,
        refreshToken: oauth.refreshToken,
        params: { client_id: oauth.clientId, client_secret: oauth.clientSecret },
        retry: { count: 1, delayMs: 1000 },
        fetchImpl: this.fetchImpl,
      });
      // Cache the minted access token, refreshing ~1 min before expiry so an
      // in-flight write never races the deadline. `ttlMs` uses the refresher's
      // `expiresIn` so the buffer is measured against the same injected clock;
      // when the server omits `expires_in`, the source's 1 h default applies
      // (matching the previous `now + 3_600_000` fallback).
      this.tokenSource = createCachedTokenSource({
        mint: async () => {
          const r = await refresh();
          return r.expiresIn !== undefined
            ? { token: r.accessToken, ttlMs: r.expiresIn * 1000 }
            : { token: r.accessToken };
        },
        bufferMs: 60_000,
        now: this.now,
      });
      this.oauthConfigError = null;
    } else {
      this.tokenSource = null;
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

  /**
   * One request through the shared mcp-utils `createApiClient`: a 20s timeout
   * per attempt that also bounds the body read, up to {@link MAX_RATE_RETRIES}
   * retries on 429/503 honoring a (capped) `Retry-After`, and the 401 / 429 /
   * non-2xx mapping. Returns the raw body text.
   *
   * The client is built per call because two things live at its fetch seam:
   *  - THE THROTTLE. Every individual HTTP attempt — retries included — takes
   *    its own slot, so MusicBrainz's 1 request/second limit holds across
   *    concurrent calls and their retries (a `Retry-After: 0` cannot jump the
   *    queue). Throttling the whole call instead let a retry and the next
   *    queued request land back to back.
   *  - The last `Retry-After` seen, so an exhausted rate limit still tells the
   *    caller how long MusicBrainz asked it to wait; and the raw XML body of a
   *    write, which `createApiClient` (JSON bodies only) cannot express.
   */
  private async call(
    base: string,
    method: string,
    path: string,
    opts: { query?: Query; auth?: ReactiveTokenSource; xmlBody?: string; unauthorizedHint: string },
  ): Promise<string> {
    let retryAfter: string | null = null;
    const api = createApiClient({
      baseUrl: base,
      serviceName: SERVICE,
      ...(opts.auth ? { tokenManager: opts.auth } : {}),
      baseHeaders: { 'User-Agent': this.ua },
      timeout: REQUEST_TIMEOUT_MS,
      retry: {
        count: MAX_RATE_RETRIES,
        delayMs: MIN_INTERVAL_MS,
        statuses: RATE_STATUSES,
        honorRetryAfter: true,
        maxRetryAfterMs: MAX_RETRY_AFTER_MS,
      },
      // The Retry-After wait ends the moment the caller cancels, rather than
      // sleeping up to 30s for nobody and then queueing another attempt.
      sleep: (ms) => cancellableSleep(this.sleep, ms, currentCallSignal()),
      // The throttle sits at the fetch seam so every HTTP *attempt* (retries
      // included) takes a 1.1s slot. The seam also captures `Retry-After`: the
      // `onRateLimited` ctx only covers a final 429, and MusicBrainz's own
      // rate limit is a 503, which surfaces as a plain ApiError without headers.
      // A cancelled call (`init.signal` carries the caller's cancellation,
      // folded in by createApiClient) never takes a slot: checked before it
      // queues and again when its slot comes up, so it sends nothing and the
      // calls behind it are not held up by it.
      fetchImpl: (async (url: string, init: RequestInit) => {
        init.signal?.throwIfAborted();
        const res = await this.throttle(() => {
          init.signal?.throwIfAborted();
          return this.fetchImpl(url, init);
        });
        retryAfter = res.headers.get('retry-after');
        return res;
      }) as typeof fetch,
      onUnauthorized: () => createHelpfulError(`Unauthorized (401) from ${SERVICE}.`, { hint: opts.unauthorizedHint }),
      onRateLimited: () => rateLimitError(retryAfter),
    });
    try {
      return await api.fetchHtml(method, path, {
        headers: { Accept: 'application/json' },
        ...(opts.query ? { query: opts.query } : {}),
        ...(opts.xmlBody !== undefined ? { rawBody: opts.xmlBody, contentType: XML_CONTENT_TYPE } : {}),
      });
    } catch (err) {
      // Includes WriteOutcomeUnknownError (mcp-utils 3.0): a write that was sent
      // but timed out or lost its connection may have landed, so it must not
      // be flattened into a retry-safe UnreachableError below.
      if (err instanceof McpToolError) throw err;
      // The caller cancelled: surface its reason, not "unreachable".
      const cancelled = currentCallSignal();
      if (cancelled?.aborted) throw cancelled.reason;
      if (err instanceof ApiError) {
        // An exhausted 503 surfaces as a plain ApiError (only 429 has its own
        // hook); MusicBrainz uses 503 for its rate limit, so it is one too.
        if (RATE_STATUSES.includes(err.status)) throw rateLimitError(retryAfter);
        throw new McpToolError(err.message, { cause: err });
      }
      // A read timeout (RequestTimeoutError) or a network failure.
      throw new UnreachableError(SERVICE);
    }
  }

  /**
   * Read request against the /ws/2 web service. Always JSON. Anonymous, except
   * a read of the user's own data (a `user-*` inc, or browsing by collection —
   * private collections need the owner): that carries the OAuth bearer when
   * OAuth is configured, and otherwise explains that it needs it.
   */
  async get<T>(path: string, query: Query = {}): Promise<T> {
    const account = isAccountRead(query);
    const auth = account && this.tokenSource ? this.bearer(await this.accessToken()) : undefined;
    const text = await this.call(WS_BASE, 'GET', path, {
      query: { ...query, fmt: 'json' },
      ...(auth ? { auth } : {}),
      unauthorizedHint: account && !auth ? ACCOUNT_READ_401_HINT : READ_401_HINT,
    });
    return parseJson<T>(text);
  }

  /** Cover Art Archive lookup (a separate host) for a release / release-group. */
  async coverArt<T>(entity: 'release' | 'release-group', mbid: string): Promise<T> {
    const path = `/${entity}/${encodeURIComponent(mbid)}`;
    let text: string;
    try {
      text = await this.call(CAA_BASE, 'GET', path, { unauthorizedHint: READ_401_HINT });
    } catch (err) {
      if (err instanceof McpToolError && err.cause instanceof ApiError && err.cause.status === 404) {
        throw createHelpfulError(`No cover art found for ${entity} ${mbid}.`, {
          hint: 'The Cover Art Archive has no images for this MBID. Try a different release in the release-group.',
        });
      }
      throw err;
    }
    return parseJson<T>(text);
  }

  private async accessToken(): Promise<string> {
    if (this.oauthConfigError) throw this.oauthConfigError;
    return this.tokenSource!.getToken();
  }

  /**
   * The bearer for an authenticated request, with one reactive 401-replay: a
   * cached access token MusicBrainz has stopped accepting (revoked, re-granted,
   * rotated early) is dropped and the request is sent once more with a freshly
   * minted one. Without this the stale token stayed cached until its reported
   * expiry (up to an hour) and every write failed with "re-authenticate" while
   * the refresh token was still good. A second 401 is surfaced as the error.
   */
  private bearer(token: string): ReactiveTokenSource {
    // `current` follows the re-mint, so a 429/503 retry after a replay reuses
    // the fresh token instead of re-sending the rejected one.
    let current = token;
    let replayed = false;
    return {
      withAuth: async (send) => {
        const res = await send(current);
        if (res.status !== 401 || replayed) return res;
        replayed = true;
        await res.body?.cancel();
        this.tokenSource!.invalidate();
        current = await this.accessToken();
        return send(current);
      },
    };
  }

  /**
   * OAuth-authenticated write against the /ws/2 web service. Attaches the bearer
   * token and the mandatory `client=` param centrally; `xmlBody` (when present)
   * is sent as `application/xml`. Collection PUT/DELETE pass no body. Returns the
   * raw response body — MusicBrainz answers writes with an XML
   * `<message><text>OK</text></message>`, not JSON, so we never JSON.parse it.
   */
  async write(method: 'POST' | 'PUT' | 'DELETE', path: string, opts: { query?: Query; xmlBody?: string } = {}): Promise<string> {
    // Mint (or reuse) the token up front so a config or refresh failure
    // surfaces as itself, before the request takes a throttle slot.
    const token = await this.accessToken();
    return this.call(WS_BASE, method, path, {
      query: { ...opts.query, client: CLIENT_PARAM },
      auth: this.bearer(token),
      ...(opts.xmlBody !== undefined ? { xmlBody: opts.xmlBody } : {}),
      unauthorizedHint: WRITE_401_HINT,
    });
  }
}

/** Whether a read asks for the user's own data: a `user-*` inc or a collection browse. */
function isAccountRead(query: Query): boolean {
  if (query.collection !== undefined) return true;
  const inc = query.inc;
  const parts = Array.isArray(inc) ? inc : typeof inc === 'string' ? inc.split(/[+ ]/) : [];
  return parts.some((p) => p.startsWith('user-'));
}

/** `sleep(ms)`, ended early (rejecting with the signal's reason) when `signal` aborts. */
function cancellableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Parse a JSON body; an empty body (e.g. a 204-style answer) is `undefined`. */
function parseJson<T>(text: string): T {
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

/** The rate-limit error, carrying the upstream's delta-seconds `Retry-After` when it sent one. */
function rateLimitError(retryAfter: string | null): RateLimitError {
  const secs = Number(retryAfter);
  return new RateLimitError(SERVICE, retryAfter && secs > 0 ? secs : undefined);
}

/**
 * Module-level singleton shared by every tool module. Constructing it here (not
 * in `index.ts`) keeps the deferred-config-error pattern: the server boots and
 * answers the host's install-time tools/list smoke test even when OAuth creds
 * are absent — the write-config error only surfaces on the first write call.
 */
export const client = new MusicBrainzClient();
