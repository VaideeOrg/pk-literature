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
 * Yaavarum is a hybrid adapter (SPEC-04 §7 - registered as `html`, not
 * `json_feed`, because the per-book cost/mechanism is a real HTML page
 * fetch, same as Kalachuvadu - see below) - a second, independent
 * Shopify storefront alongside Ethirveliyeedu, but deliberately NOT
 * sharing code with EthirveliyeeduAdapter (per product decision): the
 * two sites' metadata shapes have nothing in common beyond both being
 * Shopify.
 *
 * Like Ethirveliyeedu, `/collections/all/products.json` is confirmed
 * live and used for discovery/pagination/price/stock/cover - but unlike
 * Ethirveliyeedu, this site's `body_html` carries no structured
 * Author/Genre/Language/ISBN label lines at all (confirmed against 5
 * real sample products - just free-form prose, some of it clearly
 * copy-pasted from Facebook/Instagram given the `x14z9mp xat24cr...`
 * class names). The only structured author data lives on the
 * *rendered* product detail page, as a Shopify "AI-generated content
 * block" (`ai-author-link-<hash>`) - so `fetchBook()` has to make a
 * real second HTTP request per book (the JSON-only caching trick
 * Ethirveliyeedu's fetchBook() uses doesn't fully apply here).
 * `fetchInventory()` still only needs the cached JSON, though - price/
 * stock live there.
 *
 * The `<hash>` suffix on every `ai-*` class name looks tied to this
 * store's theme-editor block instance, not something safe to hardcode -
 * selectors below match on the class *prefix*
 * (`div[class^="ai-author-link-"]`) instead of the literal hash.
 *
 * Per product decision, several SPEC-04 §12 fields have no discoverable
 * source anywhere (neither the JSON feed nor the one rendered page
 * sampled) and are deliberately left null rather than guessed at:
 * category/genre, editionLabel, isbn13. `language` is a fixed "ta"
 * default (no per-book field exists; the storefront's content is
 * predominantly Tamil, same reasoning as Kalachuvadu's fixed default).
 * `publicationDate` stays null even on the rare page where the
 * "Published Year" block *is* filled in - CanonicalBook requires a full
 * ISO date, and a bare year can't honestly satisfy that without
 * fabricating a month/day.
 *
 * `product_type` filtering is looser than Ethirveliyeedu's exact
 * "Books" match: `/collections/all` here mixes several non-blank
 * product_type values (confirmed: "literature" plus others) that all
 * count as importable books - only a blank product_type is excluded,
 * per product decision.
 */
export interface YaavarumAdapterConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ShopifyVariant {
  sku: string | null;
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

// raw.raw for this adapter carries both halves - the cached/fetched
// JSON product and the separately-fetched rendered detail page - since
// author only lives in the latter.
interface YaavarumRawBook {
  product: ShopifyProduct;
  detailHtml: string;
}

export class YaavarumAdapter implements PublisherAdapter {
  readonly publisherCode = "yaavarum";

  private readonly baseUrl: string;
  private readonly siteRoot: string;
  private readonly fetchImpl: typeof fetch;
  // Populated by discover(), read by fetchBook()/fetchInventory() for
  // the JSON half of each book - see the class-level comment on why
  // fetchBook() still needs a real second request for the HTML half.
  private readonly productCache = new Map<string, ShopifyProduct>();

  constructor(config: YaavarumAdapterConfig = {}) {
    this.baseUrl = config.baseUrl ?? "https://yaavarum.example/collections/all/products.json";
    this.siteRoot = new URL(this.baseUrl).origin;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async discover(cursor: string | null): Promise<DiscoveryResult> {
    const page = cursor ? Number(cursor) : 1;
    const listingUrl = `${this.baseUrl}?limit=250&page=${page}`;
    const response = await this.fetchImpl(listingUrl);
    if (!response.ok) {
      throw new Error(`discover(): GET ${listingUrl} failed with ${response.status}`);
    }
    const data = (await response.json()) as { products: ShopifyProduct[] };

    const refs: DiscoveredBookRef[] = [];
    for (const product of data.products) {
      // Only a blank product_type is excluded - looser than
      // Ethirveliyeedu's exact "Books" match, per product decision (see
      // class-level comment).
      if (product.product_type.trim() === "") {
        continue;
      }
      this.productCache.set(product.handle, product);
      refs.push({ sourceRef: product.handle, sourceUrl: `${this.siteRoot}/products/${product.handle}` });
    }

    // Continuation is based on the raw page's product count, not the
    // post-filter count - a page with zero non-blank products doesn't
    // mean the collection has ended.
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

    // Always a real fetch, unlike Ethirveliyeedu's cache-only path -
    // author only lives on the rendered page (see class-level comment).
    const detailResponse = await this.fetchImpl(ref.sourceUrl);
    if (!detailResponse.ok) {
      throw new Error(`fetchBook(): GET ${ref.sourceUrl} failed with ${detailResponse.status}`);
    }
    const detailHtml = await detailResponse.text();

    const raw: YaavarumRawBook = { product, detailHtml };
    return { sourceRef: ref.sourceRef, sourceUrl: ref.sourceUrl, raw };
  }

  async fetchInventory(ref: DiscoveredBookRef): Promise<RawInventory> {
    // Price/stock live in the JSON feed - no need for the HTML fetch
    // fetchBook() requires, same cached-JSON path as Ethirveliyeedu.
    const product = await this.resolveProduct(ref);
    const variant = product.variants[0];
    const price = variant ? parsePrice(variant.price) : null;

    return {
      sourceRef: ref.sourceRef,
      stock: null, // no quantity anywhere in the feed, only `available`
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
      widthPx: null,
      heightPx: null,
    };
  }

  normalize(raw: RawBook): CanonicalBook {
    const { product, detailHtml } = raw.raw as YaavarumRawBook;

    const authorNames = extractAuthorNames(detailHtml);

    const $description = cheerio.load(product.body_html ?? "");
    const descriptionParagraphs: string[] = [];
    $description("body")
      .children()
      .each((_, el) => {
        const text = $description(el).text().replace(/\s+/g, " ").trim();
        if (text) {
          descriptionParagraphs.push(text);
        }
      });

    const variant = product.variants[0];
    const sourceSku = variant?.sku ? variant.sku : null;
    const price = variant ? parsePrice(variant.price) : null;
    const coverSrc = product.images[0]?.src ?? null;

    return {
      sourceRef: raw.sourceRef,
      sourceSku,
      isbn13: null, // no discoverable source (JSON or rendered page)
      title: product.title || null,
      subtitle: null,
      authorNames,
      publisherName: product.vendor || null,
      description: descriptionParagraphs.length > 0 ? descriptionParagraphs.join("\n\n") : null,
      language: "ta", // fixed default - no per-book field exists (see class-level comment)
      coverSourceUrl: coverSrc ? new URL(coverSrc, this.siteRoot).toString() : null,
      price,
      currency: price !== null ? "INR" : null,
      stock: null, // fetchInventory() owns stock, not normalize()
      category: null, // no discoverable genre source (per product decision)
      publicationDate: null, // per product decision - see class-level comment
      editionLabel: null, // no discoverable source
      pageCount: null, // no discoverable source
    };
  }

  validate(book: CanonicalBook): ValidationResult {
    return validateBookFields(book);
  }

  // Shared by fetchBook()/fetchInventory() for the JSON half of a
  // book - same cache-or-fallback shape as EthirveliyeeduAdapter's own
  // resolveProduct(), duplicated rather than shared per product
  // decision (this adapter isn't bundled with that one).
  private async resolveProduct(ref: DiscoveredBookRef): Promise<ShopifyProduct> {
    const cached = this.productCache.get(ref.sourceRef);
    if (cached) {
      return cached;
    }

    // Fallback path - not confirmed live, only reached if
    // fetchBook()/fetchInventory() is called without a prior discover()
    // in the same adapter instance.
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

// Confirmed against a real captured detail page: each author is a
// `div.ai-author-link-<hash>` containing exactly two <span> children -
// an (always empty, on the one page sampled) label span, then a plain
// span with the actual name. Taking the *last* span rather than
// concatenating the whole block's text avoids picking up a label if a
// future page ever does put text in it.
function extractAuthorNames(detailHtml: string): string[] {
  const $ = cheerio.load(detailHtml);
  const names: string[] = [];
  $('div[class^="ai-author-link-"]').each((_, el) => {
    const name = $(el).children("span").last().text().replace(/\s+/g, " ").trim();
    if (name) {
      names.push(name);
    }
  });
  return names;
}

function parsePrice(raw: string): number | null {
  const price = Number.parseFloat(raw);
  return Number.isNaN(price) ? null : price;
}
