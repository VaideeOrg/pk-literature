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
 * Listing URL scheme, discover()'s selectors, and (as of this revision)
 * fetchInventory()/normalize()'s detail-page selectors are all confirmed
 * against real markup captured from the live site (a Django-oscar
 * storefront). `baseUrl` defaults to a placeholder (`kalachuvadu.example`,
 * matching this repo's existing placeholder-domain convention) for tests,
 * but in every deployed environment it's the real
 * `https://books.kalachuvadu.com/kcbooks/Allproducts` (SPEC-04 §8's
 * `PublisherRegistration.baseUrl`, seeded in
 * apps/api-catalog/migrations/20260101000009_seed_kalachuvadu_publisher.sql).
 *
 * Fields with no discoverable equivalent anywhere on the real detail page
 * are set to fixed defaults rather than scraped: `language` is always
 * `"ta"` (the whole storefront is Tamil-only; no per-book language field
 * exists), `currency` is `"INR"` whenever a price was found (the page
 * only ever shows a ₹ symbol, no `data-currency`-style attribute),
 * `subtitle`/`publicationDate`/`editionLabel` are always `null` (no
 * matching field found on the captured page at all).
 *
 * `fetchInventory()`'s in-stock/out-of-stock signal is a heuristic
 * (presence of a buy-now/add-to-cart form) rather than a confirmed one —
 * only an in-stock detail page has been captured so far; an out-of-stock
 * sample would confirm or replace this.
 */
export interface KalachuvaduAdapterConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

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

    // Confirmed against real markup: each book card's own detail-page
    // link is the direct-child <a class="first__img"> inside
    // .product__thumb. The same "first__img" class also appears inside
    // each card's quickview modal (.product-images .main-image a) —
    // scoping to .product__thumb's direct child avoids double-counting
    // those. hrefs are root-absolute (/catalogue/<slug>_<id>/), not
    // relative to baseUrl's own path, so new URL(href, baseUrl) resolves
    // them correctly without the WHATWG absolute-path pitfall (see
    // apps/publisher-crawler's sigv4-http-staging-ingest-client.ts fix).
    const refs: DiscoveredBookRef[] = $(".product__thumb > a.first__img[href]")
      .map((_, el): DiscoveredBookRef => {
        const href = $(el).attr("href") ?? "";
        const sourceUrl = new URL(href, this.baseUrl).toString();
        const sourceRef = href.replace(/^\/?catalogue\//, "").replace(/\/$/, "");
        return { sourceRef, sourceUrl };
      })
      .get();

    // Django-oscar's "pager" template: li.next only renders when
    // there's a next page (absent on the last of the 135 pages).
    const hasNextPage = $(".pager li.next a").length > 0;
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
    // itself carries current price, same as a fresh fetchBook(). There is
    // no numeric stock count anywhere on the page — only a real
    // buy-now/add-to-cart form (present on the one in-stock detail page
    // captured so far) vs. its absence, used here as the availability
    // signal until an actual out-of-stock page is captured to confirm it.
    const raw = await this.fetchBook(ref);
    const $ = cheerio.load(raw.raw as string);

    const price = parsePrice($);
    const inStock = $('form[action^="/kcbooks/buy-now/"], form[action^="/basket/add/"]').length > 0;

    return {
      sourceRef: ref.sourceRef,
      stock: null,
      price,
      currency: price !== null ? "INR" : null,
      availability: inStock ? "in_stock" : "out_of_stock",
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

    const title = $(".product__info__main h1").first().text().trim() || null;

    // Author lives inside a `.posted_in` span in `.product_meta`, as link
    // text — but the same markup repeats that span structure for the
    // book's category ("வகைமைகள்:"), so selection has to key off which
    // <strong> label precedes it, not just take the first `.posted_in`
    // match.
    const authorSpan = findPostedInByLabel($, "நூலாசிரியர்");
    // Extraction only — this is the raw author string as it appears on
    // the page (native script or already-romanized, whichever the
    // publisher uses). Transliteration to the canonical romanized form
    // and alias storage (SPEC-04 §14's "ஜெயமோகன்" -> "Jeyamohan" example,
    // catalog.author_aliases) is a duplicate-detection/editorial concern
    // that needs the database and a real transliteration engine — out of
    // scope for a reference HTML adapter, and authoritatively handled
    // server-side (apps/api-publisher-import), not here.
    const authorNames = authorSpan
      .find("a")
      .map((_, a) => $(a).text().trim())
      .get()
      .filter((name) => name.length > 0);

    const categorySpan = findPostedInByLabel($, "வகைமைகள்");
    const category = categorySpan.find("a").first().text().trim() || null;

    const price = parsePrice($);

    // Full description lives in the "About" tab (#nav-about), as one or
    // more <p> paragraphs — the truncated `.show-hide-text` blurb
    // elsewhere on the page is a "more" widget over the same text, not a
    // separate/shorter field worth preferring.
    const descriptionParagraphs = $("#nav-about .description__attribute p")
      .map((_, p) => $(p).text().trim())
      .get()
      .filter((text) => text.length > 0);
    const description =
      descriptionParagraphs.length > 0
        ? descriptionParagraphs.join("\n\n")
        : $(".product__overview .show-hide-text").first().text().trim() || null;

    // No dedicated cover-image element — the real page renders it inside
    // a Fotorama.js gallery widget.
    const coverSrc = $(".wn__fotorama__wrapper .fotorama img").first().attr("src");

    // ISBN and page count aren't dedicated elements either — they're
    // plain label-prefixed text lines in the "Detail" tab (#nav-details),
    // e.g. "ISBN  :  9789355234339" / "PAGES :  0", so they need text
    // parsing rather than a selector+attr read.
    let isbn13: string | null = null;
    let pageCount: number | null = null;
    $("#nav-details .description__attribute p").each((_, p) => {
      const text = $(p).text().trim();
      const isbnMatch = text.match(/ISBN\s*:?\s*(\d{13})/i);
      if (isbnMatch) {
        isbn13 = isbnMatch[1]!;
      }
      const pagesMatch = text.match(/PAGES\s*:?\s*(\d+)/i);
      // The site uses "0" as its "not tracked" convention for this field
      // (seen on a real book), not a genuine zero-page book — and
      // CanonicalBookSchema requires pageCount to be positive anyway, so
      // 0 maps to null rather than being passed through.
      if (pagesMatch && Number.parseInt(pagesMatch[1]!, 10) > 0) {
        pageCount = Number.parseInt(pagesMatch[1]!, 10);
      }
    });

    return {
      sourceRef: raw.sourceRef,
      isbn13,
      title,
      // No discoverable subtitle field on the real detail page — the
      // parenthesized suffix sometimes seen in the title (e.g.
      // "(இ-புத்தகம்)", "e-book") is a format label, not a subtitle.
      subtitle: null,
      authorNames,
      publisherName: "Kalachuvadu",
      description,
      // No per-book language field exists anywhere on the real detail
      // page — the whole storefront is Tamil-only, so this is a fixed
      // default rather than scraped.
      language: "ta",
      coverSourceUrl: coverSrc ? new URL(coverSrc, raw.sourceUrl).toString() : null,
      price,
      // No data-currency-style attribute on the real page, only a ₹
      // symbol in the price text — fixed default whenever a price was
      // actually found.
      currency: price !== null ? "INR" : null,
      stock: null, // fetchInventory() owns stock, not normalize() — SPEC-02's separate inventory table mirrors this split
      category,
      publicationDate: null, // no discoverable field on the real detail page
      editionLabel: null, // no discoverable field on the real detail page
      pageCount,
    };
  }

  validate(book: CanonicalBook): ValidationResult {
    return validateBookFields(book);
  }
}

// Same selector/markup used by both normalize() and fetchInventory() (each
// loads its own $ from a fresh cheerio.load()), so shared as module-level
// helpers rather than duplicated inline.

function parsePrice($: cheerio.CheerioAPI): number | null {
  const priceText = $(".price-box .price_color").first().text();
  const numeric = priceText.replace(/[^\d.]/g, "");
  if (!numeric) {
    return null;
  }
  const price = Number.parseFloat(numeric);
  return Number.isNaN(price) ? null : price;
}

// `.product_meta .posted_in` repeats (author, category, ...) — each one
// is distinguished only by its own <strong> label text, not by a
// dedicated class, so callers pass the label they're looking for (e.g.
// "நூலாசிரியர்:" for author).
function findPostedInByLabel($: cheerio.CheerioAPI, label: string) {
  return $(".product_meta .posted_in")
    .filter((_, el) => $(el).find("strong").first().text().trim().startsWith(label))
    .first();
}
