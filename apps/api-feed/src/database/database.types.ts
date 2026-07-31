import type { ColumnType, Generated } from "kysely";
import type { MediaAssetType } from "@pk-literature/domain-types";

// Hand-written against plan/database/ddl/discovery.sql plus the subset
// of catalog.sql this service reads (never writes — feed_api_rw is
// read-only on catalog, migration 20260201000002_feed_api_role.sql).
// Same CamelCasePlugin convention as apps/api-catalog and
// apps/api-publisher-import.

export type InterestAction = "like" | "unlike" | "view" | "add_to_cart";
export type ShelfType = "editorial" | "new_arrivals" | "trending" | "personalized_similar" | "recently_viewed";

export interface InterestProfileTable {
  anonymousId: string;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface InterestEventTable {
  id: Generated<string>;
  anonymousId: string;
  bookId: string;
  action: InterestAction;
  createdAt: Generated<ColumnType<Date, never, never>>;
}

export interface FeedShelfTable {
  id: Generated<string>;
  name: string;
  slug: string;
  type: ShelfType;
  collectionId: string | null;
  sortOrder: number;
  enabled: boolean;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface BannerTable {
  id: Generated<string>;
  imageAssetId: string;
  bookId: string;
  headline: string | null;
  sortOrder: number;
  enabled: boolean;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

// --- catalog read model — only the columns this service's shelf/card
// rendering actually needs, not a full mirror (apps/api-catalog's
// database.types.ts owns the complete picture). ---

export interface CatalogBookForCardTable {
  id: string;
  workId: string;
  publisherId: string;
  title: string;
  language: string;
  coverAssetId: string | null;
  status: string;
  publicationDate: ColumnType<string, never, never> | null;
  createdAt: ColumnType<Date, never, never>;
}

export interface CatalogPublisherTable {
  id: string;
  name: string;
  code: string;
}

export interface CatalogMediaAssetTable {
  id: string;
  assetType: MediaAssetType;
  s3Key: string;
  widthPx: number | null;
  heightPx: number | null;
}

export interface CatalogInventoryTable {
  bookId: string;
  stock: number;
  price: string;
  currency: string;
  availability: string;
}

export interface CatalogWorkAuthorTable {
  workId: string;
  authorId: string;
  role: string;
  sortOrder: number;
}

export interface CatalogAuthorTable {
  id: string;
  canonicalName: string;
}

export interface CatalogWorkThemeTable {
  workId: string;
  themeId: string;
}

export interface CatalogThemeTable {
  id: string;
  name: string;
  slug: string;
}

export interface CatalogBookCollectionTable {
  bookId: string;
  collectionId: string;
  sortOrder: number;
}

export interface CatalogCollectionTable {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface Database {
  "discovery.interestProfiles": InterestProfileTable;
  "discovery.interestEvents": InterestEventTable;
  "discovery.feedShelves": FeedShelfTable;
  "discovery.banners": BannerTable;
  "catalog.books": CatalogBookForCardTable;
  "catalog.publishers": CatalogPublisherTable;
  "catalog.mediaAssets": CatalogMediaAssetTable;
  "catalog.inventory": CatalogInventoryTable;
  "catalog.workAuthors": CatalogWorkAuthorTable;
  "catalog.authors": CatalogAuthorTable;
  "catalog.workThemes": CatalogWorkThemeTable;
  "catalog.themes": CatalogThemeTable;
  "catalog.bookCollections": CatalogBookCollectionTable;
  "catalog.collections": CatalogCollectionTable;
}
