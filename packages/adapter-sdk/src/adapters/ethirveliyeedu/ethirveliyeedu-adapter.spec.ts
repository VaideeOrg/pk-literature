import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EthirveliyeeduAdapter } from "./ethirveliyeedu-adapter";

const FIXTURES_DIR = join(__dirname, "__fixtures__");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8"));
}

const BASE_URL = "https://ethirveliyeedu.example/collections/all/products.json";
const SITE_ROOT = "https://ethirveliyeedu.example";

// Keyed fake fetch returning parsed JSON — the fixtures are real JSON
// captured live from https://ethirveliyeedu.com/collections/all/products.json
// (see the adapter's own header comment), not hand-written.
function fakeFetch(responses: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!(url in responses)) {
      throw new Error(`fakeFetch: no fixture registered for ${url}`);
    }
    const body = responses[url];
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

const PAAMBU_REF = {
  sourceRef: "பாம்பு-மனிதன்-ரோமுலஸ்-விட்டேகர்-வாழ்க்கைப்-பயணம்",
  sourceUrl: `${SITE_ROOT}/products/பாம்பு-மனிதன்-ரோமுலஸ்-விட்டேகர்-வாழ்க்கைப்-பயணம்`,
};
const THIRTEEN_YEARS_REF = {
  sourceRef: "13-வருடங்கள்-ஒரு-நக்ஸலைட்டின்-சிறைக்-குறிப்புகள்",
  sourceUrl: `${SITE_ROOT}/products/13-வருடங்கள்-ஒரு-நக்ஸலைட்டின்-சிறைக்-குறிப்புகள்`,
};

describe("EthirveliyeeduAdapter", () => {
  describe("discover", () => {
    it("returns refs for Books-typed products only, and a next-page cursor", async () => {
      const adapter = new EthirveliyeeduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [`${BASE_URL}?limit=250&page=1`]: fixture("listing-page-1.json"),
        }),
      });

      const result = await adapter.discover(null);

      // "Indian Heritages" (product_type: "") is deliberately excluded —
      // per product decision, a blank product_type is left out, not
      // guessed at.
      expect(result.refs).toEqual([PAAMBU_REF, THIRTEEN_YEARS_REF]);
      expect(result.nextPageCursor).toBe("2");
    });

    it("returns a null cursor once a page comes back empty", async () => {
      const adapter = new EthirveliyeeduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({
          [`${BASE_URL}?limit=250&page=2`]: fixture("listing-page-2-empty.json"),
        }),
      });

      const result = await adapter.discover("2");

      expect(result.refs).toEqual([]);
      expect(result.nextPageCursor).toBeNull();
    });
  });

  describe("fetchBook + normalize", () => {
    it("normalizes a product cached by discover() without a second HTTP call", async () => {
      const fetchImpl = fakeFetch({
        [`${BASE_URL}?limit=250&page=1`]: fixture("listing-page-1.json"),
      });
      const adapter = new EthirveliyeeduAdapter({ baseUrl: BASE_URL, fetchImpl });

      await adapter.discover(null);
      // fetchBook() below must resolve from discover()'s cache — fakeFetch
      // has no fixture registered for a per-product detail URL, so a
      // second network call here would throw and fail this test.
      const raw = await adapter.fetchBook(PAAMBU_REF);
      const book = adapter.normalize(raw);

      expect(book).toEqual({
        sourceRef: PAAMBU_REF.sourceRef,
        sourceSku: null, // variant sku is "" on this product
        isbn13: null, // no ISBN label on this product
        title: "'பாம்பு மனிதன்' ரோமுலஸ் விட்டேகர்: வாழ்க்கைப் பயணம்",
        subtitle: null,
        authorNames: ["ஸாய் விட்டேகர்"],
        publisherName: "Vaanathi", // vendor differs from the site's own name — confirms it's a marketplace
        description:
          "சென்னை கிண்டி சிறுவர் பூங்காவை அடுத்துள்ள ‘பாம்புப் பண்ணை’யைப் பற்றி அறிபாதவர்கள் சொற்பமாகவே இருப்பார்கள். இதையும் கிழக்குக் கடற்கரைச் சாலையில் உள்ள புகழ்பெற்ற ‘சென்னை முதலைப் பண்ணை’யையும் நிறுவியவர் ரோமுலஸ் விட்டேகர். ஒரு தனிநபரின் வாழ்க்கை வரலாறு என்று இந்த நூலைச் சொல்ல முடியாது. இயற்கை வரலாற்றுப் புத்தகம் என்று சொல்வதுதான் சரியாக இருக்கும். அதிலும் தமிழகத்தை மையமாகக்கொண்டு பணியாற்றிய உலகறிந்த ஓர் அறிஞரின் வரலாறு இது. தமிழகப் பழங்குடிகளுடன் உறவாடி, இயற்கைச் சூழலைக் குறித்த புரிதலை மாநில-தேசிய-சர்வதேச அளவில் ஏற்படுத்திய ஒருவரைப் பற்றிய நூல் தமிழில் வெளியாவது குறிப்பிடத்தக்கது. முற்றிலும் புதியதோர் உலகை இந்த நூல் திறந்து காட்டுகிறது.",
        language: "ta",
        coverSourceUrl: "https://cdn.shopify.com/s/files/1/0614/9003/6890/files/paambu.jpg?v=1702128497",
        price: 500,
        currency: "INR",
        stock: null,
        category: "சூழலியல் / வாழ்க்கை வரலாறு",
        publicationDate: null,
        editionLabel: "Paperback",
        pageCount: null,
      });
    });

    it("drops translator info entirely and never derives isbn13 from sourceSku", async () => {
      const fetchImpl = fakeFetch({
        [`${BASE_URL}?limit=250&page=1`]: fixture("listing-page-1.json"),
      });
      const adapter = new EthirveliyeeduAdapter({ baseUrl: BASE_URL, fetchImpl });

      await adapter.discover(null);
      const raw = await adapter.fetchBook(THIRTEEN_YEARS_REF);
      const book = adapter.normalize(raw);

      // This product's variant.sku ("9789387333697") looks like a valid
      // ISBN but has no explicit "ISBN:" label anywhere on the page —
      // isbn13 must stay null, sourceSku carries the raw sku separately.
      expect(book.sourceSku).toBe("9789387333697");
      expect(book.isbn13).toBeNull();
      expect(book.authorNames).toEqual(["ராம்சந்த்ரா சிங்"]);
      expect(book.category).toBe("தன்வரலாறு");
      expect(book.language).toBe("ta");
      expect(book.editionLabel).toBe("Paperback");
      // Translator ("இரா.செந்தில்") must not surface anywhere, including description.
      expect(book.description).not.toContain("இரா.செந்தில்");
      expect(book.description).not.toContain("Translator");
    });

    it("extracts isbn13 from an explicit ISBN label even when sourceSku is empty", async () => {
      // Exercises fetchBook()'s cache-miss fallback path (no prior
      // discover() call in this adapter instance) against Shopify's
      // standard single-product JSON endpoint.
      const detailUrl = `${SITE_ROOT}/products/indian-heritages.json`;
      const adapter = new EthirveliyeeduAdapter({
        baseUrl: BASE_URL,
        fetchImpl: fakeFetch({ [detailUrl]: fixture("product-indian-heritages.json") }),
      });

      const raw = await adapter.fetchBook({ sourceRef: "indian-heritages", sourceUrl: `${SITE_ROOT}/products/indian-heritages` });
      const book = adapter.normalize(raw);

      expect(book.isbn13).toBe("9789348598271");
      expect(book.sourceSku).toBeNull();
      expect(book.authorNames).toEqual(["Yusuf Madhiya"]);
      expect(book.language).toBe("en");
      expect(book.category).toBe("Art And History");
      expect(book.editionLabel).toBe("Paperback");
      expect(book.publisherName).toBe("Ethir Veliyeedu");
    });
  });

  describe("fetchInventory", () => {
    it("reports out_of_stock when the variant's available flag is false", async () => {
      const fetchImpl = fakeFetch({
        [`${BASE_URL}?limit=250&page=1`]: fixture("listing-page-1.json"),
      });
      const adapter = new EthirveliyeeduAdapter({ baseUrl: BASE_URL, fetchImpl });

      await adapter.discover(null);
      const inventory = await adapter.fetchInventory(PAAMBU_REF);

      expect(inventory).toEqual({
        sourceRef: PAAMBU_REF.sourceRef,
        stock: null,
        price: 500,
        currency: "INR",
        availability: "out_of_stock",
      });
    });

    it("reports in_stock when the variant's available flag is true", async () => {
      const fetchImpl = fakeFetch({
        [`${BASE_URL}?limit=250&page=1`]: fixture("listing-page-1.json"),
      });
      const adapter = new EthirveliyeeduAdapter({ baseUrl: BASE_URL, fetchImpl });

      await adapter.discover(null);
      const inventory = await adapter.fetchInventory(THIRTEEN_YEARS_REF);

      expect(inventory).toEqual({
        sourceRef: THIRTEEN_YEARS_REF.sourceRef,
        stock: null,
        price: 243,
        currency: "INR",
        availability: "in_stock",
      });
    });
  });

  describe("validate", () => {
    it("delegates to the shared field validator", async () => {
      const fetchImpl = fakeFetch({
        [`${BASE_URL}?limit=250&page=1`]: fixture("listing-page-1.json"),
      });
      const adapter = new EthirveliyeeduAdapter({ baseUrl: BASE_URL, fetchImpl });

      await adapter.discover(null);
      const raw = await adapter.fetchBook(PAAMBU_REF);
      const book = adapter.normalize(raw);
      const result = adapter.validate(book);

      // Missing ISBN is a warning, not an error (validateBookFields) —
      // this product legitimately has none.
      expect(result.hasErrors).toBe(false);
    });
  });
});
