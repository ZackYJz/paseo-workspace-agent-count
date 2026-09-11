export interface Page<T> {
  entries: T[];
  pageInfo: { nextCursor?: string | null; hasMore: boolean };
}

/**
 * Walks every page of a directory listing.
 *
 * A missing cursor or a repeated one means the listing cannot be trusted, so it
 * throws instead of returning a partial result that callers would read as a
 * complete count.
 */
export async function allPages<T>(fetchPage: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const entries: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    entries.push(...page.entries);
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (page.pageInfo.hasMore && !cursor) throw new Error("Incomplete pagination: missing cursor");
    if (cursor && cursors.has(cursor)) throw new Error("Repeated pagination cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return entries;
}
