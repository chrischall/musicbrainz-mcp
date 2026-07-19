# musicbrainz-mcp

MCP server for [MusicBrainz](https://musicbrainz.org), the open music encyclopedia. Wraps the `/ws/2` REST API (`https://musicbrainz.org/ws/2`) plus the Cover Art Archive and exposes 9 tools to Claude over stdio: 6 read-only (search/lookup/browse/cover-art/resolve/healthcheck) and 3 OAuth-authenticated, confirm-gated writes (tags, ratings, collections).

## Commands

```bash
npm run build          # tsc + esbuild bundle → dist/index.js + dist/bundle.js
npm test               # vitest run
npm run test:watch     # vitest watch
npm run test:coverage  # vitest run --coverage (v8 reporter, no thresholds)
```

Run locally (requires built `dist/`):
```bash
node dist/index.js      # reads work with no creds; writes need MUSICBRAINZ_OAUTH_*
```

## Tool naming

All tools are prefixed `musicbrainz_` and use a generic **entity-enum** shape rather than per-entity tools: `musicbrainz_search` / `_lookup` / `_browse` take an `entity` argument covering all 13 core MusicBrainz entities.

## Architecture

```
src/
  version.ts      # single source of truth for VERSION (x-release-please-version)
  index.ts        # MCP server entry — runMcp({ name, version, banner, tools })
  client.ts       # MusicBrainzClient — reads (no auth), Cover Art Archive, OAuth + XML writes; throttled ≥1.1s
  entities.ts     # entity enums + MBID schema shared across tools
  xml.ts          # mmd-2.0 submission XML builders (tags / ratings)
  attribution.ts  # ATTRIBUTION_NOTE appended to data tool descriptions
  tools/
    lookup.ts       # musicbrainz_lookup
    search.ts       # musicbrainz_search
    browse.ts       # musicbrainz_browse
    coverart.ts     # musicbrainz_cover_art (Cover Art Archive)
    resolve.ts      # musicbrainz_resolve (URL → entity)
    utilities.ts    # musicbrainz_healthcheck
    tags.ts         # musicbrainz_submit_tags (OAuth, confirm-gated)
    ratings.ts      # musicbrainz_submit_rating (OAuth, confirm-gated)
    collections.ts  # musicbrainz_modify_collection (OAuth, confirm-gated)
```

Each tool file exports `register<Domain>Tools(server)` calling `server.registerTool(name, { description, annotations, inputSchema }, handler)` and returns results via `textResult(...)`. `index.ts` wires them through `runMcp`.

## Rate limiting (the central constraint)

MusicBrainz allows **at most 1 request/second** per source; exceeding it returns **HTTP 503** and can get the IP blocked. `client.ts` enforces this *proactively* via `createThrottle` from `@chrischall/mcp-utils` (a serialized min-interval scheduler originally hoisted from this repo): every upstream call (reads and writes) funnels through one serialized queue that spaces request *starts* ≥1.1s apart, so concurrent tool calls line up instead of bursting. `client.send` additionally retries a 503/429 up to twice (honoring `Retry-After`). Don't add a code path that hits MusicBrainz outside `client` — it would bypass the throttle.

## Auth & client

- **Reads need no auth.** `client.get` issues a throttled `GET … &fmt=json` with a descriptive `User-Agent` (MusicBrainz blocks generic/empty UAs).
- **Writes use OAuth2.** `client.write` attaches a Bearer token (via `createOAuth2Refresher` from `@chrischall/mcp-utils`, cached with expiry) plus the mandatory `client=musicbrainz-mcp-<version>` param, and posts `Content-Type: application/xml; charset=utf-8`. It returns the **raw** response body — MusicBrainz answers writes with an XML `<message><text>OK</text></message>`, not JSON, so we never `JSON.parse` it.
- **Deferred-config-error pattern (OAuth only):** the constructor reads `MUSICBRAINZ_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`; if any is missing it stores a write-side `configError` instead of throwing. The server boots and serves `tools/list` regardless; the error only surfaces on the first write call. (Reads never have a config error.)

## Writes are confirm-gated

Every mutating tool takes `confirm` (`schemaConfirm`). Without `confirm: true` it makes **no** network call and returns a dry-run `preview` (including the exact XML for tags/ratings). With `confirm: true` it routes through `client.write`. See `docs/MUSICBRAINZ-API.md` for the pinned write shapes:
- tags/ratings: `POST /ws/2/tag` / `/ws/2/rating` with mmd-2.0 XML.
- collections: bodyless `PUT`/`DELETE /ws/2/collection/<mbid>/<entity-type>/<MBID>;<MBID>`.

> **Write path verified live.** The `tag` submission was confirmed end-to-end against the production API (`POST /ws/2/tag` → `200 {"message":"OK"}`, the tag appeared on an authenticated `inc=user-tags` re-read, and `withdraw` removed it). Ratings and collections share the same `client.write` auth path (bearer + `client=` param) and are unit-tested against the pinned shapes. The OAuth refresh-token exchange is also confirmed working.

## Environment

```
MUSICBRAINZ_USER_AGENT=...                 # optional UA override
MUSICBRAINZ_OAUTH_CLIENT_ID=...            # writes only
MUSICBRAINZ_OAUTH_CLIENT_SECRET=...        # writes only
MUSICBRAINZ_OAUTH_REFRESH_TOKEN=...        # writes only
```

Loaded via `dotenv` from `.env` next to `dist/` (guarded import; the mcpb bundle omits `dotenv` and the host provides env). `readEnvVar` treats blank, `"undefined"`, `"null"`, and unsubstituted `${FOO}` placeholders as unset.

## Testing

Tests live in `tests/` (vitest). No real network — `fetch` (in `client.test.ts`) and `client.get`/`client.coverArt`/`client.write` (in tool tests) are mocked. (The throttle itself is unit-tested upstream in `@chrischall/mcp-utils`.) `tests/server-boot.test.ts` spawns the real built artifacts (`dist/bundle.js` with no `node_modules`, and `dist/index.js`) and asserts the `initialize` + `tools/list` handshake.

## Versioning

Version lives in `src/version.ts` (`VERSION`, marked `// x-release-please-version`), mirrored into `package.json`, `manifest.json`, `server.json` (×2), and the two `.claude-plugin/*` manifests. **Don't hand-bump** — release-please owns it via `extra-files` in `release-please-config.json`. `versionSyncTest` fails the build if any marker drifts from `package.json`.

<!-- pr-workflow:v3 -->
## Pull requests & release notes

Fleet policy — Conventional-Commit PR titles, labels, the auto-review /
auto-merge ladder, auto-review follow-up issues, PR timing, and release PRs —
lives in `~/.claude/CLAUDE.md`. Don't restate it here; the copies drifted.

Shared technical conventions (publishing, bundling, versioning guards,
write-verification, transport archetypes, testing traps) live in
[`chrischall/workflows`](https://github.com/chrischall/workflows):
`docs/fleet-conventions.md`, plus `README.md` for the CI pipeline contract.

## Gotchas

- **ESM + NodeNext**: relative imports use `.js` extensions even from `.ts` source.
- **One throttle**: never call MusicBrainz outside `client` — you'd bypass the 1 req/s spacer.
- **Write responses are XML**, not JSON: `client.write` returns raw text.
- **Cover Art Archive is a separate host** (`coverartarchive.org`); 404 = no art (handled with a helpful error).
- **`/ws/2` GET responses are cached.** Right after a write, an authenticated `inc=user-tags`/`inc=user-ratings` re-read can serve a *stale cached body* (it looked like the write/withdraw hadn't applied when it had). Add a unique throwaway query param (e.g. `&_=<nonce>`) to bust the cache when verifying a write by re-reading. The read tools are unaffected — this only bites write-verification reads.
- **MBIDs are UUIDs**: `entities.ts` `MbidSchema` validates them; search returns MBIDs to feed into lookup.
- **stdio transport**: server logs to **stderr** only — stdout is reserved for JSON-RPC.
