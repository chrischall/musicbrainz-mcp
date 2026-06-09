import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, messageOf } from '@chrischall/mcp-utils';
import { client } from '../client.js';

// A stable, always-present special-purpose entity ("Various Artists") — looking
// it up proves connectivity and that our User-Agent is accepted, with no auth.
const VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377';

export function registerUtilityTools(server: McpServer): void {
  server.registerTool(
    'musicbrainz_healthcheck',
    {
      title: 'Verify MusicBrainz connectivity',
      description:
        'Confirm the MusicBrainz API is reachable (and our User-Agent accepted) by looking up a stable entity, and ' +
        'report whether the OAuth write path is configured. Reports {ok, reachable, oauth_configured} with a plain-English hint. Read-only.',
      annotations: toolAnnotations({
        title: 'Verify MusicBrainz connectivity',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {},
    },
    async () => {
      const oauthConfigured = client.oauthConfigured;
      try {
        await client.get(`/artist/${VARIOUS_ARTISTS_MBID}`);
        return textResult({
          ok: true,
          reachable: true,
          oauth_configured: oauthConfigured,
          hint: oauthConfigured
            ? 'MusicBrainz is reachable and OAuth is configured — read and write tools are available.'
            : 'MusicBrainz is reachable. Read tools work; the write tools (tags, ratings, collections) need OAuth — set MUSICBRAINZ_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN.',
        });
      } catch (e) {
        return textResult({
          ok: false,
          reachable: false,
          oauth_configured: oauthConfigured,
          error: messageOf(e),
          hint: 'The MusicBrainz API call failed — it may be rate-limited (max 1 req/s) or temporarily unavailable. Retry shortly.',
        });
      }
    },
  );
}
