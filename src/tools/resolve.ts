import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, createHelpfulError } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { CORE_ENTITIES } from '../entities.js';
import { ATTRIBUTION_NOTE } from '../attribution.js';

const ENTITY_ALT = CORE_ENTITIES.join('|');
// Match a musicbrainz.org entity URL (or a bare "entity/mbid" path) and capture
// the entity type + MBID.
const URL_RE = new RegExp(`(?:^|/)(${ENTITY_ALT})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`, 'i');

/** Parse a MusicBrainz entity URL/path into its entity type and MBID. */
export function parseMusicBrainzUrl(input: string): { entity: string; mbid: string } | null {
  const m = URL_RE.exec(input.trim());
  if (!m) return null;
  return { entity: m[1].toLowerCase(), mbid: m[2].toLowerCase() };
}

export function registerResolveTools(server: McpServer): void {
  server.registerTool(
    'musicbrainz_resolve',
    {
      title: 'Resolve a MusicBrainz URL to its entity',
      description:
        'Turn a musicbrainz.org URL (e.g. https://musicbrainz.org/artist/<mbid> or /release-group/<mbid>) into the ' +
        'underlying entity by extracting its type + MBID and looking it up. Handy when a user pastes a MusicBrainz link. ' +
        'Pass `inc` to include linked sub-entities. Read-only.' +
        ATTRIBUTION_NOTE,
      annotations: toolAnnotations({
        title: 'Resolve a MusicBrainz URL to its entity',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        url: z.string().min(1).describe('A musicbrainz.org entity URL or an "entity/mbid" path'),
        inc: z.array(z.string()).optional().describe('Subqueries to include on the resolved entity'),
      },
    },
    async ({ url, inc }) => {
      const parsed = parseMusicBrainzUrl(url);
      if (!parsed) {
        throw createHelpfulError(`Could not find a MusicBrainz entity URL in "${url}".`, {
          hint: 'Expected something like https://musicbrainz.org/artist/<mbid> with one of: ' + CORE_ENTITIES.join(', '),
        });
      }
      const query = inc && inc.length > 0 ? { inc: inc.join('+') } : {};
      const data = await client.get(`/${parsed.entity}/${parsed.mbid}`, query);
      return textResult({ entity: parsed.entity, mbid: parsed.mbid, data });
    },
  );
}
