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
        { sourceRef: "vishnupuram", sourceUrl: `${BASE_URL}/books/vishnupuram` },
        { sourceRef: "kanyakumari", sourceUrl: `${BASE_URL}/books/kanyakumari` },
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
        { sourceRef: "ezhaam-ulagam", sourceUrl: `${BASE_URL}/books/ezhaam-ulagam` },
      ]);
      expect(result.nextPageCursor).toBeNull();
    });
  });

  describe("fetchBook + normalize", () => {
    it("extracts a canonical book from a detail page", async () => {
      const detailUrl = `${BASE_URL}/books/vishnupuram`;
      const adapter = new KalachuvaduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [detailUrl]: { body: fixture("book-detail-vishnupuram.html") },
        }),
      });

      const raw = await adapter.fetchBook({ sourceRef: "vishnupuram", sourceUrl: detailUrl });
      const book = adapter.normalize(raw);

      expect(book).toEqual({
        sourceRef: "vishnupuram",
        isbn13: "9781234567890",
        title: "Vishnupuram",
        subtitle: "Part One",
        authorNames: ["Jeyamohan"],
        publisherName: "Kalachuvadu",
        description: "A landmark work of Tamil literature.",
        language: "ta",
        coverSourceUrl: `${BASE_URL}/covers/vishnupuram.jpg`,
        price: 450,
        currency: "INR",
        stock: null,
        category: "Novel",
        publicationDate: "2020-01-01",
        editionLabel: "2nd Edition",
        pageCount: 620,
      });
    });

    it("normalizes a multi-author byline into separate names", async () => {
      const detailUrl = `${BASE_URL}/books/co-authored`;
      const adapter = new KalachuvaduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [detailUrl]: {
            body: `<div class="book-detail">
              <h1 class="book-title">Co-authored Book</h1>
              <div class="book-author">Author One, Author Two and Author Three</div>
            </div>`,
          },
        }),
      });

      const raw = await adapter.fetchBook({ sourceRef: "co-authored", sourceUrl: detailUrl });
      const book = adapter.normalize(raw);

      expect(book.authorNames).toEqual(["Author One", "Author Two", "Author Three"]);
    });
  });

  describe("fetchInventory", () => {
    it("derives availability from stock", async () => {
      const detailUrl = `${BASE_URL}/books/vishnupuram`;
      const adapter = new KalachuvaduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [detailUrl]: { body: fixture("book-detail-vishnupuram.html") },
        }),
      });

      const inventory = await adapter.fetchInventory({ sourceRef: "vishnupuram", sourceUrl: detailUrl });

      expect(inventory).toEqual({
        sourceRef: "vishnupuram",
        stock: 12,
        price: 450,
        currency: "INR",
        availability: "in_stock",
      });
    });
  });

  describe("validate", () => {
    it("delegates to the shared field validator", async () => {
      const detailUrl = `${BASE_URL}/books/vishnupuram`;
      const adapter = new KalachuvaduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [detailUrl]: { body: fixture("book-detail-vishnupuram.html") },
        }),
      });

      const raw = await adapter.fetchBook({ sourceRef: "vishnupuram", sourceUrl: detailUrl });
      const book = adapter.normalize(raw);
      const result = adapter.validate(book);

      expect(result.hasErrors).toBe(false);
    });
  });
});
