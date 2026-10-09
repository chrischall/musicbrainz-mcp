import { describe, it, expect, vi } from 'vitest';
import { EdgeBlockedError, OAuth2RefreshError, RateLimitError, UnreachableError, withCallSignal } from '@chrischall/mcp-utils';
import { MusicBrainzClient, type Query } from '../src/client.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

// Build a fetch mock that pops a queued response per matching URL substring,
// recording every request for assertions.
function mockFetch(plan: { match: string; responses: Response[] }[]) {
  const calls: Recorded[] = [];
  const queues = plan.map((p) => ({ ...p, responses: [...p.responses] }));
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      ...(init?.body !== undefined ? { body: String(init.body) } : {}),
    });
    const q = queues.find((p) => u.includes(p.match));
    if (!q || q.responses.length === 0) throw new Error(`no mock response for ${u}`);
    return q.responses.shift()!;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const passThrough = <T>(fn: () => Promise<T>): Promise<T> => fn();
const noSleep = (): Promise<void> => Promise.resolve();

type OAuth = ConstructorParameters<typeof MusicBrainzClient>[0]['oauth'];
function makeClient(fetchImpl: typeof fetch, oauth: OAuth = null) {
  return new MusicBrainzClient({ fetchImpl, throttle: passThrough, sleep: noSleep, now: () => 0, oauth });
}

describe('MusicBrainzClient.get', () => {
  it('appends fmt=json, sends the User-Agent, and parses JSON', async () => {
    const { fetchImpl, calls } = mockFetch([{ match: '/ws/2/artist/', responses: [jsonResponse(200, { name: 'Radiohead' })] }]);
    const client = makeClient(fetchImpl);
    const data = await client.get<{ name: string }>('/artist/abc');
    expect(data.name).toBe('Radiohead');
    expect(calls[0].url).toContain('musicbrainz.org/ws/2/artist/abc');
    expect(calls[0].url).toContain('fmt=json');
    expect(calls[0].headers['User-Agent']).toMatch(/musicbrainz-mcp\//);
  });

  it('passes through query params (query/limit/offset)', async () => {
    const { fetchImpl, calls } = mockFetch([{ match: '/ws/2/artist', responses: [jsonResponse(200, { artists: [] })] }]);
    const client = makeClient(fetchImpl);
    const query: Query = { query: 'beatles', limit: 5, offset: 10 };
    await client.get('/artist', query);
    expect(calls[0].url).toContain('query=beatles');
    expect(calls[0].url).toContain('limit=5');
    expect(calls[0].url).toContain('offset=10');
  });

  it('retries a 503 (rate limit) then succeeds', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: '/ws/2/release', responses: [jsonResponse(503, 'busy'), jsonResponse(200, { ok: true })] },
    ]);
    const client = makeClient(fetchImpl);
    const data = await client.get<{ ok: boolean }>('/release/x');
    expect(data.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('throws a RateLimitError when 503 persists past the retry budget', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: '/ws/2/release',
        responses: [jsonResponse(503, 'busy'), jsonResponse(503, 'busy'), jsonResponse(503, 'busy', { 'retry-after': '7' })],
      },
    ]);
    const client = makeClient(fetchImpl);
    await expect(client.get('/release/x')).rejects.toThrow(/Rate limited by MusicBrainz/);
  });

  it('caps a huge Retry-After so one 503 cannot stall the serialized throttle', async () => {
    // A CDN can emit `Retry-After: 3600`. Honoring it verbatim would sleep an
    // hour inside the throttle slot, parking every queued call. The delay must
    // be clamped to MAX_RETRY_AFTER_MS (30s).
    const { fetchImpl } = mockFetch([
      {
        match: '/ws/2/release',
        responses: [jsonResponse(503, 'busy', { 'retry-after': '3600' }), jsonResponse(200, { ok: true })],
      },
    ]);
    const slept: number[] = [];
    const client = new MusicBrainzClient({
      fetchImpl,
      throttle: passThrough,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      now: () => 0,
      oauth: null,
    });
    const data = await client.get<{ ok: boolean }>('/release/x');
    expect(data.ok).toBe(true);
    expect(slept).toEqual([30_000]);
  });

  it('throws a formatted error on a non-2xx', async () => {
    const { fetchImpl } = mockFetch([{ match: '/ws/2/artist', responses: [jsonResponse(404, 'Not Found')] }]);
    const client = makeClient(fetchImpl);
    await expect(client.get('/artist/missing')).rejects.toThrow(/404/);
  });
});

// fleet-audit#1064: user-* incs and private-collection browses need the
// account's bearer; with OAuth configured the read path must send it.
describe('MusicBrainzClient.get — account reads', () => {
  const OAUTH = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' };
  const COLL = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';

  it('sends the bearer on a lookup whose inc asks for user-* data', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: 'oauth2/token', responses: [jsonResponse(200, { access_token: 'AT', expires_in: 3600 })] },
      { match: '/ws/2/recording/', responses: [jsonResponse(200, { 'user-tags': [] })] },
    ]);
    const client = makeClient(fetchImpl, OAUTH);
    await client.get('/recording/abc', { inc: 'tags+user-tags' });
    const read = calls.find((c) => c.url.includes('/ws/2/recording/'))!;
    expect(read.headers['Authorization']).toBe('Bearer AT');
    expect(read.url).toContain('inc=tags%2Buser-tags');
  });

  it('sends the bearer when browsing a collection', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: 'oauth2/token', responses: [jsonResponse(200, { access_token: 'AT', expires_in: 3600 })] },
      { match: '/ws/2/release', responses: [jsonResponse(200, { releases: [] })] },
    ]);
    const client = makeClient(fetchImpl, OAUTH);
    await client.get('/release', { collection: COLL, limit: 5 });
    expect(calls.find((c) => c.url.includes('/ws/2/release'))!.headers['Authorization']).toBe('Bearer AT');
  });

  it('keeps ordinary reads anonymous even when OAuth is configured (no token minted)', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: '/ws/2/artist/', responses: [jsonResponse(200, { name: 'x' })] },
    ]);
    const client = makeClient(fetchImpl, OAUTH);
    await client.get('/artist/abc', { inc: 'tags+ratings' });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['Authorization']).toBeUndefined();
  });

  it('without OAuth, a 401 on an account read says to configure OAuth, not to re-authenticate', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: '/ws/2/recording/', responses: [jsonResponse(401, { error: 'auth' }, { 'content-type': 'application/json' })] },
    ]);
    const client = makeClient(fetchImpl, null);
    const err = await client.get('/recording/abc', { inc: 'user-ratings' }).catch((e) => e);
    expect(calls[0].headers['Authorization']).toBeUndefined();
    expect(String(err.message)).toBe('Unauthorized (401) from MusicBrainz.');
    expect(err.hint).toMatch(/MUSICBRAINZ_OAUTH_/);
    expect(err.hint).not.toMatch(/re-authenticate/);
  });
});

describe('MusicBrainzClient.coverArt', () => {
  it('fetches the Cover Art Archive host', async () => {
    const { fetchImpl, calls } = mockFetch([{ match: 'coverartarchive.org/release/', responses: [jsonResponse(200, { images: [] })] }]);
    const client = makeClient(fetchImpl);
    await client.coverArt('release', 'abc');
    expect(calls[0].url).toBe('https://coverartarchive.org/release/abc');
  });

  it('gives a helpful error on 404 (no art)', async () => {
    const { fetchImpl } = mockFetch([{ match: 'coverartarchive.org/release-group/', responses: [jsonResponse(404, '')] }]);
    const client = makeClient(fetchImpl);
    await expect(client.coverArt('release-group', 'abc')).rejects.toThrow(/No cover art/);
  });
});

describe('MusicBrainzClient writes', () => {
  it('reports oauthConfigured=false and refuses to write without creds', async () => {
    const { fetchImpl } = mockFetch([]);
    const client = makeClient(fetchImpl, null);
    expect(client.oauthConfigured).toBe(false);
    await expect(client.write('POST', '/tag', { xmlBody: '<x/>' })).rejects.toThrow(/OAuth is not configured/);
  });

  it('exchanges the refresh token, then sends bearer + client param + XML content-type', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: 'oauth2/token', responses: [jsonResponse(200, { access_token: 'AT-123', expires_in: 3600 })] },
      { match: '/ws/2/tag', responses: [jsonResponse(200, '')] },
    ]);
    const client = makeClient(fetchImpl, { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    expect(client.oauthConfigured).toBe(true);
    await client.write('POST', '/tag', { xmlBody: '<metadata/>' });

    const tokenCall = calls.find((c) => c.url.includes('oauth2/token'))!;
    expect(tokenCall.body).toContain('grant_type=refresh_token');
    expect(tokenCall.body).toContain('client_id=cid');

    const writeCall = calls.find((c) => c.url.includes('/ws/2/tag'))!;
    expect(writeCall.method).toBe('POST');
    expect(writeCall.headers['Authorization']).toBe('Bearer AT-123');
    expect(writeCall.headers['Content-Type']).toMatch(/application\/xml/);
    expect(writeCall.url).toContain('client=musicbrainz-mcp-');
    expect(writeCall.body).toBe('<metadata/>');
  });

  it('caches the access token across writes', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: 'oauth2/token', responses: [jsonResponse(200, { access_token: 'AT-1', expires_in: 3600 })] },
      { match: '/ws/2/rating', responses: [jsonResponse(200, ''), jsonResponse(200, '')] },
    ]);
    const client = makeClient(fetchImpl, { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    await client.write('POST', '/rating', { xmlBody: '<a/>' });
    await client.write('POST', '/rating', { xmlBody: '<b/>' });
    expect(calls.filter((c) => c.url.includes('oauth2/token'))).toHaveLength(1);
  });

  it('reports a CDN/WAF-blocked refresh as EdgeBlockedError and keeps the stored refresh token', async () => {
    // A Cloudflare refusal page on the token endpoint is not MusicBrainz judging
    // the grant: it must surface as an edge block (not "refresh token revoked —
    // re-authenticate"), and the next write must re-try the SAME refresh token.
    const blocked = new Response(
      '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><div id="cf-error-details">Sorry, you have been blocked</div></body></html>',
      { status: 403, headers: { 'content-type': 'text/html' } },
    );
    const { fetchImpl, calls } = mockFetch([
      {
        match: 'oauth2/token',
        responses: [blocked, jsonResponse(200, { access_token: 'AT-after-block', expires_in: 3600 })],
      },
      { match: '/ws/2/tag', responses: [jsonResponse(200, '<message><text>OK</text></message>')] },
    ]);
    const client = makeClient(fetchImpl, { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt-original' });

    const err = await client.write('POST', '/tag', { xmlBody: '<x/>' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdgeBlockedError);
    expect(err).not.toBeInstanceOf(OAuth2RefreshError);
    expect((err as EdgeBlockedError).vendor).toBe('Cloudflare');
    expect(calls.filter((c) => c.url.includes('/ws/2/tag'))).toHaveLength(0);

    await expect(client.write('POST', '/tag', { xmlBody: '<x/>' })).resolves.toContain('OK');
    const tokenCalls = calls.filter((c) => c.url.includes('oauth2/token'));
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[1]!.body).toContain('refresh_token=rt-original');
    expect(calls.find((c) => c.url.includes('/ws/2/tag'))!.headers['Authorization']).toBe('Bearer AT-after-block');
  });

  it('re-mints the access token when within 60s of expiry', async () => {
    // expires_in: 30 → ttl 30s; with the 60s buffer the cached token is always
    // considered near-expiry, so every write re-mints (single-flight per call).
    const { fetchImpl, calls } = mockFetch([
      {
        match: 'oauth2/token',
        responses: [
          jsonResponse(200, { access_token: 'AT-1', expires_in: 30 }),
          jsonResponse(200, { access_token: 'AT-2', expires_in: 30 }),
        ],
      },
      { match: '/ws/2/rating', responses: [jsonResponse(200, ''), jsonResponse(200, '')] },
    ]);
    const client = makeClient(fetchImpl, { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    await client.write('POST', '/rating', { xmlBody: '<a/>' });
    await client.write('POST', '/rating', { xmlBody: '<b/>' });
    expect(calls.filter((c) => c.url.includes('oauth2/token'))).toHaveLength(2);
    const writes = calls.filter((c) => c.url.includes('/ws/2/rating'));
    expect(writes[0]!.headers['Authorization']).toBe('Bearer AT-1');
    expect(writes[1]!.headers['Authorization']).toBe('Bearer AT-2');
  });

  it('falls back to the 1h default TTL when the token response omits expires_in', async () => {
    // When MusicBrainz answers the refresh without `expires_in`, the mint returns
    // `{ token }` with no `ttlMs`, so createCachedTokenSource applies its 1h
    // default TTL. With the 60s buffer the cached token is reused for anything
    // under T+3_540_000ms and re-minted at/after that boundary. Guards the
    // implicit fallback against future upstream default-TTL changes.
    const { fetchImpl, calls } = mockFetch([
      {
        match: 'oauth2/token',
        responses: [
          jsonResponse(200, { access_token: 'AT-1' }), // no expires_in → default TTL
          jsonResponse(200, { access_token: 'AT-2' }),
        ],
      },
      { match: '/ws/2/rating', responses: [jsonResponse(200, ''), jsonResponse(200, ''), jsonResponse(200, '')] },
    ]);
    let clock = 0;
    const client = new MusicBrainzClient({
      fetchImpl,
      throttle: passThrough,
      sleep: noSleep,
      now: () => clock,
      oauth: { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' },
    });

    // Mint at t=0.
    await client.write('POST', '/rating', { xmlBody: '<a/>' });
    // Just inside the default-TTL freshness window (T + 3_600_000 - 60_000): reused.
    clock = 3_539_999;
    await client.write('POST', '/rating', { xmlBody: '<b/>' });
    expect(calls.filter((c) => c.url.includes('oauth2/token'))).toHaveLength(1);
    // At the boundary the buffered token is stale, so the next write re-mints.
    clock = 3_540_000;
    await client.write('POST', '/rating', { xmlBody: '<c/>' });
    expect(calls.filter((c) => c.url.includes('oauth2/token'))).toHaveLength(2);

    const writes = calls.filter((c) => c.url.includes('/ws/2/rating'));
    expect(writes.map((w) => w.headers['Authorization'])).toEqual(['Bearer AT-1', 'Bearer AT-1', 'Bearer AT-2']);
  });

  it('PUT/DELETE send no body and no content-type (collections)', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: 'oauth2/token', responses: [jsonResponse(200, { access_token: 'AT', expires_in: 3600 })] },
      { match: '/ws/2/collection/', responses: [jsonResponse(200, '')] },
    ]);
    const client = makeClient(fetchImpl, { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    await client.write('PUT', '/collection/COL/releases/R1;R2');
    const c = calls.find((x) => x.url.includes('/collection/'))!;
    expect(c.method).toBe('PUT');
    expect(c.body).toBeUndefined();
    expect(c.headers['Content-Type']).toBeUndefined();
    expect(c.url).toContain('client=musicbrainz-mcp-');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Transport behaviour on the shared mcp-utils createApiClient (fleet-audit
// #1065 / #576 / #869), pinned with fake timers against the REAL timer-based
// sleep, timeout and throttle.
// ────────────────────────────────────────────────────────────────────────────
describe('MusicBrainzClient transport (fake timers)', () => {
  /** A fetch that never answers until its signal aborts. */
  function hangingFetch() {
    const calls: string[] = [];
    const fetchImpl = vi.fn(
      (url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          calls.push(String(url));
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
  }

  it('times a hung request out at 20s as UnreachableError', async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl, calls } = hangingFetch();
      const client = new MusicBrainzClient({ fetchImpl, throttle: passThrough, oauth: null });
      const pending = client.get('/artist/x').catch((e) => e);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const err = await pending;
      expect(err).toBeInstanceOf(UnreachableError);
      expect(String(err.message)).toMatch(/MusicBrainz unreachable/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a body that stalls after the headers (#576)', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = (async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 })) as unknown as typeof fetch;
      const client = new MusicBrainzClient({ fetchImpl, throttle: passThrough, oauth: null });
      const pending = client.get('/artist/x').catch((e) => e);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toBeInstanceOf(UnreachableError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a delta-seconds Retry-After (sleeps 7s, then replays)', async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl, calls } = mockFetch([
        { match: '/ws/2/release', responses: [jsonResponse(429, 'slow', { 'retry-after': '7' }), jsonResponse(200, { ok: true })] },
      ]);
      const client = new MusicBrainzClient({ fetchImpl, throttle: passThrough, oauth: null });
      const pending = client.get<{ ok: boolean }>('/release/x');
      await vi.advanceTimersByTimeAsync(6_999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ ok: true });
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the 1.1s spacing for an HTTP-date Retry-After', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: '/ws/2/release',
        responses: [jsonResponse(503, 'busy', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), jsonResponse(200, {})],
      },
    ]);
    const slept: number[] = [];
    const client = new MusicBrainzClient({
      fetchImpl,
      throttle: passThrough,
      sleep: async (ms) => {
        slept.push(ms);
      },
      oauth: null,
    });
    await client.get('/release/x');
    expect(slept).toEqual([1100]);
  });

  it('keeps the upstream Retry-After on the exhausted RateLimitError', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        match: '/ws/2/release',
        responses: [jsonResponse(429, ''), jsonResponse(503, ''), jsonResponse(503, 'busy', { 'retry-after': '7' })],
      },
    ]);
    const client = makeClient(fetchImpl);
    const err = await client.get('/release/x').catch((e) => e);
    expect(calls).toHaveLength(3); // initial + 2 retries
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBe(7);
    expect(String(err.message)).toBe('Rate limited by MusicBrainz. Retry after 7s.');
  });

  it('maps a 401 on a read to the re-authenticate error', async () => {
    const { fetchImpl } = mockFetch([{ match: '/ws/2/artist', responses: [jsonResponse(401, { error: 'nope' }, { 'content-type': 'application/json' })] }]);
    const client = makeClient(fetchImpl);
    await expect(client.get('/artist/x')).rejects.toThrow('Unauthorized (401) from MusicBrainz.');
  });

  it('maps a 401 on a write to the re-authenticate error with the scope hint (after one re-mint)', async () => {
    const unauthorized = () => jsonResponse(401, { error: 'nope' }, { 'content-type': 'application/json' });
    const { fetchImpl, calls } = mockFetch([
      {
        match: 'oauth2/token',
        responses: [
          jsonResponse(200, { access_token: 'AT', expires_in: 3600 }),
          jsonResponse(200, { access_token: 'AT2', expires_in: 3600 }),
        ],
      },
      { match: '/ws/2/tag', responses: [unauthorized(), unauthorized()] },
    ]);
    const client = makeClient(fetchImpl, { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    const err = await client.write('POST', '/tag', { xmlBody: '<x/>' }).catch((e) => e);
    expect(String(err.message)).toBe('Unauthorized (401) from MusicBrainz.');
    expect(err.hint).toMatch(/tag\/rating\/collection/);
    // One replay only — a second 401 is surfaced, not looped on.
    expect(calls.filter((c) => c.url.includes('/ws/2/tag'))).toHaveLength(2);
  });

  // fleet-audit#575: a cached access token that MusicBrainz has revoked early
  // must not keep every write failing until it would have expired.
  it('drops the cached token on a write 401 and replays once with a freshly minted one', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        match: 'oauth2/token',
        responses: [
          jsonResponse(200, { access_token: 'STALE', expires_in: 3600 }),
          jsonResponse(200, { access_token: 'FRESH', expires_in: 3600 }),
        ],
      },
      {
        match: '/ws/2/tag',
        responses: [
          jsonResponse(401, { error: 'revoked' }, { 'content-type': 'application/json' }),
          jsonResponse(200, '<message><text>OK</text></message>'),
          jsonResponse(200, '<message><text>OK</text></message>'),
        ],
      },
    ]);
    const client = makeClient(fetchImpl, { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    await expect(client.write('POST', '/tag', { xmlBody: '<x/>' })).resolves.toBe('<message><text>OK</text></message>');
    const tagCalls = calls.filter((c) => c.url.includes('/ws/2/tag'));
    expect(tagCalls.map((c) => c.headers['Authorization'])).toEqual(['Bearer STALE', 'Bearer FRESH']);
    expect(tagCalls[1].body).toBe('<x/>');
    // The fresh token is what is cached now: the next write needs no re-mint.
    await client.write('POST', '/tag', { xmlBody: '<x/>' });
    expect(calls.filter((c) => c.url.includes('oauth2/token'))).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes('/ws/2/tag')).at(-1)!.headers['Authorization']).toBe('Bearer FRESH');
  });

  it('formats a non-2xx write as an McpToolError naming method + path (no query string)', async () => {
    const { fetchImpl } = mockFetch([
      { match: 'oauth2/token', responses: [jsonResponse(200, { access_token: 'AT', expires_in: 3600 })] },
      { match: '/ws/2/tag', responses: [jsonResponse(400, 'bad xml')] },
    ]);
    const client = makeClient(fetchImpl, { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    await expect(client.write('POST', '/tag', { xmlBody: '<x/>' })).rejects.toThrow(
      'MusicBrainz error 400 for POST /tag: bad xml',
    );
  });

  it('re-sends the XML body and Content-Type on a retried write', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: 'oauth2/token', responses: [jsonResponse(200, { access_token: 'AT', expires_in: 3600 })] },
      {
        match: '/ws/2/tag',
        responses: [jsonResponse(503, 'busy'), jsonResponse(429, 'slow'), jsonResponse(200, '<message><text>OK</text></message>')],
      },
    ]);
    const client = makeClient(fetchImpl, { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    await expect(client.write('POST', '/tag', { xmlBody: '<metadata/>' })).resolves.toBe('<message><text>OK</text></message>');
    const writes = calls.filter((c) => c.url.includes('/ws/2/tag'));
    expect(writes).toHaveLength(3);
    for (const w of writes) {
      expect(w.method).toBe('POST');
      expect(w.body).toBe('<metadata/>');
      expect(w.headers['Content-Type']).toBe('application/xml; charset=utf-8');
      expect(w.headers['Authorization']).toBe('Bearer AT');
      expect(w.url).toContain('client=musicbrainz-mcp-');
    }
  });

  it('sends exactly one Content-Type (the XML one) on a write, never a JSON default beside it', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: 'oauth2/token', responses: [jsonResponse(200, { access_token: 'AT', expires_in: 3600 })] },
      { match: '/ws/2/rating', responses: [jsonResponse(200, '<message><text>OK</text></message>')] },
    ]);
    const client = makeClient(fetchImpl, { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    await client.write('POST', '/rating', { xmlBody: '<metadata/>' });
    const w = calls.find((c) => c.url.includes('/ws/2/rating'))!;
    const contentTypes = Object.entries(w.headers).filter(([k]) => k.toLowerCase() === 'content-type');
    expect(contentTypes).toEqual([['Content-Type', 'application/xml; charset=utf-8']]);
  });

  it('holds the 1 request/second limit across concurrent calls AND their retries', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const starts: number[] = [];
      let n = 0;
      const fetchImpl = (async () => {
        starts.push(Date.now());
        n += 1;
        // The first call is told to retry immediately (Retry-After: 0) — the
        // retry must still wait its turn in the 1.1s spacing.
        return n === 1
          ? jsonResponse(503, 'busy', { 'retry-after': '0' })
          : jsonResponse(200, { ok: true });
      }) as unknown as typeof fetch;
      // Default throttle + default sleep: the production spacing.
      const client = new MusicBrainzClient({ fetchImpl, oauth: null });
      const all = Promise.all([client.get('/a'), client.get('/b'), client.coverArt('release', 'r')]);
      await vi.advanceTimersByTimeAsync(10_000);
      await all;
      expect(starts).toHaveLength(4);
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(1100);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// fleet-audit#577: a call the client has cancelled must stop taking throttle
// slots and sleeping out Retry-After for nobody — every queued call waits on it.
describe('MusicBrainzClient cancellation', () => {
  it('a call cancelled before it reaches the throttle sends nothing', async () => {
    const { fetchImpl, calls } = mockFetch([{ match: '/ws/2/artist', responses: [jsonResponse(200, {})] }]);
    const throttle = vi.fn(passThrough);
    const client = new MusicBrainzClient({ fetchImpl, throttle, sleep: noSleep, now: () => 0, oauth: null });
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    const err = await withCallSignal(controller.signal, () => client.get('/artist/x')).catch((e) => e);
    expect(calls).toHaveLength(0);
    expect(throttle).not.toHaveBeenCalled();
    expect(err).not.toBeInstanceOf(UnreachableError);
    expect(String(err.message)).toContain('user cancelled');
  });

  it('a cancellation during a Retry-After wait ends the wait and makes no retry', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: '/ws/2/release', responses: [jsonResponse(503, 'busy', { 'retry-after': '30' }), jsonResponse(200, {})] },
    ]);
    const sleeps: number[] = [];
    // A sleep that never ends by itself: only the cancellation can end it.
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return new Promise<void>(() => {});
    };
    const client = new MusicBrainzClient({ fetchImpl, throttle: passThrough, sleep, now: () => 0, oauth: null });
    const controller = new AbortController();
    const pending = withCallSignal(controller.signal, () => client.get('/release/x')).catch((e) => e);
    await vi.waitFor(() => expect(sleeps).toHaveLength(1));
    controller.abort(new Error('user cancelled'));
    const err = await pending;
    expect(String(err.message)).toContain('user cancelled');
    expect(calls).toHaveLength(1);
  });
});
