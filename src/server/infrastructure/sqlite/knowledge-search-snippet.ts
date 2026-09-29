/** Keep search excerpts aligned with SQLite's NFC plus lowercase literal match. */
export function searchExcerpt(body: string, query: string): { excerpt: string; matchedBody: boolean } {
  const characters = Array.from(body);
  const starts: number[] = [];
  const ends: number[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const part of segmenter.segment(body)) {
    const normalized = part.segment.normalize("NFC").toLowerCase();
    for (let index = 0; index < normalized.length; index += 1) {
      starts.push(part.index);
      ends.push(part.index + part.segment.length);
    }
  }
  // Lowercasing the whole string preserves contextual mappings such as Greek
  // final sigma; segment folds above only map code-unit lengths to source spans.
  const folded = body.normalize("NFC").toLowerCase();
  const needle = query.normalize("NFC").toLowerCase();
  const match = needle && starts.length === folded.length ? folded.indexOf(needle) : -1;
  const codePointStart = match < 0 ? 0 : Array.from(body.slice(0, starts[match]!)).length;
  const codePointEnd = match < 0 ? 0 : Array.from(body.slice(0, ends[match + needle.length - 1]!)).length;
  const start = Math.max(0, Math.min(codePointStart - 65, characters.length - 180));
  const end = Math.min(characters.length, Math.max(start + 180, codePointEnd + 65));
  const excerpt = `${start ? "…" : ""}${characters.slice(start, end).join("").replace(/\s+/gu, " ").trim()}${end < characters.length ? "…" : ""}`;
  return { excerpt, matchedBody: match >= 0 };
}
