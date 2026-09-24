# musicbrainz-mcp

[![CI](https://github.com/chrischall/musicbrainz-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/musicbrainz-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/musicbrainz-mcp)](https://www.npmjs.com/package/musicbrainz-mcp)
[![license](https://img.shields.io/npm/l/musicbrainz-mcp)](LICENSE)

An MCP server for [MusicBrainz](https://musicbrainz.org), the open music encyclopedia. It gives Claude live access to MusicBrainz metadata — artists, releases, recordings, labels, works, and more — plus Cover Art Archive images, and (optionally) lets you submit your own tags, ratings, and collection edits.

> Developed and maintained by AI (Claude Code). Use at your own discretion.

## Tools

**Read (no credentials required):**

| Tool | What it does |
| --- | --- |
| `musicbrainz_search` | Search any entity type with a Lucene query; returns ranked matches + MBIDs |
| `musicbrainz_lookup` | Look up an entity by MBID, with `inc` subqueries for linked data |
| `musicbrainz_browse` | List all entities linked to another (e.g. every release by an artist) |
| `musicbrainz_cover_art` | Cover Art Archive image URLs for a release / release-group |
| `musicbrainz_resolve` | Turn a pasted musicbrainz.org URL into its entity |
| `musicbrainz_healthcheck` | Verify connectivity and whether OAuth writes are configured |

**Write (OAuth, confirmed before sending):**

| Tool | What it does |
| --- | --- |
| `musicbrainz_submit_tags` | Apply user tags to an entity on your account |
| `musicbrainz_submit_rating` | Set your 0–100 rating for an entity |
| `musicbrainz_modify_collection` | Add/remove entities in one of your collections |

Each write asks you to confirm before it makes any network call — see [Confirmations](#confirmations).

Every read above takes a `view`, except `musicbrainz_cover_art`. It defaults to
`compact`, which strips image and avatar URLs — a subtractive rule, so it cannot
drop a field nobody knew was there; `view: "full"` returns MusicBrainz's payload
untouched. `musicbrainz_cover_art` takes none on purpose: the image URLs *are*
its answer, and stripping them would not shrink the response, it would empty it.

## Install

This is a Node MCP server (stdio). Point your MCP host at it:

```json
{
  "mcpServers": {
    "musicbrainz": {
      "command": "npx",
      "args": ["-y", "musicbrainz-mcp"]
    }
  }
}
```

Reads work immediately. MusicBrainz asks clients to make **at most one request per second** — the server throttles itself to stay within that limit, so large browses are paced automatically.

## Enabling the write tools (optional)

1. Register an application at [musicbrainz.org/account/applications](https://musicbrainz.org/account/applications) (redirect URI `urn:ietf:wg:oauth:2.0:oob`).
2. Complete the OAuth flow with the `tag`, `rating`, and `collection` scopes to obtain a **refresh token**.
3. Provide these via your MCP host's env (or a local `.env`):

```
MUSICBRAINZ_OAUTH_CLIENT_ID=...
MUSICBRAINZ_OAUTH_CLIENT_SECRET=...
MUSICBRAINZ_OAUTH_REFRESH_TOKEN=...
```

## Confirmations

Every write asks you first. A client that can show a confirmation prompt (Claude Code) shows one, with the entity, tags / rating / collection change. A client that cannot (claude.ai, Claude Desktop) gets a two-step flow instead: the first call sends nothing and returns a `confirmation-required` preview — the exact XML for tags and ratings, the method and path for collections — plus a `confirmToken`; only a repeat of the same call with that token submits. A token acts once, and changing any argument between the two calls invalidates it.

| variable | default | |
|---|---|---|
| `MCP_CONFIRM_MODE` | `ask-user` | What a write does on a client that cannot show a confirmation prompt (claude.ai, Claude Desktop). `ask-user`: two steps — the first call does nothing and returns a preview plus a token, and the model must get your approval in chat before calling again with it. `auto`: the same two steps, but the model may use the token after reviewing the preview itself. `refuse`: writes are refused on such clients. A client that can show prompts (Claude Code) always gets the real prompt. An unrecognised value is treated as `refuse`. |
| `MCP_CONFIRM_TTL_SECONDS` | `600` | How long a token stays valid. |
| `MCP_CONFIRM_SECRET` | random per process | Signing key; set it only if tokens must survive a server restart. |

## Development

```bash
npm install
npm run build
npm test
```

See [CLAUDE.md](CLAUDE.md) for architecture and [docs/MUSICBRAINZ-API.md](docs/MUSICBRAINZ-API.md) for the pinned API shapes.

## License

MIT. Data from MusicBrainz, licensed under [CC0 / CC BY-NC-SA](https://musicbrainz.org/doc/About/Data_License).
