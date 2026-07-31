import Image from "next/image";
import Link from "next/link";
import { serverFetch } from "@/lib/api/server-fetch";
import { getFeed } from "@/lib/api/feed";
import { BookCard } from "@/components/book-card";

// SPEC-05 Discovery Feed — editorial shelves + new arrivals (trending/
// personalized shelves are feature-flagged off server-side by default,
// apps/api-feed's own FEATURE_TRENDING_SHELF/FEATURE_PERSONALIZED_SHELVES).
export default async function HomePage() {
  const feed = await getFeedSafely();

  if (!feed || (feed.shelves.length === 0 && !feed.banner)) {
    return (
      <div className="py-24 text-center text-muted-foreground">
        Nothing to show right now — check back soon.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      {feed.banner && (
        <Link
          href={`/books/${feed.banner.bookId}`}
          className="relative block aspect-[16/7] w-full overflow-hidden rounded-lg bg-muted sm:aspect-[21/6]"
        >
          <Image
            src={feed.banner.image.url}
            alt={feed.banner.headline ?? ""}
            fill
            priority
            sizes="100vw"
            className="object-cover"
          />
          {feed.banner.headline && (
            <span className="absolute bottom-4 left-4 rounded-md bg-background/90 px-3 py-1.5 text-sm font-medium sm:text-base">
              {feed.banner.headline}
            </span>
          )}
        </Link>
      )}
      {feed.shelves.map((shelf) => (
        <section key={shelf.id} aria-labelledby={`shelf-${shelf.id}`}>
          <h2 id={`shelf-${shelf.id}`} className="mb-4 text-xl font-semibold">
            {shelf.name}
          </h2>
          <div className="flex gap-4 overflow-x-auto pb-2">
            {shelf.items.map((book) => (
              <BookCard key={book.id} book={book} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

async function getFeedSafely() {
  try {
    return await getFeed(serverFetch);
  } catch {
    return null;
  }
}
