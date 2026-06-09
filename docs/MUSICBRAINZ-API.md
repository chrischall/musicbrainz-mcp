# MusicBrainz API — verified request/response shapes

Pinned from the official docs (verified 2026-06-09). The MCP is coded against
these shapes; re-verify against a real call before changing any of them.

## Read web service — `https://musicbrainz.org/ws/2/`

- **JSON:** append `fmt=json` (takes precedence over the `Accept` header).
- **User-Agent (required):** a meaningful UA or the server may block you, e.g.
  `musicbrainz-mcp/<version> ( https://github.com/chrischall/musicbrainz-mcp )`.
- **Rate limit:** at most **1 request/second** per source. Exceeding it →
  **HTTP 503 Service Unavailable** ("processing stops"); persistent abuse can get
  the IP blocked. We throttle proactively to ~1 req/s and treat 503 as retryable
  (honoring `Retry-After` when present).

### Lookup — `GET /<entity>/<mbid>?inc=<a>+<b>&fmt=json`
- `inc` subqueries are `+`-joined, e.g. `inc=recordings+release-groups`.
- 13 core entities: `area artist event genre instrument label place recording
  release release-group series work url`.
- Lookup-only resources (different path shape, not yet exposed): `discid`,
  `isrc`, `iswc`.

### Search — `GET /<entity>?query=<lucene>&limit=<1-100>&offset=<n>&fmt=json`
- `query` is a Lucene query string (see /doc/MusicBrainz_API/Search).
- `limit` default 25, max 100.

### Browse — `GET /<result-entity>?<link-entity>=<mbid>&inc=<…>&limit=&offset=&fmt=json`
- e.g. `GET /release?artist=<mbid>&inc=labels&limit=100`.
- `limit` default 25, max 100.

## Cover Art Archive — `https://coverartarchive.org/`
- `GET /release/<mbid>` and `GET /release-group/<mbid>` → JSON `{ images: [...] }`
  with `image`, `thumbnails`, `front`, `back`, `types`. 404 when no art exists.

## Write web service (OAuth2 Bearer)

OAuth2: authorize `https://musicbrainz.org/oauth2/authorize`, token
`https://musicbrainz.org/oauth2/token`. Grants: `authorization_code`,
`refresh_token`. Desktop/console redirect URI: `urn:ietf:wg:oauth:2.0:oob`.
Scopes: `profile email tag rating collection submit_isrc submit_barcode`.
Token request params: `grant_type, refresh_token, client_id, client_secret`.

All writes require the `client=<appname>-<version>` query param and
`Content-Type: application/xml; charset=utf-8` (collection PUT/DELETE need no body).

### Tags — `POST /ws/2/tag?client=musicbrainz-mcp-<v>`
XML, mmd-2.0 namespace; `<user-tag>` may carry `vote="upvote|downvote|withdraw"`:
```xml
<metadata xmlns="http://musicbrainz.org/ns/mmd-2.0#">
  <recording-list>
    <recording id="MBID">
      <user-tag-list>
        <user-tag vote="upvote"><name>punk</name></user-tag>
      </user-tag-list>
    </recording>
  </recording-list>
</metadata>
```

### Ratings — `POST /ws/2/rating?client=musicbrainz-mcp-<v>`
XML; `<user-rating>` is 0–100 (0 removes the rating):
```xml
<metadata xmlns="http://musicbrainz.org/ns/mmd-2.0#">
  <recording-list>
    <recording id="MBID"><user-rating>100</user-rating></recording>
  </recording-list>
</metadata>
```

### Collections — no body
- Add: `PUT /ws/2/collection/<collection-mbid>/<entity-type>/<MBID>;<MBID>?client=…`
- Remove: `DELETE /ws/2/collection/<collection-mbid>/<entity-type>/<MBID>;<MBID>?client=…`
- Entity-type is plural: `releases areas artists events labels places recordings
  release-groups works`.

> A 200 is not proof a write persisted — verify by re-reading. Collection writes
> are verified by re-GETting membership; tag/rating writes apply synchronously
> and can be re-read with a bearer `inc=user-tags`/`inc=user-ratings` lookup.
