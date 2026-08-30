"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { BookCard, Shelf } from "@pk-literature/domain-types";
import { clientFetch } from "@/lib/api/client-fetch";
import { getShelf } from "@/lib/api/feed";
import { flattenShelves, type ShelfCursor } from "@/lib/feed/flatten-shelves";
import { ReelBookSlide } from "./reel-book-slide";

// How many slides before the end of what's loaded to trigger a
// background fetch for more - far enough that the next page has time
// to arrive before the reader actually gets there.
const LOOKAHEAD = 3;

// The reels-style entry point for the Discovery Feed (SPEC-05) -
// `fixed inset-0` deliberately escapes app/layout.tsx's shared
// `<main className="mx-auto max-w-6xl px-4 py-8">` wrapper (a nested
// layout can't undo an ancestor's own element), which is also why the
// site header/footer end up visually covered while /feed is open -
// the back arrow below is this page's only way out, by design, the
// same "no persistent chrome" trade every reels-style feed makes.
export function ReelsFeed({ shelves }: { shelves: Shelf[] }) {
  const initial = useRef(flattenShelves(shelves)).current;
  const [queue, setQueue] = useState<BookCard[]>(initial.queue);
  const [exhausted, setExhausted] = useState(initial.cursors.every((cursor) => !cursor.hasMore));
  const [loadingMore, setLoadingMore] = useState(false);

  // Mutable bookkeeping that fetchMore() needs to read/write without
  // triggering its own re-renders or going stale inside a closure -
  // React state is only used for what actually needs to repaint.
  const cursorsRef = useRef<ShelfCursor[]>(initial.cursors);
  const cursorIndexRef = useRef(0);
  const seenIdsRef = useRef(new Set(initial.queue.map((book) => book.id)));
  const loadingRef = useRef(false);
  const exhaustedRef = useRef(exhausted);
  const slideEls = useRef(new Map<number, HTMLDivElement>()).current;

  useEffect(() => {
    exhaustedRef.current = exhausted;
  }, [exhausted]);

  async function fetchMore(signal: AbortSignal) {
    if (loadingRef.current || exhaustedRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    try {
      let idx = cursorIndexRef.current;
      let appended: BookCard[] = [];
      // Walk forward through shelves (in their original, editorially-
      // ranked order) until one actually yields new books, or none are
      // left - a shelf that's already exhausted (hasMore: false) is
      // skipped in the same pass rather than waiting for another
      // scroll-triggered call.
      while (idx < cursorsRef.current.length) {
        const cursor = cursorsRef.current[idx]!;
        if (!cursor.hasMore) {
          idx++;
          continue;
        }
        const page = await getShelf(clientFetch, cursor.shelfId, cursor.page);
        if (signal.aborted) return;
        const fresh = page.items.filter((book) => !seenIdsRef.current.has(book.id));
        fresh.forEach((book) => seenIdsRef.current.add(book.id));
        cursorsRef.current[idx] = { ...cursor, page: cursor.page + 1, hasMore: page.hasMore };
        appended = appended.concat(fresh);
        if (!page.hasMore) {
          idx++;
          continue;
        }
        break;
      }
      cursorIndexRef.current = idx;
      if (appended.length > 0) {
        setQueue((current) => [...current, ...appended]);
      }
      if (idx >= cursorsRef.current.length) {
        setExhausted(true);
      }
    } catch {
      // Left as-is - the sentinel re-observes and retries next time it
      // re-enters view (e.g. the reader scrolls back up and down).
    } finally {
      if (!signal.aborted) {
        loadingRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    if (exhausted) return;
    const targetIndex = Math.max(0, queue.length - 1 - LOOKAHEAD);
    const target = slideEls.get(targetIndex);
    if (!target) return;

    const controller = new AbortController();
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          fetchMore(controller.signal);
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(target);
    return () => {
      observer.disconnect();
      controller.abort();
    };
    // fetchMore intentionally isn't a dependency here - it reads all
    // its mutable state from refs (cursorsRef, seenIdsRef, etc.), never
    // from this closure, so it's safe to omit without going stale.
  }, [queue.length, exhausted]);

  return (
    // bg-muted is the "letterbox" fill either side of the centered
    // column at sm: and up - phone-width content stays full-bleed
    // below that, matching how a real phone has no letterboxing to
    // show in the first place; the column itself (not this outer div)
    // is what caps at max-w-sm and gets the border, so the back button
    // below can anchor to *its* corner, not the full viewport's.
    <div className="fixed inset-0 z-40 bg-muted">
      <div className="relative mx-auto h-full w-full overflow-y-auto snap-y snap-mandatory bg-background sm:max-w-sm sm:border-x sm:border-border">
        <Link
          href="/"
          aria-label="Back to home"
          className="absolute left-4 top-4 z-50 flex h-9 w-9 items-center justify-center rounded-full bg-background/85 text-foreground shadow-md backdrop-blur"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>

        {queue.map((book, index) => (
          <div
            key={book.id}
            ref={(el) => {
              if (el) slideEls.set(index, el);
              else slideEls.delete(index);
            }}
            className="h-dvh snap-start snap-always"
          >
            <ReelBookSlide book={book} />
          </div>
        ))}

        {loadingMore && (
          <div className="flex h-dvh snap-start items-center justify-center" aria-hidden="true">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          </div>
        )}

        {exhausted && !loadingMore && (
          <div className="flex h-dvh snap-start flex-col items-center justify-center gap-4 px-8 text-center">
            <p className="text-lg font-semibold">You&rsquo;ve reached the end</p>
            <p className="text-sm text-muted-foreground">Explore the full catalogue for more.</p>
            <Link href="/browse" className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground">
              Browse all books
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
