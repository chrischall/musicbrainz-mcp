import { describe, it, expect } from 'vitest';
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
