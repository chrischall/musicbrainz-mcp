/**
 * `_meta.mint` hints (the mcp-host context-groups contract): which canonical
 * group a tool belongs to, what kind of ask it answers, and everyday words its
 * name and description lack. Inert data to any other client.
 *
 * MusicBrainz is a music encyclopedia: nothing in it is a person's news, due
 * date or schedule, so every read is a `lookup`, no tool is canonical, and no
 * argument takes a person's subject.
 */
const DOMAIN = 'family';

type Intent = 'lookup' | 'change';

export interface MintHint {
  domain: typeof DOMAIN;
  intent: Intent;
  aliases?: string[];
}

function meta(intent: Intent, aliases: string[]): { mint: MintHint } {
  return { mint: { domain: DOMAIN, intent, aliases } };
}

/** What people say when they ask about music. Lowercase, ≤ 8, each ≤ 40 chars. */
const MUSIC_ALIASES = ['album', 'artist', 'song', 'band', 'record', 'discography', 'track', 'record label'];

/** A read of the encyclopedia (search, lookup, browse, a pasted link). */
export const MUSIC_LOOKUP_META = meta('lookup', MUSIC_ALIASES);
/** The Cover Art Archive read. */
export const COVER_ART_META = meta('lookup', ['album art', 'cover', 'album cover', 'artwork']);
/** Writes to the person's own MusicBrainz account. */
export const RATING_META = meta('change', ['rate', 'rating', 'stars']);
export const TAGS_META = meta('change', ['tag', 'tags', 'genre']);
export const COLLECTION_META = meta('change', ['collection', 'my collection', 'add to collection']);
