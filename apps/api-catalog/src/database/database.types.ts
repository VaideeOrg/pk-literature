import type { ColumnType, Generated } from "kysely";

// Hand-written against plan/database/ddl/catalog.sql — see
// database/migrations.md: DDL is the source of truth, this is typed to
// match it, not generated from a live DB (kysely-codegen is a future
// improvement once a real dev database exists to introspect).
//
// Declared in camelCase throughout: the app uses CamelCasePlugin (see
// database.module.ts), which translates camelCase identifiers to the
// actual snake_case SQL columns both directions — so `db.selectFrom
// ('works').select('canonicalTitle')` is correct, not a typo.
//
// Only `catalog` schema tables are typed here — this service's API
// surface never reads `staging` (that's api-publisher-import's
// concern, ADR-009), even though this app owns the migration files for
// both schemas (migrations.md's "one migration directory per owning
// service" rule, not "one query layer").

export type EditorialStatus =
  | "draft"
  | "needs_review"
  | "approved"
  | "published"
  | "archived";

export type WorkType =
  | "novel"
  | "short_story_collection"
  | "poetry_collection"
  | "essay_collection"
  | "drama"
  | "biography"
  | "non_fiction"
  | "other";

export type BookFormat = "paperback" | "hardcover";

export type InventoryAvailability =
  | "in_stock"
  | "out_of_stock"
  | "preorder"
  | "discontinued";

export type MediaAssetType = "cover" | "publisher_logo" | "banner" | "author_photo";

export interface PublisherTable {
  id: Generated<string>;
  name: string;
  code: string;
  website: string | null;
  country: string | null;
  logoAssetId: string | null;
  adapterType: string;
  active: boolean;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface MediaAssetTable {
  id: Generated<string>;
  assetType: MediaAssetType;
  s3Key: string;
  contentType: string;
  widthPx: number | null;
  heightPx: number | null;
  createdAt: Generated<ColumnType<Date, never, never>>;
}

export interface AuthorTable {
  id: Generated<string>;
  canonicalName: string;
  nativeName: string | null;
  biography: string | null;
  birthYear: number | null;
  deathYear: number | null;
  photoAssetId: string | null;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface ThemeTable {
  id: Generated<string>;
  name: string;
  slug: string;
  description: string | null;
}

export interface GenreTable {
  id: Generated<string>;
  name: string;
  slug: string;
  description: string | null;
}

export interface LiteraryMovementTable {
  id: Generated<string>;
  name: string;
  slug: string;
  description: string | null;
  periodStartYear: number | null;
  periodEndYear: number | null;
}

export interface WorkTable {
  id: Generated<string>;
  canonicalTitle: string;
  canonicalTitleTranslit: string | null;
  originalLanguage: string;
  workType: WorkType;
  firstPublicationYear: number | null;
  summary: string | null;
  status: EditorialStatus;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface WorkAuthorTable {
  workId: string;
  authorId: string;
  role: string;
  sortOrder: number;
}

export interface WorkThemeTable {
  workId: string;
  themeId: string;
}

export interface WorkGenreTable {
  workId: string;
  genreId: string;
}

export interface WorkLiteraryMovementTable {
  workId: string;
  literaryMovementId: string;
}

export interface BookTable {
  id: Generated<string>;
  workId: string;
  publisherId: string;
  translatedFromBookId: string | null;
  isbn13: string | null;
  title: string;
  subtitle: string | null;
  language: string;
  editionLabel: string | null;
  editionNumber: number | null;
  format: BookFormat;
  pageCount: number | null;
  publicationDate: ColumnType<string, string, string> | null;
  coverAssetId: string | null;
  status: EditorialStatus;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface BookContributorTable {
  bookId: string;
  authorId: string;
  role: string;
  sortOrder: number;
}

export interface CollectionTable {
  id: Generated<string>;
  name: string;
  slug: string;
  description: string | null;
  status: EditorialStatus;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface BookCollectionTable {
  bookId: string;
  collectionId: string;
  sortOrder: number;
}

export interface InventoryTable {
  bookId: string;
  sku: string | null;
  stock: number;
  price: string; // numeric(10,2) — Kysely/pg returns numeric as string to avoid float precision loss
  currency: string;
  priceSgd: string | null; // puthagakadai.sg override, always SGD - see migration 20260101000028
  availability: InventoryAvailability;
  lastSyncTime: Date | null;
  updatedBy: string;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface Database {
  "catalog.publishers": PublisherTable;
  "catalog.mediaAssets": MediaAssetTable;
  "catalog.authors": AuthorTable;
  "catalog.themes": ThemeTable;
  "catalog.genres": GenreTable;
  "catalog.literaryMovements": LiteraryMovementTable;
  "catalog.works": WorkTable;
  "catalog.workAuthors": WorkAuthorTable;
  "catalog.workThemes": WorkThemeTable;
  "catalog.workGenres": WorkGenreTable;
  "catalog.workLiteraryMovements": WorkLiteraryMovementTable;
  "catalog.books": BookTable;
  "catalog.bookContributors": BookContributorTable;
  "catalog.collections": CollectionTable;
  "catalog.bookCollections": BookCollectionTable;
  "catalog.inventory": InventoryTable;
}
