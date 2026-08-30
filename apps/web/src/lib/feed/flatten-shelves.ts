import type { BookCard, Shelf } from "@pk-literature/domain-types";

// GET /feed/shelf/{id} pagination state for one shelf, carried forward
// as the reader scrolls past what GET /feed already delivered. `page`
// is the *next* page to fetch — GET /feed's own per-shelf payload is
// effectively "page 1" (api-feed truncates each shelf server-side to
// the same 20-item page size getShelf() defaults to), so continuation
// starts at page 2.
export interface ShelfCursor {
  shelfId: string;
  page: number;
  hasMore: boolean;
}

export interface FlattenedFeed {
  queue: BookCard[];
  cursors: ShelfCursor[];
}

// Turns GET /feed's shelves+items into one ordered stream for the
// /feed reels page, preserving shelf order (and therefore the
// editorial-precedence ordering SPEC-05 already encodes in that
// order). The backend only de-dupes *within* a single GET /feed
// response — a shelf's own later continuation page (fetched standalone
// by ReelsFeed) has no way to know what another shelf already showed —
// so every id seen, from the initial flatten onward, has to be tracked
// across the whole session; this returns the initial half of that (the
// per-shelf cursors), ReelsFeed owns the running id set from here.
export function flattenShelves(shelves: Shelf[]): FlattenedFeed {
  const seen = new Set<string>();
  const queue: BookCard[] = [];
  for (const shelf of shelves) {
    for (const book of shelf.items) {
      if (seen.has(book.id)) continue; // defensive - the initial response is already deduped server-side
      seen.add(book.id);
      queue.push(book);
    }
  }
  const cursors: ShelfCursor[] = shelves.map((shelf) => ({ shelfId: shelf.id, page: 2, hasMore: shelf.hasMore }));
  return { queue, cursors };
}
