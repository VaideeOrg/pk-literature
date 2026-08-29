import { validateBookFields } from "../validate";
import type { CanonicalBook } from "../types";

const validBook: CanonicalBook = {
  sourceRef: "book-1",
  sourceSku: null,
  isbn13: "9781234567890",
  title: "Vishnupuram",
  subtitle: null,
  authorNames: ["Jeyamohan"],
  publisherName: "Kalachuvadu",
  description: "A novel.",
  language: "ta",
  coverSourceUrl: "https://example.com/cover.jpg",
  price: 450,
  currency: "INR",
  stock: 10,
  category: "Novel",
  publicationDate: "2020-01-01",
  editionLabel: null,
  pageCount: 620,
};

describe("validateBookFields", () => {
  it("passes a fully populated book with no issues", () => {
    const result = validateBookFields(validBook);
    expect(result.hasErrors).toBe(false);
    expect(result.issues).toHaveLength(0);
  });

  it("errors on missing title/author/language - promote-staging-book can't create a Work/Book without them", () => {
    const result = validateBookFields({
      ...validBook,
      title: null,
      authorNames: [],
      language: null,
    });

    expect(result.hasErrors).toBe(true);
    for (const code of ["missing_title", "missing_author", "missing_language"]) {
      expect(result.issues).toContainEqual(expect.objectContaining({ severity: "error", code }));
    }
  });

  it("warns (not errors) on missing publisher/price/cover - promote-staging-book degrades gracefully without them", () => {
    const result = validateBookFields({
      ...validBook,
      publisherName: null,
      price: null,
      coverSourceUrl: null,
    });

    expect(result.hasErrors).toBe(false);
    for (const code of ["missing_publisher", "missing_price", "missing_cover"]) {
      expect(result.issues).toContainEqual(expect.objectContaining({ severity: "warning", code }));
    }
  });

  it("warns (not errors) on a missing ISBN", () => {
    const result = validateBookFields({ ...validBook, isbn13: null });
    expect(result.hasErrors).toBe(false);
    expect(result.issues).toEqual([{ severity: "warning", code: "missing_isbn", message: expect.any(String) }]);
  });

  it("errors on a malformed ISBN", () => {
    const result = validateBookFields({ ...validBook, isbn13: "not-an-isbn" });
    expect(result.hasErrors).toBe(true);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "invalid_isbn" }),
    );
  });

  it("warns (not errors) on an unrecognized currency", () => {
    const result = validateBookFields({ ...validBook, currency: "XXX" });
    expect(result.hasErrors).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "invalid_currency" }),
    );
  });

  it("warns (not errors) on a missing description", () => {
    const result = validateBookFields({ ...validBook, description: null });
    expect(result.hasErrors).toBe(false);
    expect(result.issues).toEqual([
      { severity: "warning", code: "missing_description", message: expect.any(String) },
    ]);
  });
});
