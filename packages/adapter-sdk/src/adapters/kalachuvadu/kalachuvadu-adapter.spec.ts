import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KalachuvaduAdapter } from "./kalachuvadu-adapter";

const FIXTURES_DIR = join(__dirname, "__fixtures__");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

const BASE_URL = "https://kalachuvadu.example";

// Keyed fake fetch — the fixtures stand in for real HTTP responses so
// this test never makes a real network call (see the adapter's own
// header comment: these selectors/fixtures are illustrative, not
// scraped from the live site).
function fakeFetch(responses: Record<string, { body: string; contentType?: string }>): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = responses[url];
    if (!match) {
      throw new Error(`fakeFetch: no fixture registered for ${url}`);
    }
    return {
      ok: true,
      status: 200,
      text: async () => match.body,
      arrayBuffer: async () => new TextEncoder().encode(match.body).buffer,
      headers: { get: (name: string) => (name === "content-type" ? (match.contentType ?? "text/html") : null) },
    } as unknown as Response;
  }) as typeof fetch;
}

describe("KalachuvaduAdapter", () => {
  describe("discover", () => {
    it("returns refs from page 1 and a next-page cursor", async () => {
      const adapter = new KalachuvaduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [`${BASE_URL}?page=1`]: { body: fixture("listing-page-1.html") },
        }),
      });

      const result = await adapter.discover(null);

      expect(result.refs).toEqual([
        { sourceRef: "vishnupuram_1001", sourceUrl: `${BASE_URL}/catalogue/vishnupuram_1001/` },
        { sourceRef: "kanyakumari_1002", sourceUrl: `${BASE_URL}/catalogue/kanyakumari_1002/` },
      ]);
      expect(result.nextPageCursor).toBe("2");
    });

    it("returns a null cursor on the last page", async () => {
      const adapter = new KalachuvaduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [`${BASE_URL}?page=2`]: { body: fixture("listing-page-2.html") },
        }),
      });

      const result = await adapter.discover("2");

      expect(result.refs).toEqual([
        { sourceRef: "ezhaam-ulagam_1003", sourceUrl: `${BASE_URL}/catalogue/ezhaam-ulagam_1003/` },
      ]);
      expect(result.nextPageCursor).toBeNull();
    });
  });

  describe("fetchBook + normalize", () => {
    it("extracts a canonical book from a real detail page", async () => {
      const detailUrl = `${BASE_URL}/catalogue/gandhi1915thirumbivanthamynthan_2068/`;
      const adapter = new KalachuvaduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [detailUrl]: { body: fixture("book-detail-gandhi1915.html") },
        }),
      });

      const raw = await adapter.fetchBook({ sourceRef: "gandhi1915thirumbivanthamynthan_2068", sourceUrl: detailUrl });
      const book = adapter.normalize(raw);

      expect(book).toEqual({
        sourceRef: "gandhi1915thirumbivanthamynthan_2068",
        isbn13: "9789355234339",
        title: "காந்தி 1915: திரும்பி வந்த மைந்தன் (இ-புத்தகம்)",
        subtitle: null,
        authorNames: ["என். சொக்கன்"],
        publisherName: "Kalachuvadu",
        description:
          "காந்தியின் 1915ஆம் ஆண்டு தென்னாப்பிரிக்காவிலிருந்து இந்தியா திரும்பிய பயணத்தை விவரிக்கும் நூல்.\n\nஇந்நூல் காந்தியின் வாழ்க்கையில் ஒரு முக்கியமான கட்டத்தை ஆவணப்படுத்துகிறது.",
        language: "ta",
        coverSourceUrl: `${BASE_URL}/media/cache/91/fb/91fbeb17515ff943f856ebf4f79598f2.jpg`,
        price: 269.04,
        currency: "INR",
        stock: null,
        category: "இ-புத்தகங்கள்",
        publicationDate: null,
        editionLabel: null,
        pageCount: null, // real page shows "PAGES: 0" — the site's "not tracked" convention, not a genuine zero-page book
      });
    });

    it("normalizes a multi-author byline into separate names", async () => {
      const detailUrl = `${BASE_URL}/catalogue/co-authored_9999/`;
      const adapter = new KalachuvaduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [detailUrl]: {
            body: `<div class="product__info__main"><h1>Co-authored Book</h1></div>
              <div class="product_meta">
                <span class="posted_in"><strong>நூலாசிரியர்:</strong>
                  <a href="/kcbooks/AuthorDetailView/a_1/">Author One</a>,
                  <a href="/kcbooks/AuthorDetailView/a_2/">Author Two</a>,
                  <a href="/kcbooks/AuthorDetailView/a_3/">Author Three</a>
                </span>
              </div>`,
          },
        }),
      });

      const raw = await adapter.fetchBook({ sourceRef: "co-authored_9999", sourceUrl: detailUrl });
      const book = adapter.normalize(raw);

      expect(book.authorNames).toEqual(["Author One", "Author Two", "Author Three"]);
    });
  });

  describe("fetchInventory", () => {
    it("reports in_stock when a buy-now/add-to-cart form is present", async () => {
      const detailUrl = `${BASE_URL}/catalogue/gandhi1915thirumbivanthamynthan_2068/`;
      const adapter = new KalachuvaduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [detailUrl]: { body: fixture("book-detail-gandhi1915.html") },
        }),
      });

      const inventory = await adapter.fetchInventory({
        sourceRef: "gandhi1915thirumbivanthamynthan_2068",
        sourceUrl: detailUrl,
      });

      expect(inventory).toEqual({
        sourceRef: "gandhi1915thirumbivanthamynthan_2068",
        stock: null,
        price: 269.04,
        currency: "INR",
        availability: "in_stock",
      });
    });

    it("reports out_of_stock when no buy-now/add-to-cart form is present", async () => {
      const detailUrl = `${BASE_URL}/catalogue/ezhaam-ulagam_1003/`;
      const adapter = new KalachuvaduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [detailUrl]: { body: fixture("book-detail-out-of-stock.html") },
        }),
      });

      const inventory = await adapter.fetchInventory({ sourceRef: "ezhaam-ulagam_1003", sourceUrl: detailUrl });

      expect(inventory).toEqual({
        sourceRef: "ezhaam-ulagam_1003",
        stock: null,
        price: 150,
        currency: "INR",
        availability: "out_of_stock",
      });
    });
  });

  describe("validate", () => {
    it("delegates to the shared field validator", async () => {
      const detailUrl = `${BASE_URL}/catalogue/gandhi1915thirumbivanthamynthan_2068/`;
      const adapter = new KalachuvaduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [detailUrl]: { body: fixture("book-detail-gandhi1915.html") },
        }),
      });

      const raw = await adapter.fetchBook({
        sourceRef: "gandhi1915thirumbivanthamynthan_2068",
        sourceUrl: detailUrl,
      });
      const book = adapter.normalize(raw);
      const result = adapter.validate(book);

      expect(result.hasErrors).toBe(false);
    });
  });
});
