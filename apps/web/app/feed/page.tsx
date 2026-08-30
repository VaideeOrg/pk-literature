import { serverFetch } from "@/lib/api/server-fetch";
import { getFeed } from "@/lib/api/feed";
import { ReelsFeed } from "@/components/reels-feed";

// /feed - the reels-style entry point for the Discovery Feed (SPEC-05),
// alongside the horizontal-shelf homepage (app/page.tsx), which is
// untouched. Same underlying GET /feed call; ReelsFeed flattens the
// returned shelves into one continuous vertical stream client-side and
// prefetches further pages per shelf (GET /feed/shelf/{id}) as the
// reader nears the end of what's loaded.
export default async function FeedPage() {
  const feed = await getFeedSafely();
  const hasItems = feed?.shelves.some((shelf) => shelf.items.length > 0) ?? false;

  if (!feed || !hasItems) {
    return (
      <div className="flex h-dvh items-center justify-center text-center text-muted-foreground">
        Nothing to show right now — check back soon.
      </div>
    );
  }

  return <ReelsFeed shelves={feed.shelves} />;
}

async function getFeedSafely() {
  try {
    return await getFeed(serverFetch);
  } catch {
    return null;
  }
}
