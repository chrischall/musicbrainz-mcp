# Changelog

## [0.2.5](https://github.com/chrischall/musicbrainz-mcp/compare/v0.2.4...v0.2.5) (2026-07-19)


### Documentation

* replace duplicated fleet policy with a pointer ([#38](https://github.com/chrischall/musicbrainz-mcp/issues/38)) ([16519d9](https://github.com/chrischall/musicbrainz-mcp/commit/16519d9b897686a18554526619303d7c2b598629))

## [0.2.4](https://github.com/chrischall/musicbrainz-mcp/compare/v0.2.3...v0.2.4) (2026-07-13)


### Bug Fixes

* **plugin:** move SKILL.md into skills/ directory so plugin skills load ([#32](https://github.com/chrischall/musicbrainz-mcp/issues/32)) ([4c847da](https://github.com/chrischall/musicbrainz-mcp/commit/4c847da05195ad5257b58f3db881628bd09ec21b))
* **plugin:** stage root SKILL.md for mcp-publish and ignore it in mcpb pack ([#34](https://github.com/chrischall/musicbrainz-mcp/issues/34)) ([806bb9e](https://github.com/chrischall/musicbrainz-mcp/commit/806bb9ea5bd84c694cdaac5cb7f1b37d5c3490df))

## [0.2.3](https://github.com/chrischall/musicbrainz-mcp/compare/v0.2.2...v0.2.3) (2026-07-07)


### Bug Fixes

* bump @chrischall/mcp-utils to 0.12.0 ([#29](https://github.com/chrischall/musicbrainz-mcp/issues/29)) ([f3e2f9f](https://github.com/chrischall/musicbrainz-mcp/commit/f3e2f9f979c4c58e58f48ac89a23277901d13a40))
* cap honored Retry-After delay to bound throttle stalls ([#24](https://github.com/chrischall/musicbrainz-mcp/issues/24)) ([8998aa2](https://github.com/chrischall/musicbrainz-mcp/commit/8998aa2b87b4669eb7f9d62cf04a4de0906c7f48))


### Refactor

* adopt mcp-utils createCachedTokenSource for the OAuth write path ([#26](https://github.com/chrischall/musicbrainz-mcp/issues/26)) ([6ddbbf1](https://github.com/chrischall/musicbrainz-mcp/commit/6ddbbf1ed0485187d05117357db91bdf9ee56820))


### Documentation

* document first-party dependency-bump label exception ([#30](https://github.com/chrischall/musicbrainz-mcp/issues/30)) ([bfae517](https://github.com/chrischall/musicbrainz-mcp/commit/bfae517801f852105f5930e19fda0ee4385886af))

## [0.2.2](https://github.com/chrischall/musicbrainz-mcp/compare/v0.2.1...v0.2.2) (2026-06-15)


### Documentation

* add auto-review follow-up convention to CLAUDE.md ([#16](https://github.com/chrischall/musicbrainz-mcp/issues/16)) ([564fffb](https://github.com/chrischall/musicbrainz-mcp/commit/564fffb3eb89f289af92a3b0f7fe93d66a540ccd))
* require Conventional Commit PR titles for release-please ([#14](https://github.com/chrischall/musicbrainz-mcp/issues/14)) ([efb1740](https://github.com/chrischall/musicbrainz-mcp/commit/efb17404be8841dc228d71b706adf44f50b76d98))

## [0.2.1](https://github.com/chrischall/musicbrainz-mcp/compare/v0.2.0...v0.2.1) (2026-06-13)


### Documentation

* add MIT LICENSE file and README badges ([#6](https://github.com/chrischall/musicbrainz-mcp/issues/6)) ([a374937](https://github.com/chrischall/musicbrainz-mcp/commit/a374937d792b1868a3565e3d0eb997d81bc7f296))
* drop duplicated CI badge line ([#8](https://github.com/chrischall/musicbrainz-mcp/issues/8)) ([db2f114](https://github.com/chrischall/musicbrainz-mcp/commit/db2f114bc9e5553da5b2973142b119d4721da6f6))

## [0.2.0](https://github.com/chrischall/musicbrainz-mcp/compare/v0.1.0...v0.2.0) (2026-06-09)


### Features

* MusicBrainz MCP server with read + OAuth write tools ([687aee6](https://github.com/chrischall/musicbrainz-mcp/commit/687aee621a0f817f136542b1524ac164f6df1775))


### Documentation

* mark write path live-verified and note ws/2 read caching ([#3](https://github.com/chrischall/musicbrainz-mcp/issues/3)) ([9076890](https://github.com/chrischall/musicbrainz-mcp/commit/907689099d7631ebf6645bd998347e39204f37dd))
