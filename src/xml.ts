// Minimal builders for the MusicBrainz submission XML (mmd-2.0 namespace). These
// emit exactly the document shapes pinned in docs/MUSICBRAINZ-API.md. Tag/rating
// submissions are the only XML we ever produce; collection writes are bodyless.

const NS = 'http://musicbrainz.org/ns/mmd-2.0#';

/** XML-escape a text value for use in element content or an attribute. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export type TagVote = 'upvote' | 'downvote' | 'withdraw';

/**
 * Build the `<metadata>` body for a user-tag submission on one entity. Each tag
 * becomes a `<user-tag vote="…">` carrying the same vote.
 */
export function buildTagsXml(entity: string, mbid: string, tags: string[], vote: TagVote): string {
  const items = tags
    .map((t) => `<user-tag vote="${vote}"><name>${escapeXml(t)}</name></user-tag>`)
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<metadata xmlns="${NS}">` +
    `<${entity}-list><${entity} id="${escapeXml(mbid)}">` +
    `<user-tag-list>${items}</user-tag-list>` +
    `</${entity}></${entity}-list>` +
    `</metadata>`
  );
}

/**
 * Build the `<metadata>` body for a user-rating submission on one entity.
 * `rating` is 0–100; 0 removes the rating.
 */
export function buildRatingXml(entity: string, mbid: string, rating: number): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<metadata xmlns="${NS}">` +
    `<${entity}-list><${entity} id="${escapeXml(mbid)}">` +
    `<user-rating>${rating}</user-rating>` +
    `</${entity}></${entity}-list>` +
    `</metadata>`
  );
}
