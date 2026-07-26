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
 * Reference adapter (SPEC-04 Appendix D) — Kalachuvadu is an HTML-type
 * adapter (SPEC-04 §7): no public API, so this crawls listing + detail
 * pages and parses them with cheerio.
 *
 * Listing URL scheme confirmed against the real site (discover() below);
 * `baseUrl` defaults to a placeholder (`kalachuvadu.example`, matching
 * this repo's existing placeholder-domain convention) for tests, but in
 * every deployed environment it's the real
 * `https://books.kalachuvadu.com/kcbooks/Allproducts` (SPEC-04 §8's
 * `PublisherRegistration.baseUrl`, seeded in
 * apps/api-catalog/migrations/20260101000009_seed_kalachuvadu_publisher.sql).
 *
 * The CSS selectors below (`.book-card`, `.book-title`, ...) remain
 * illustrative, modeled on a typical bookstore catalog/detail page
 * layout, NOT yet verified against the live site's actual markup —
 * before this adapter can successfully parse real book data, a human
 * needs to: inspect the real markup, update these selectors, confirm
 * robots.txt allows this (SPEC-04 §25), and re-run this adapter's tests
 * against real fixture HTML captured from the site.
 */
export interface KalachuvaduAdapterConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

// Publisher pages describe language by name, not ISO code — SPEC-01
// only ever deals in these two, so a short map beats a dependency.
const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  tamil: "ta",
  english: "en",
};

export class KalachuvaduAdapter implements PublisherAdapter {
  readonly publisherCode = "kalachuvadu";

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: KalachuvaduAdapterConfig = {}) {
    this.baseUrl = config.baseUrl ?? "https://kalachuvadu.example";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async discover(cursor: string | null): Promise<DiscoveryResult> {
    const page = cursor ? Number(cursor) : 1;
    // Confirmed against the real site: the registered baseUrl
    // (https://books.kalachuvadu.com/kcbooks/Allproducts) *is* the
    // listing page — pagination is a query param on that same URL, not
    // a "/books" sub-path (which 404s).
    const listingUrl = `${this.baseUrl}?page=${page}`;
    const response = await this.fetchImpl(listingUrl);
    if (!response.ok) {
      throw new Error(`discover(): GET ${listingUrl} failed with ${response.status}`);
    }
    const $ = cheerio.load(await response.text());

    const refs: DiscoveredBookRef[] = $(".book-card .book-link")
      .map((_, el): DiscoveredBookRef => {
        const href = $(el).attr("href") ?? "";
        const sourceUrl = new URL(href, this.baseUrl).toString();
        const sourceRef = href.replace(/^\/?books\//, "").replace(/\/$/, "");
        return { sourceRef, sourceUrl };
      })
      .get();

    const hasNextPage = $(".pagination-next").length > 0;
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
    const response = await this.fetchImpl(ref.sourceUrl);
    if (!response.ok) {
      throw new Error(`fetchBook(): GET ${ref.sourceUrl} failed with ${response.status}`);
    }
    return { sourceRef: ref.sourceRef, sourceUrl: ref.sourceUrl, raw: await response.text() };
  }

  async fetchInventory(ref: DiscoveredBookRef): Promise<RawInventory> {
    // Kalachuvadu has no separate inventory endpoint — the detail page
    // itself carries current stock/price, same as a fresh fetchBook().
    const raw = await this.fetchBook(ref);
    const $ = cheerio.load(raw.raw as string);

    const stockText = $(".book-stock").first().text().trim();
    const stock = stockText ? Number.parseInt(stockText, 10) : null;
    const priceText = $(".book-price").first().text().trim();
    const price = priceText ? Number.parseFloat(priceText) : null;
    const currency = $(".book-price").first().attr("data-currency") ?? null;

    return {
      sourceRef: ref.sourceRef,
      stock: Number.isNaN(stock) ? null : stock,
      price: price !== null && Number.isNaN(price) ? null : price,
      currency,
      availability: stock !== null && stock > 0 ? "in_stock" : "out_of_stock",
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
      // Pixel dimensions are deliberately not computed here — SPEC-04
      // §13's pipeline (Download -> Virus Scan -> Optimize -> Thumbnail
      // -> Upload S3) treats that as part of the Optimize stage, which
      // runs server-side in apps/api-publisher-import after the virus
      // scan, not during this fetch-only step.
      widthPx: null,
      heightPx: null,
    };
  }

  normalize(raw: RawBook): CanonicalBook {
    const $ = cheerio.load(raw.raw as string);
    const root = $(".book-detail");

    const isbnText = root.find(".book-isbn").first().text().trim();
    const isbnMatch = isbnText.match(/(\d{13})/);

    const authorText = root.find(".book-author").first().text().trim();
    // Extraction only — this is the raw author string as it appears on
    // the page (native script or already-romanized, whichever the
    // publisher uses), split on common multi-author separators.
    // Transliteration to the canonical romanized form and alias storage
    // (SPEC-04 §14's "ஜெயமோகன்" -> "Jeyamohan" example,
    // catalog.author_aliases) is a duplicate-detection/editorial
    // concern that needs the database and a real transliteration
    // engine — out of scope for a reference HTML adapter, and
    // authoritatively handled server-side (apps/api-publisher-import),
    // not here.
    const authorNames = authorText
      .split(/[,;&]| and /i)
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    const languageText = root.find(".book-language").first().text().trim().toLowerCase();
    const priceText = root.find(".book-price").first().text().trim();
    const price = priceText ? Number.parseFloat(priceText) : null;
    const pageCountText = root.find(".book-pages").first().text().trim();
    const pageCount = pageCountText ? Number.parseInt(pageCountText, 10) : null;
    const coverSrc = root.find(".book-cover").first().attr("src");

    return {
      sourceRef: raw.sourceRef,
      isbn13: isbnMatch ? isbnMatch[1]! : null,
      title: root.find(".book-title").first().text().trim() || null,
      subtitle: root.find(".book-subtitle").first().text().trim() || null,
      authorNames,
      publisherName: "Kalachuvadu",
      description: root.find(".book-description").first().text().trim() || null,
      language: LANGUAGE_NAME_TO_CODE[languageText] ?? null,
      coverSourceUrl: coverSrc ? new URL(coverSrc, raw.sourceUrl).toString() : null,
      price: price !== null && !Number.isNaN(price) ? price : null,
      currency: root.find(".book-price").first().attr("data-currency") ?? null,
      stock: null, // fetchInventory() owns stock, not normalize() — SPEC-02's separate inventory table mirrors this split
      category: root.find(".book-category").first().text().trim() || null,
      publicationDate: root.find(".book-publication-date").first().text().trim() || null,
      editionLabel: root.find(".book-edition").first().text().trim() || null,
      pageCount: pageCount !== null && !Number.isNaN(pageCount) ? pageCount : null,
    };
  }

  validate(book: CanonicalBook): ValidationResult {
    return validateBookFields(book);
  }
}
