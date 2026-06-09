#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { registerLookupTools } from './tools/lookup.js';
import { registerSearchTools } from './tools/search.js';
import { registerBrowseTools } from './tools/browse.js';
import { registerCoverArtTools } from './tools/coverart.js';
import { registerResolveTools } from './tools/resolve.js';
import { registerUtilityTools } from './tools/utilities.js';
import { registerTagTools } from './tools/tags.js';
import { registerRatingTools } from './tools/ratings.js';
import { registerCollectionTools } from './tools/collections.js';

// The MusicBrainz client is a module-level singleton (imported by each tool
// module) that defers its OAuth config error to the first write. Reads need no
// credentials, so the server boots and answers the host's install-time
// tools/list smoke test regardless of whether OAuth is configured.
await runMcp({
  name: 'musicbrainz-mcp',
  version: VERSION,
  banner:
    '[musicbrainz-mcp] This project was developed and is maintained by AI (Claude Opus 4.8). Use at your own discretion.',
  tools: [
    registerLookupTools,
    registerSearchTools,
    registerBrowseTools,
    registerCoverArtTools,
    registerResolveTools,
    registerUtilityTools,
    registerTagTools,
    registerRatingTools,
    registerCollectionTools,
  ],
});
