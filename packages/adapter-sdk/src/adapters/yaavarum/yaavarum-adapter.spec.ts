import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YaavarumAdapter } from "./yaavarum-adapter";

const FIXTURES_DIR = join(__dirname, "__fixtures__");

function jsonFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8"));
}
function htmlFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

const BASE_URL = "https://yaavarum.example/collections/all/products.json";
const SITE_ROOT = "https://yaavarum.example";

// Keyed fake fetch returning either JSON or raw HTML text, matching
// whichever the real fetch would be used for at that URL.
function fakeFetch(responses: Record<string, { json?: unknown; text?: string }>): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const entry = responses[url];
    if (!entry) {
      throw new Error(`fakeFetch: no fixture registered for ${url}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => entry.json,
      text: async () => entry.text ?? "",
    } as unknown as Response;
  }) as typeof fetch;
}

const FILMLANG_REF = { sourceRef: "21stcentfilmlang", sourceUrl: `${SITE_ROOT}/products/21stcentfilmlang` };
const AMBU_REF = { sourceRef: "ambu-padukkai", sourceUrl: `${SITE_ROOT}/products/ambu-padukkai` };

describe("YaavarumAdapter", () => {
  describe("discover", () => {
    it("returns refs for every non-blank product_type, and a next-page cursor", async () => {
      const adapter = new YaavarumAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [`${BASE_URL}?limit=250&page=1`]: { json: jsonFixture("listing-page-1.json") },
        }),
      });

      const result = await adapter.discover(null);

      // The fixture's third entry (blank product_type) is a synthetic
      // addition to exercise this exclusion rule - it's deliberately
      // excluded, unlike Ethirveliyeedu's exact "Books" match, this
      // adapter only excludes a blank product_type (per product decision).
      expect(result.refs).toEqual([FILMLANG_REF, AMBU_REF]);
      expect(result.nextPageCursor).toBe("2");
    });

    it("returns a null cursor once a page comes back empty", async () => {
      const adapter = new YaavarumAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [`${BASE_URL}?limit=250&page=2`]: { json: jsonFixture("listing-page-2-empty.json") },
        }),
      });

      const result = await adapter.discover("2");

      expect(result.refs).toEqual([]);
      expect(result.nextPageCursor).toBeNull();
    });
  });

  describe("fetchBook + normalize", () => {
    it("merges cached listing JSON with the rendered page's author block", async () => {
      // This pairs a real listing-JSON entry (21stcentfilmlang) with a
      // real, but unrelated, captured product-detail HTML fragment
      // (product-detail-ulagam.html, a different real book) purely to
      // exercise the JSON+HTML merge/extraction logic - not a claim
      // these two are the same book. See the adapter's own header
      // comment on why fetchBook() needs a real second request here.
      const detailHtml = htmlFixture("product-detail-ulagam.html");
      const adapter = new YaavarumAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [`${BASE_URL}?limit=250&page=1`]: { json: jsonFixture("listing-page-1.json") },
          [FILMLANG_REF.sourceUrl]: { text: detailHtml },
        }),
      });

      await adapter.discover(null);
      const raw = await adapter.fetchBook(FILMLANG_REF);
      const book = adapter.normalize(raw);

      expect(book).toEqual({
        sourceRef: FILMLANG_REF.sourceRef,
        sourceSku: null, // variant.sku is null in the feed
        isbn13: null,
        title: "21 ஆம் நூற்றாண்டின் திரைமொழி", // from the cached JSON, not the HTML fragment's own title
        subtitle: null,
        authorNames: ["தமிழவன்"], // extracted from the HTML fragment's ai-author-link block
        publisherName: "Yaavarum Publishers",
        // No space between the two sentences - the source has no
        // whitespace text node across the <br><br> that separates them.
        description:
          "ஒருபக்கம் கடந்த இருபது ஆண்டுகளாக உலக சினிமாவைப் பார்க்கும் பார்வையாளனாகவும், மறுபக்கம் திரைப்படம் எடுக்கவிருக்கும் மனதுடையவனாகவும் என இவை என்னுள் இருவேறு துருவங்களாக தங்களின் எல்லையை விரிவுபடுத்திக்கொண்டே இருக்கின்றனர்.கலை உனக்கு விருப்பட்ட திசைகளில் திரும்பும் ஆகையால் மகிழாதே, அது உன் எதிரிக்கும் பொருந்தும்.",
        language: "ta",
        coverSourceUrl: "https://cdn.shopify.com/s/files/1/0747/0553/5139/files/thiraimozhi.jpg?v=1782911797",
        price: 250,
        currency: "INR",
        stock: null,
        category: null,
        publicationDate: null,
        editionLabel: null,
        pageCount: null,
      });
    });

    it("returns an empty authorNames array when the page has no author block", async () => {
      const adapter = new YaavarumAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [`${BASE_URL}?limit=250&page=1`]: { json: jsonFixture("listing-page-1.json") },
          [AMBU_REF.sourceUrl]: { text: htmlFixture("product-detail-no-author.html") },
        }),
      });

      await adapter.discover(null);
      const raw = await adapter.fetchBook(AMBU_REF);
      const book = adapter.normalize(raw);

      expect(book.authorNames).toEqual([]);
    });
  });

  describe("fetchInventory", () => {
    it("reads price/availability from the cached JSON without a detail-page fetch", async () => {
      const adapter = new YaavarumAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [`${BASE_URL}?limit=250&page=1`]: { json: jsonFixture("listing-page-1.json") },
        }),
      });

      await adapter.discover(null);
      // No fixture registered for a detail-page URL here - if
      // fetchInventory() tried to fetch one it would throw and fail
      // this test, proving it only reads the cached JSON.
      const inventory = await adapter.fetchInventory(FILMLANG_REF);

      expect(inventory).toEqual({
        sourceRef: FILMLANG_REF.sourceRef,
        stock: null,
        price: 250,
        currency: "INR",
        availability: "in_stock",
      });
    });
  });

  describe("validate", () => {
    it("has no errors for a book with an author, despite missing isbn/genre/edition", async () => {
      const adapter = new YaavarumAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [`${BASE_URL}?limit=250&page=1`]: { json: jsonFixture("listing-page-1.json") },
          [FILMLANG_REF.sourceUrl]: { text: htmlFixture("product-detail-ulagam.html") },
        }),
      });

      await adapter.discover(null);
      const raw = await adapter.fetchBook(FILMLANG_REF);
      const book = adapter.normalize(raw);
      const result = adapter.validate(book);

      expect(result.hasErrors).toBe(false);
    });

    it("has an error for a book with no discoverable author", async () => {
      const adapter = new YaavarumAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [`${BASE_URL}?limit=250&page=1`]: { json: jsonFixture("listing-page-1.json") },
          [AMBU_REF.sourceUrl]: { text: htmlFixture("product-detail-no-author.html") },
        }),
      });

      await adapter.discover(null);
      const raw = await adapter.fetchBook(AMBU_REF);
      const book = adapter.normalize(raw);
      const result = adapter.validate(book);

      expect(result.hasErrors).toBe(true);
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "missing_author" }));
    });
  });
});
