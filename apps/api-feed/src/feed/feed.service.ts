import { Inject, Injectable } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import type { Banner, Shelf } from "@pk-literature/domain-types";
import { KYSELY } from "../database/database.module";
import type { Database, ShelfType } from "../database/database.types";
import { BookCardBuilder } from "./book-card-builder";
import { toMediaAsset } from "../common/media-url";
import { NotFoundProblem } from "../common/problem-details.exception";

// SPEC-05 "Shelf Rules": 5-20 items. Used both as the default page
// size for a shelf embedded in GET /feed and as the page size for
// GET /feed/shelf/{id}'s continuation.
const SHELF_PAGE_SIZE = 20;
// SPEC-05 "Trending": a rolling window, not all-time — otherwise an
// early bestseller would dominate the shelf forever.
const TRENDING_WINDOW_DAYS = 30;

interface ShelfDescriptor {
  id: string;
  name: string;
  slug: string;
  type: ShelfType;
  collectionId: string | null;
}

// No jest unit test for this service — same reasoning as
// apps/api-publisher-import/src/staging-books/staging-books.service.ts:
// the interesting behavior here (the pg_trgm-free but still
// multi-table raw `sql` trending/personalized-similar queries, the
// cross-shelf dedup, the editorial-shelf/feed_shelves join, hasMore's
// one-extra-row trick) lives in write/read paths a shallow Kysely mock
// can't meaningfully exercise. Validated for real against local
// Postgres with seeded test authors/works/books/a collection: New
// Arrivals correctly ordered newest-first with NULLs last; an
// editorial shelf correctly sourced from its linked collection;
// liking a book correctly surfaced it (and books sharing its
// author/theme) on the personalized-similar shelf, and reversing that
// like correctly made the shelf disappear again; the trending shelf
// correctly reflected a like within the rolling window; cross-shelf
// dedup correctly excluded already-shown books from later shelves
// (confirmed by seeing New Arrivals — sort_order 0 — consume every
// published book in the small test dataset, leaving nothing for the
// shelves after it, exactly as the dedup is supposed to do); and
// GET /feed/shelf/{id}'s pagination correctly split results across
// two one-item pages with hasMore flipping to false on the last one.
@Injectable()
export class FeedService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly cardBuilder: BookCardBuilder,
  ) {}

  async getFeed(anonymousId: string | null): Promise<{ shelves: Shelf[]; banner: Banner | null }> {
    const descriptors = await this.candidateShelves(anonymousId);
    const seen = new Set<string>();
    const shelves: Shelf[] = [];

    for (const descriptor of descriptors) {
      const { bookIds, hasMore } = await this.bookIdsForShelf(descriptor, anonymousId, {
        limit: SHELF_PAGE_SIZE,
        offset: 0,
        exclude: seen,
      });
      // SPEC-05 Business Rules: "Duplicate books should be minimized
      // across shelves" — an empty-after-de-dup shelf is dropped
      // rather than shown blank (also covers "Shelf Rules: 5-20 items").
      if (bookIds.length === 0) continue;

      for (const id of bookIds) seen.add(id);
      const items = await this.cardBuilder.build(bookIds);
      shelves.push({ id: descriptor.id, name: descriptor.name, slug: descriptor.slug, type: descriptor.type, items, hasMore });
    }

    const banner = await this.activeBanner();
    return { shelves, banner };
  }

  /**
   * Directus-authored, discovery.banners (20260201000006_banners.sql).
   * Only the highest-sort_order enabled row whose linked book is still
   * published — a banner pointing at an unpublished/removed book is
   * treated as no banner rather than surfaced broken.
   */
  private async activeBanner(): Promise<Banner | null> {
    const row = await this.db
      .selectFrom("discovery.banners")
      .innerJoin("catalog.books", "catalog.books.id", "discovery.banners.bookId")
      .innerJoin("catalog.mediaAssets", "catalog.mediaAssets.id", "discovery.banners.imageAssetId")
      .select([
        "discovery.banners.id",
        "discovery.banners.headline",
        "discovery.banners.bookId",
        "catalog.mediaAssets.id as imageId",
        "catalog.mediaAssets.assetType as imageAssetType",
        "catalog.mediaAssets.s3Key as imageS3Key",
        "catalog.mediaAssets.widthPx as imageWidthPx",
        "catalog.mediaAssets.heightPx as imageHeightPx",
      ])
      .where("discovery.banners.enabled", "=", true)
      .where("catalog.books.status", "=", "published")
      .orderBy("discovery.banners.sortOrder")
      .limit(1)
      .executeTakeFirst();

    if (!row) return null;

    return {
      id: row.id,
      headline: row.headline,
      bookId: row.bookId,
      image: toMediaAsset({
        id: row.imageId,
        assetType: row.imageAssetType,
        s3Key: row.imageS3Key,
        widthPx: row.imageWidthPx,
        heightPx: row.imageHeightPx,
      })!,
    };
  }

  async getShelfPage(
    shelfId: string,
    anonymousId: string | null,
    limit: number,
    offset: number,
  ): Promise<{ items: Awaited<ReturnType<BookCardBuilder["build"]>>; hasMore: boolean }> {
    const descriptor = await this.shelfById(shelfId);
    if (!descriptor) throw new NotFoundProblem("Shelf", shelfId);

    const { bookIds, hasMore } = await this.bookIdsForShelf(descriptor, anonymousId, {
      limit,
      offset,
      exclude: new Set(),
    });

    return { items: await this.cardBuilder.build(bookIds), hasMore };
  }

  private async shelfById(id: string): Promise<ShelfDescriptor | null> {
    const row = await this.db
      .selectFrom("discovery.feedShelves")
      .select(["id", "name", "slug", "type", "collectionId"])
      .where("id", "=", id)
      .where("enabled", "=", true)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Editorial + seeded shelves (discovery.feed_shelves) in configured
   * order, plus feature-flagged synthetic shelves that have no backing
   * row at all — see feed_shelves' own seed migration for why
   * trending/personalized_similar aren't stored rows.
   */
  private async candidateShelves(anonymousId: string | null): Promise<ShelfDescriptor[]> {
    const stored = await this.db
      .selectFrom("discovery.feedShelves")
      .select(["id", "name", "slug", "type", "collectionId"])
      .where("enabled", "=", true)
      .orderBy("sortOrder")
      .execute();

    const descriptors: ShelfDescriptor[] = [...stored];

    if (process.env.FEATURE_TRENDING_SHELF === "true") {
      descriptors.push({ id: "trending", name: "Trending", slug: "trending", type: "trending", collectionId: null });
    }

    if (process.env.FEATURE_PERSONALIZED_SHELVES === "true" && anonymousId) {
      const hasLikes = await this.hasAnyLike(anonymousId);
      if (hasLikes) {
        descriptors.push({
          id: "personalized-similar",
          name: "Similar to Books You Liked",
          slug: "similar-to-books-you-liked",
          type: "personalized_similar",
          collectionId: null,
        });
      }
    }

    return descriptors;
  }

  private async hasAnyLike(anonymousId: string): Promise<boolean> {
    const likedIds = await this.likedBookIds(anonymousId);
    return likedIds.length > 0;
  }

  /** Book ids currently liked (most recent action per book is 'like') — SPEC-05: "Likes are reversible." */
  private async likedBookIds(anonymousId: string): Promise<string[]> {
    const result = await sql<{ bookId: string; action: string }>`
      SELECT DISTINCT ON (book_id) book_id as "bookId", action
      FROM discovery.interest_events
      WHERE anonymous_id = ${anonymousId}
      ORDER BY book_id, created_at DESC
    `.execute(this.db);
    return result.rows.filter((r) => r.action === "like").map((r) => r.bookId);
  }

  private async bookIdsForShelf(
    descriptor: ShelfDescriptor,
    anonymousId: string | null,
    opts: { limit: number; offset: number; exclude: Set<string> },
  ): Promise<{ bookIds: string[]; hasMore: boolean }> {
    const exclude = [...opts.exclude];
    // Fetch one extra row to cheaply determine hasMore without a
    // second count query on the hot GET /feed path.
    const fetchLimit = opts.limit + 1;

    let ids: string[];
    switch (descriptor.type) {
      case "editorial":
        ids = await this.editorialBookIds(descriptor.collectionId!, exclude, fetchLimit, opts.offset);
        break;
      case "new_arrivals":
        ids = await this.newArrivalsBookIds(exclude, fetchLimit, opts.offset);
        break;
      case "trending":
        ids = await this.trendingBookIds(exclude, fetchLimit, opts.offset);
        break;
      case "personalized_similar":
        ids = anonymousId
          ? await this.personalizedSimilarBookIds(anonymousId, exclude, fetchLimit, opts.offset)
          : [];
        break;
      case "recently_viewed":
        // Feature-flagged in SPEC-05, never enabled by any FEATURE_*
        // flag this phase wires up — no "view" event is emitted
        // anywhere yet (nothing calls POST /interest/view; SPEC-05
        // only specifies POST /interest/like), so there's no real
        // signal to query even if it were flagged on.
        ids = [];
        break;
    }

    const hasMore = ids.length > opts.limit;
    return { bookIds: ids.slice(0, opts.limit), hasMore };
  }

  private async editorialBookIds(
    collectionId: string,
    exclude: string[],
    limit: number,
    offset: number,
  ): Promise<string[]> {
    let query = this.db
      .selectFrom("catalog.bookCollections")
      .innerJoin("catalog.books", "catalog.books.id", "catalog.bookCollections.bookId")
      .select("catalog.books.id")
      .where("catalog.bookCollections.collectionId", "=", collectionId)
      .where("catalog.books.status", "=", "published");
    if (exclude.length > 0) query = query.where("catalog.books.id", "not in", exclude);

    const rows = await query.orderBy("catalog.bookCollections.sortOrder").limit(limit).offset(offset).execute();
    return rows.map((r) => r.id);
  }

  private async newArrivalsBookIds(exclude: string[], limit: number, offset: number): Promise<string[]> {
    let query = this.db.selectFrom("catalog.books").select("id").where("status", "=", "published");
    if (exclude.length > 0) query = query.where("id", "not in", exclude);

    const rows = await query
      .orderBy(sql`publication_date DESC NULLS LAST`)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .offset(offset)
      .execute();
    return rows.map((r) => r.id);
  }

  private async trendingBookIds(exclude: string[], limit: number, offset: number): Promise<string[]> {
    const excludeClause = exclude.length > 0 ? sql`AND b.id NOT IN (${sql.join(exclude)})` : sql``;
    const result = await sql<{ id: string }>`
      SELECT b.id
      FROM catalog.books b
      INNER JOIN (
        SELECT book_id, COUNT(*) AS like_count
        FROM discovery.interest_events
        WHERE action = 'like' AND created_at > now() - make_interval(days => ${TRENDING_WINDOW_DAYS})
        GROUP BY book_id
      ) trending ON trending.book_id = b.id
      WHERE b.status = 'published'
      ${excludeClause}
      ORDER BY trending.like_count DESC
      LIMIT ${limit} OFFSET ${offset}
    `.execute(this.db);
    return result.rows.map((r) => r.id);
  }

  /**
   * SPEC-05 "Similar to Books You Liked": books sharing an author or
   * theme with anything this profile has liked, ranked by how many
   * matching dimensions they share, excluding already-liked books.
   */
  private async personalizedSimilarBookIds(
    anonymousId: string,
    exclude: string[],
    limit: number,
    offset: number,
  ): Promise<string[]> {
    const liked = await this.likedBookIds(anonymousId);
    if (liked.length === 0) return [];

    const excludeIds = [...new Set([...exclude, ...liked])];
    const excludeClause = excludeIds.length > 0 ? sql`AND b.id NOT IN (${sql.join(excludeIds)})` : sql``;

    const result = await sql<{ id: string }>`
      WITH liked_works AS (
        SELECT DISTINCT work_id FROM catalog.books WHERE id IN (${sql.join(liked)})
      ),
      liked_authors AS (
        SELECT DISTINCT author_id FROM catalog.work_authors WHERE work_id IN (SELECT work_id FROM liked_works)
      ),
      liked_themes AS (
        SELECT DISTINCT theme_id FROM catalog.work_themes WHERE work_id IN (SELECT work_id FROM liked_works)
      ),
      candidates AS (
        SELECT b.id, wa.author_id AS matched_author_id, NULL::uuid AS matched_theme_id
        FROM catalog.books b
        INNER JOIN catalog.work_authors wa ON wa.work_id = b.work_id
        WHERE wa.author_id IN (SELECT author_id FROM liked_authors)
        UNION ALL
        SELECT b.id, NULL::uuid AS matched_author_id, wt.theme_id AS matched_theme_id
        FROM catalog.books b
        INNER JOIN catalog.work_themes wt ON wt.work_id = b.work_id
        WHERE wt.theme_id IN (SELECT theme_id FROM liked_themes)
      )
      SELECT b.id, COUNT(*) AS match_count
      FROM candidates c
      INNER JOIN catalog.books b ON b.id = c.id
      WHERE b.status = 'published'
      ${excludeClause}
      GROUP BY b.id
      ORDER BY match_count DESC
      LIMIT ${limit} OFFSET ${offset}
    `.execute(this.db);
    return result.rows.map((r) => r.id);
  }
}
