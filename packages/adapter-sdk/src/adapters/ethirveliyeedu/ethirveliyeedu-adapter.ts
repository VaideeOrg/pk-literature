import * as cheerio from "cheerio";
import { validateBookFields } from "../../validate";
import type {
  CanonicalBook,
  DiscoveredBookRef,
  DiscoveryResult,
  DownloadedCover,
  PublisherAdapter,
  RawBook,
  RawInventory,
  ValidationResult,
} from "../../types";

/**
 * Ethirveliyeedu is a JSON-feed adapter (SPEC-04 §7): the site is a
 * Shopify storefront (Impulse theme) and Shopify serves a public,
 * unauthenticated products.json feed for any collection — confirmed
 * live against `https://ethirveliyeedu.com/collections/all/products.json`
 * — so this adapter parses that JSON directly instead of scraping
 * rendered HTML (only `body_html` needs any HTML parsing, via cheerio,
 * same library Kalachuvadu uses for full-page scraping).
 *
 * Unlike Kalachuvadu, this site is a multi-publisher bookstore, not a
 * single publisher's own storefront: `vendor` varies per product
 * (confirmed live — "Vaanathi", "Ethir Veliyeedu", "Roja Muthiah
 * Research Library" all appear in the same collection), so
 * `publisherName` is read per-book from `vendor`, never hardcoded.
 *
 * `/collections/all` is literally every product in the store, not a
 * books-only collection — `discover()` keeps only `product_type ===
 * "Books"` (confirmed live: this is "Books" on most products, but
 * blank on at least one that is still clearly a book by content: that
 * one is deliberately excluded too, per product decision, rather than
 * guessed at).
 *
 * Author/Translator/Genre/Language/Type/ISBN have no dedicated JSON
 * fields (Shopify metafields carry some of this but aren't in the
 * public feed) — they're `<strong>Label</strong>: value` lines inside
 * `body_html`, always English label words even when the value itself
 * is Tamil/French/etc., so one label regex works across every product
 * seen so far. Translator has no home in CanonicalBook and is
 * deliberately dropped, per product decision, rather than
 * approximated into some other field.
 *
 * `sourceSku` (variant SKU) and `isbn13` are deliberately kept
 * separate and never cross-populate each other: a SKU that happens to
 * look like a 13-digit number is not confirmed to *be* an ISBN (per
 * product decision) — isbn13 is only ever set from an explicit "ISBN:"
 * label line in body_html.
 *
 * Caching note: `discover()` fetches full product JSON already —
 * everything `normalize()`/`fetchInventory()` need is right there, so
 * rather than mirroring Kalachuvadu's separate-fetch-per-book shape
 * (which would mean a second HTTP call per product for data already in
 * hand), `discover()` caches each surviving product by handle and
 * `fetchBook()`/`fetchInventory()` read from that cache — safe because
 * apps/publisher-crawler/src/run-import.ts always calls fetchBook()/
 * fetchInventory() immediately after discover() produced that ref, on
 * the same adapter instance, before the next page is ever fetched. A
 * direct `GET /products/<handle>.json` fallback exists for the case
 * where fetchBook()/fetchInventory() is called without a prior
 * discover() in the same instance (Shopify's standard single-product
 * JSON endpoint - this fallback path itself has not been confirmed
 * live, only the multi-product listing endpoint has).
 */
export interface EthirveliyeeduAdapterConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ShopifyVariant {
  sku: string;
  price: string;
  available: boolean;
}

interface ShopifyImage {
  src: string;
}

interface ShopifyProduct {
  handle: string;
  title: string;
  body_html: string;
  vendor: string;
  product_type: string;
  variants: ShopifyVariant[];
  images: ShopifyImage[];
}

// Labels observed on real product pages, always English words even
// when the value is in another language — see the adapter's own header
// comment.
const LABEL_LINE = /^(Author|Translator|Genre|Language|Type|ISBN)\s*:\s*(.+)$/i;

// Small, hardcoded on purpose (per product decision) — extend as new
// languages are actually observed on the site rather than guessing
// ahead of time.
const LANGUAGE_TO_ISO: Record<string, string> = {
  தமிழ்: "ta",
  English: "en",
  French: "fr",
};

export class EthirveliyeeduAdapter implements PublisherAdapter {
  readonly publisherCode = "ethirveliyeedu";

  private readonly baseUrl: string;
  private readonly siteRoot: string;
  private readonly fetchImpl: typeof fetch;
  // Populated by discover(), read by fetchBook()/fetchInventory() — see
  // the class-level caching note above.
  private readonly productCache = new Map<string, ShopifyProduct>();

  constructor(config: EthirveliyeeduAdapterConfig = {}) {
    this.baseUrl = config.baseUrl ?? "https://ethirveliyeedu.example/collections/all/products.json";
    this.siteRoot = new URL(this.baseUrl).origin;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async discover(cursor: string | null): Promise<DiscoveryResult> {
    const page = cursor ? Number(cursor) : 1;
    // 250 is Shopify's own documented max page size — minimizes request
    // count against the ~624-product catalogue (confirmed live count).
    const listingUrl = `${this.baseUrl}?limit=250&page=${page}`;
    const response = await this.fetchImpl(listingUrl);
    if (!response.ok) {
      throw new Error(`discover(): GET ${listingUrl} failed with ${response.status}`);
    }
    const data = (await response.json()) as { products: ShopifyProduct[] };

    const refs: DiscoveredBookRef[] = [];
    for (const product of data.products) {
      // Filter is on the *refs* produced, not on pagination continuation
      // below — a page can have zero qualifying Books and still not be
      // the last page of the collection.
      if (product.product_type !== "Books") {
        continue;
      }
      this.productCache.set(product.handle, product);
      refs.push({ sourceRef: product.handle, sourceUrl: `${this.siteRoot}/products/${product.handle}` });
    }

    // No total-count field in this response — Shopify's own convention
    // is "keep paging until an empty page", same idea as Kalachuvadu's
    // next-page-link check, just keyed off array length instead of a
    // DOM element.
    const hasNextPage = data.products.length > 0;
    return { refs, nextPageCursor: hasNextPage ? String(page + 1) : null };
  }

  async fetchBooks(refs: DiscoveredBookRef[]): Promise<RawBook[]> {
    const books: RawBook[] = [];
    for (const ref of refs) {
      books.push(await this.fetchBook(ref));
    }
    return books;
  }

  async fetchBook(ref: DiscoveredBookRef): Promise<RawBook> {
    const product = await this.resolveProduct(ref);
    return { sourceRef: ref.sourceRef, sourceUrl: ref.sourceUrl, raw: product };
  }

  async fetchInventory(ref: DiscoveredBookRef): Promise<RawInventory> {
    const product = await this.resolveProduct(ref);
    const variant = product.variants[0];
    const price = variant ? parsePrice(variant.price) : null;

    return {
      sourceRef: ref.sourceRef,
      // No quantity anywhere in this feed, only the `available`
      // boolean — same stock:null convention as Kalachuvadu.
      stock: null,
      price,
      currency: price !== null ? "INR" : null,
      availability: variant?.available ? "in_stock" : "out_of_stock",
    };
  }

  async downloadCover(sourceUrl: string): Promise<DownloadedCover> {
    const response = await this.fetchImpl(sourceUrl);
    if (!response.ok) {
      throw new Error(`downloadCover(): GET ${sourceUrl} failed with ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      sourceUrl,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      bytes,
      // See Kalachuvadu's own comment — Optimize stage's concern, not fetch-time.
      widthPx: null,
      heightPx: null,
    };
  }

  normalize(raw: RawBook): CanonicalBook {
    const product = raw.raw as ShopifyProduct;
    const $ = cheerio.load(product.body_html ?? "");

    const labels = new Map<string, string>();
    const descriptionParagraphs: string[] = [];
    $("body")
      .children()
      .each((_, el) => {
        const text = $(el).text().replace(/\s+/g, " ").trim();
        if (!text) {
          return;
        }
        const match = text.match(LABEL_LINE);
        if (match) {
          labels.set(match[1]!.toLowerCase(), match[2]!.trim());
        } else {
          descriptionParagraphs.push(text);
        }
      });

    const authorLine = labels.get("author");
    const authorNames = authorLine
      ? authorLine
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      : [];

    const languageLabel = labels.get("language");
    const language = languageLabel ? (LANGUAGE_TO_ISO[languageLabel] ?? null) : null;

    // Deliberately never derived from variant.sku — see the adapter's
    // own header comment on why sourceSku/isbn13 never cross-populate.
    const isbnLabel = labels.get("isbn");
    const isbnDigits = isbnLabel ? isbnLabel.replace(/[^0-9]/g, "") : "";
    const isbn13 = isbnDigits.length === 13 ? isbnDigits : null;

    const variant = product.variants[0];
    const sourceSku = variant?.sku ? variant.sku : null;
    const price = variant ? parsePrice(variant.price) : null;
    const coverSrc = product.images[0]?.src ?? null;

    return {
      sourceRef: raw.sourceRef,
      sourceSku,
      isbn13,
      title: product.title || null,
      // No discoverable subtitle field anywhere on the real feed.
      subtitle: null,
      authorNames,
      publisherName: product.vendor || null,
      description: descriptionParagraphs.length > 0 ? descriptionParagraphs.join("\n\n") : null,
      language,
      coverSourceUrl: coverSrc ? new URL(coverSrc, this.siteRoot).toString() : null,
      price,
      currency: price !== null ? "INR" : null,
      stock: null, // fetchInventory() owns stock, not normalize()
      category: labels.get("genre") ?? null,
      publicationDate: null, // no discoverable field
      editionLabel: labels.get("type") ?? null,
      pageCount: null, // no discoverable field on any product seen so far
    };
  }

  validate(book: CanonicalBook): ValidationResult {
    return validateBookFields(book);
  }

  // Shared by fetchBook()/fetchInventory() — see the class-level
  // caching note for why this checks the cache before ever making a
  // network call.
  private async resolveProduct(ref: DiscoveredBookRef): Promise<ShopifyProduct> {
    const cached = this.productCache.get(ref.sourceRef);
    if (cached) {
      return cached;
    }

    // Fallback path — see header comment: not confirmed live, only
    // reached if fetchBook()/fetchInventory() is ever called without a
    // prior discover() in the same adapter instance.
    const detailUrl = `${this.siteRoot}/products/${ref.sourceRef}.json`;
    const response = await this.fetchImpl(detailUrl);
    if (!response.ok) {
      throw new Error(`resolveProduct(): GET ${detailUrl} failed with ${response.status}`);
    }
    const data = (await response.json()) as { product: ShopifyProduct };
    this.productCache.set(ref.sourceRef, data.product);
    return data.product;
  }
}

function parsePrice(raw: string): number | null {
  const price = Number.parseFloat(raw);
  return Number.isNaN(price) ? null : price;
}
