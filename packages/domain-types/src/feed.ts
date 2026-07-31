import { z } from "zod";
import { MediaAssetSchema } from "./media-asset";

// SPEC-05 "Book Card" — deliberately not the full catalog Book shape
// (book.ts): a shelf card only ever needs enough to render a card and
// link through to the book, not contributors/collections/inventory
// detail. `bestseller`/`award` chips from the spec aren't included —
// there's no bestseller/award signal tracked anywhere in the catalog
// schema yet (nothing to derive them from); `theme` and `new` chips
// are, and are included.
export const BookCardSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  authorName: z.string().nullable(),
  publisherName: z.string(),
  cover: MediaAssetSchema.nullable(),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  chips: z.object({
    theme: z.string().nullable(),
    isNew: z.boolean(),
  }),
});
export type BookCard = z.infer<typeof BookCardSchema>;

export const ShelfTypeSchema = z.enum([
  "editorial",
  "new_arrivals",
  "trending",
  "personalized_similar",
  "recently_viewed",
]);
export type ShelfType = z.infer<typeof ShelfTypeSchema>;

// A shelf as returned in GET /feed — SPEC-05 "Shelf Rules": 5-20 items,
// independently ranked. `hasMore` tells the client whether
// GET /feed/shelf/{id} has additional pages to fetch for infinite
// horizontal scroll.
export const ShelfSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  type: ShelfTypeSchema,
  items: z.array(BookCardSchema),
  hasMore: z.boolean(),
});
export type Shelf = z.infer<typeof ShelfSchema>;

// Homepage promotional banner — a single editorially-curated image
// linking to one book (discovery.banners, Directus-authored). Deliberately
// minimal: one active banner at a time, no scheduling/carousel: the
// customer-facing UI gap this closes was scoped down to exactly that.
export const BannerSchema = z.object({
  id: z.string().uuid(),
  image: MediaAssetSchema,
  headline: z.string().nullable(),
  bookId: z.string().uuid(),
});
export type Banner = z.infer<typeof BannerSchema>;

export const FeedResponseSchema = z.object({
  shelves: z.array(ShelfSchema),
  banner: BannerSchema.nullable(),
});
export type FeedResponse = z.infer<typeof FeedResponseSchema>;
