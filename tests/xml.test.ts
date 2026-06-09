import { describe, it, expect } from 'vitest';
import { buildTagsXml, buildRatingXml, escapeXml } from '../src/xml.js';

describe('xml builders', () => {
  it('escapes XML metacharacters', () => {
    expect(escapeXml('rock & roll <"\'>')).toBe('rock &amp; roll &lt;&quot;&apos;&gt;');
  });

  it('builds a tag submission with vote + escaped names', () => {
    const xml = buildTagsXml('recording', 'MBID-1', ['punk', 'lo & fi'], 'upvote');
    expect(xml).toContain('xmlns="http://musicbrainz.org/ns/mmd-2.0#"');
    expect(xml).toContain('<recording-list><recording id="MBID-1">');
    expect(xml).toContain('<user-tag vote="upvote"><name>punk</name></user-tag>');
    expect(xml).toContain('<name>lo &amp; fi</name>');
    expect(xml).toContain('</user-tag-list></recording></recording-list>');
  });

  it('builds a withdraw vote', () => {
    expect(buildTagsXml('artist', 'A', ['x'], 'withdraw')).toContain('<user-tag vote="withdraw">');
  });

  it('handles hyphenated entity names (release-group)', () => {
    const xml = buildRatingXml('release-group', 'RG-1', 80);
    expect(xml).toContain('<release-group-list><release-group id="RG-1">');
    expect(xml).toContain('<user-rating>80</user-rating>');
    expect(xml).toContain('</release-group></release-group-list>');
  });

  it('builds a rating of 0 (removal)', () => {
    expect(buildRatingXml('recording', 'R', 0)).toContain('<user-rating>0</user-rating>');
  });
});
