import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  Book,
  BookContributorEntry,
  BookListItem,
  CollectionSummary,
  Inventory,
} from "@pk-literature/domain-types";
import { KYSELY } from "../database/database.module";
import type { Database } from "../database/database.types";
import { toMediaAsset } from "../common/media-url";
import { NotFoundProblem } from "../common/problem-details.exception";
import type { PaginationDto } from "../common/pagination.dto";
import { WorksService } from "../works/works.service";

export interface ListBooksFilter {
  // `| undefined` explicitly, not just optional — the controller passes
  // this straight from validated query params (which may be undefined),
  // and exactOptionalPropertyTypes distinguishes that from "key omitted."
  workId?: string | undefined;
  publisherId?: string | undefined;
}

@Injectable()
export class BooksService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly works: WorksService,
  ) {}

  private async contributorsByBook(bookIds: string[]): Promise<Map<string, BookContributorEntry[]>> {
    if (bookIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("catalog.bookContributors")
      .innerJoin("catalog.authors", "catalog.authors.id", "catalog.bookContributors.authorId")
      .select([
        "catalog.bookContributors.bookId",
        "catalog.bookContributors.role",
        "catalog.authors.id as authorId",
        "catalog.authors.canonicalName",
      ])
      .where("catalog.bookContributors.bookId", "in", bookIds)
      .orderBy("catalog.bookContributors.sortOrder")
      .execute();

    const map = new Map<string, BookContributorEntry[]>();
    for (const row of rows) {
      const entry: BookContributorEntry = {
        author: { id: row.authorId, canonicalName: row.canonicalName },
        role: row.role as BookContributorEntry["role"],
      };
      const existing = map.get(row.bookId);
      if (existing) existing.push(entry);
      else map.set(row.bookId, [entry]);
    }
    return map;
  }

  private async collectionsByBook(bookIds: string[]): Promise<Map<string, CollectionSummary[]>> {
    if (bookIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("catalog.bookCollections")
      .innerJoin("catalog.collections", "catalog.collections.id", "catalog.bookCollections.collectionId")
      .select([
        "catalog.bookCollections.bookId",
        "catalog.collections.id",
        "catalog.collections.name",
        "catalog.collections.slug",
      ])
      .where("catalog.bookCollections.bookId", "in", bookIds)
      .where("catalog.collections.status", "=", "published")
      .orderBy("catalog.bookCollections.sortOrder")
      .execute();

    const map = new Map<string, CollectionSummary[]>();
    for (const row of rows) {
      const entry: CollectionSummary = { id: row.id, name: row.name, slug: row.slug };
      const existing = map.get(row.bookId);
      if (existing) existing.push(entry);
      else map.set(row.bookId, [entry]);
    }
    return map;
  }

  // market is the X-Market request header (see books.controller.ts) —
  // "SG" reads catalog.inventory.price_sgd/'SGD' instead of the base
  // price/currency (puthagakadai.sg storefront, migration
  // 20260101000028). A null price_sgd is treated exactly like the
  // no-inventory-row case below (whole inventory comes back null) -
  // "not yet priced for SG" and "not in stock anywhere" both correctly
  // fall through to the same existing "no price = unavailable"
  // convention downstream (BookCard, checkout validation), with no new
  // UI state needed.
  private toInventory(
    row: {
      stock: number;
      price: string;
      currency: string;
      priceSgd: string | null;
      availability: Inventory["availability"];
    } | null,
    market: string | undefined,
  ): Inventory | null {
    if (!row) return null;
    if (market?.toUpperCase() === "SG") {
      if (row.priceSgd === null) return null;
      return { stock: row.stock, price: Number(row.priceSgd), currency: "SGD", availability: row.availability };
    }
    return {
      stock: row.stock,
      price: Number(row.price),
      currency: row.currency,
      availability: row.availability,
    };
  }

  async list(
    pagination: PaginationDto,
    filter: ListBooksFilter,
    market: string | undefined,
  ): Promise<{ items: BookListItem[]; totalItems: number }> {
    let query = this.db
      .selectFrom("catalog.books")
      .innerJoin("catalog.publishers", "catalog.publishers.id", "catalog.books.publisherId")
      .leftJoin("catalog.mediaAssets", "catalog.mediaAssets.id", "catalog.books.coverAssetId")
      .leftJoin("catalog.inventory", "catalog.inventory.bookId", "catalog.books.id")
      .where("catalog.books.status", "=", "published");

    let countQuery = this.db
      .selectFrom("catalog.books")
      .where("catalog.books.status", "=", "published");

    if (filter.workId) {
      query = query.where("catalog.books.workId", "=", filter.workId);
      countQuery = countQuery.where("catalog.books.workId", "=", filter.workId);
    }
    if (filter.publisherId) {
      query = query.where("catalog.books.publisherId", "=", filter.publisherId);
      countQuery = countQuery.where("catalog.books.publisherId", "=", filter.publisherId);
    }

    const [rows, countRow] = await Promise.all([
      query
        .select([
          "catalog.books.id",
          "catalog.books.workId",
          "catalog.books.title",
          "catalog.books.subtitle",
          "catalog.books.language",
          "catalog.books.format",
          "catalog.publishers.id as publisherId",
          "catalog.publishers.name as publisherName",
          "catalog.publishers.code as publisherCode",
          "catalog.mediaAssets.id as coverId",
          "catalog.mediaAssets.assetType as coverAssetType",
          "catalog.mediaAssets.s3Key as coverS3Key",
          "catalog.mediaAssets.widthPx as coverWidthPx",
          "catalog.mediaAssets.heightPx as coverHeightPx",
          "catalog.inventory.stock",
          "catalog.inventory.price",
          "catalog.inventory.currency",
          "catalog.inventory.priceSgd",
          "catalog.inventory.availability",
        ])
        .orderBy("catalog.books.title")
        .limit(pagination.pageSize)
        .offset(pagination.offset)
        .execute(),
      countQuery.select((eb) => eb.fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    ]);

    const workSummaries = await this.works.summariesByIds(rows.map((r) => r.workId));

    const items: BookListItem[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      language: row.language,
      format: row.format,
      cover: toMediaAsset(
        row.coverId
          ? {
              id: row.coverId,
              assetType: row.coverAssetType!,
              s3Key: row.coverS3Key!,
              widthPx: row.coverWidthPx,
              heightPx: row.coverHeightPx,
            }
          : null,
      ),
      work: workSummaries.get(row.workId)!,
      publisher: { id: row.publisherId, name: row.publisherName, code: row.publisherCode },
      inventory: this.toInventory(
        row.stock === null || row.price === null || row.currency === null || row.availability === null
          ? null
          : {
              stock: row.stock,
              price: row.price,
              currency: row.currency,
              priceSgd: row.priceSgd,
              availability: row.availability,
            },
        market,
      ),
    }));

    return { items, totalItems: Number(countRow.count) };
  }

  async getById(id: string, market: string | undefined): Promise<Book> {
    const row = await this.db
      .selectFrom("catalog.books")
      .innerJoin("catalog.publishers", "catalog.publishers.id", "catalog.books.publisherId")
      .leftJoin("catalog.mediaAssets", "catalog.mediaAssets.id", "catalog.books.coverAssetId")
      .leftJoin("catalog.inventory", "catalog.inventory.bookId", "catalog.books.id")
      .select([
        "catalog.books.id",
        "catalog.books.workId",
        "catalog.books.translatedFromBookId",
        "catalog.books.isbn13",
        "catalog.books.title",
        "catalog.books.subtitle",
        "catalog.books.language",
        "catalog.books.editionLabel",
        "catalog.books.editionNumber",
        "catalog.books.format",
        "catalog.books.pageCount",
        "catalog.books.publicationDate",
        "catalog.books.status",
        "catalog.publishers.id as publisherId",
        "catalog.publishers.name as publisherName",
        "catalog.publishers.code as publisherCode",
        "catalog.mediaAssets.id as coverId",
        "catalog.mediaAssets.assetType as coverAssetType",
        "catalog.mediaAssets.s3Key as coverS3Key",
        "catalog.mediaAssets.widthPx as coverWidthPx",
        "catalog.mediaAssets.heightPx as coverHeightPx",
        "catalog.inventory.stock",
        "catalog.inventory.price",
        "catalog.inventory.currency",
        "catalog.inventory.priceSgd",
        "catalog.inventory.availability",
      ])
      .where("catalog.books.id", "=", id)
      .where("catalog.books.status", "=", "published")
      .executeTakeFirst();

    if (!row) throw new NotFoundProblem("Book", id);

    const [workSummaries, contributorsMap, collectionsMap] = await Promise.all([
      this.works.summariesByIds([row.workId]),
      this.contributorsByBook([id]),
      this.collectionsByBook([id]),
    ]);

    return {
      id: row.id,
      isbn13: row.isbn13,
      title: row.title,
      subtitle: row.subtitle,
      language: row.language,
      editionLabel: row.editionLabel,
      editionNumber: row.editionNumber,
      format: row.format,
      pageCount: row.pageCount,
      publicationDate: row.publicationDate,
      status: row.status,
      work: workSummaries.get(row.workId)!,
      publisher: { id: row.publisherId, name: row.publisherName, code: row.publisherCode },
      cover: toMediaAsset(
        row.coverId
          ? {
              id: row.coverId,
              assetType: row.coverAssetType!,
              s3Key: row.coverS3Key!,
              widthPx: row.coverWidthPx,
              heightPx: row.coverHeightPx,
            }
          : null,
      ),
      contributors: contributorsMap.get(id) ?? [],
      collections: collectionsMap.get(id) ?? [],
      inventory: this.toInventory(
        row.stock === null || row.price === null || row.currency === null || row.availability === null
          ? null
          : {
              stock: row.stock,
              price: row.price,
              currency: row.currency,
              priceSgd: row.priceSgd,
              availability: row.availability,
            },
        market,
      ),
      translatedFromBookId: row.translatedFromBookId,
    };
  }
}
