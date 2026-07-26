import type { CanonicalBook, PublisherAdapter } from "@pk-literature/adapter-sdk";
import { runImport } from "../run-import";
import type { StagingIngestClient } from "../staging-ingest-client";

function makeBook(sourceRef: string, overrides: Partial<CanonicalBook> = {}): CanonicalBook {
  return {
    sourceRef,
    isbn13: "9781234567890",
    title: "Some Title",
    subtitle: null,
    authorNames: ["Some Author"],
    publisherName: "Kalachuvadu",
    description: "desc",
    language: "ta",
    coverSourceUrl: null,
    price: 100,
    currency: "INR",
    stock: null,
    category: null,
    publicationDate: null,
    editionLabel: null,
    pageCount: null,
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<PublisherAdapter> = {}): PublisherAdapter {
  return {
    publisherCode: "test-publisher",
    discover: jest.fn().mockResolvedValue({ refs: [], nextPageCursor: null }),
    fetchBooks: jest.fn().mockResolvedValue([]),
    fetchBook: jest.fn().mockImplementation((ref) => Promise.resolve({ sourceRef: ref.sourceRef, sourceUrl: ref.sourceUrl, raw: {} })),
    fetchInventory: jest
      .fn()
      .mockResolvedValue({ sourceRef: "x", stock: 5, price: 100, currency: "INR", availability: "in_stock" }),
    downloadCover: jest
      .fn()
      .mockResolvedValue({ sourceUrl: "https://example.com/c.jpg", contentType: "image/jpeg", bytes: Buffer.from("x"), widthPx: null, heightPx: null }),
    normalize: jest.fn().mockImplementation((raw) => makeBook(raw.sourceRef)),
    validate: jest.fn().mockReturnValue({ issues: [], hasErrors: false }),
    ...overrides,
  };
}

function makeClient(overrides: Partial<StagingIngestClient> = {}): StagingIngestClient {
  return {
    getCursor: jest.fn().mockResolvedValue({ cursor: null, lastImportAt: null }),
    startImportRun: jest.fn().mockResolvedValue({ runId: "run-1" }),
    submitBook: jest.fn().mockResolvedValue({ stagingBookId: "sb-1", status: "pending_validation", issues: [] }),
    completeImportRun: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const silentLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe("runImport", () => {
  it("processes all discovered refs and completes successfully", async () => {
    const adapter = makeAdapter({
      discover: jest
        .fn()
        .mockResolvedValueOnce({
          refs: [
            { sourceRef: "book-1", sourceUrl: "https://x/1" },
            { sourceRef: "book-2", sourceUrl: "https://x/2" },
          ],
          nextPageCursor: null,
        }),
    });
    const client = makeClient();

    const summary = await runImport({
      publisherId: "pub-1",
      trigger: "manual",
      adapter,
      client,
      logger: silentLogger,
    });

    expect(summary.status).toBe("completed");
    expect(summary.booksProcessed).toBe(2);
    expect(summary.booksFailed).toBe(0);
    expect(client.submitBook).toHaveBeenCalledTimes(2);
    expect(client.completeImportRun).toHaveBeenCalledWith("run-1", "completed", expect.any(String), null);
  });

  it("follows pagination across multiple pages", async () => {
    const adapter = makeAdapter({
      discover: jest
        .fn()
        .mockResolvedValueOnce({ refs: [{ sourceRef: "book-1", sourceUrl: "https://x/1" }], nextPageCursor: "2" })
        .mockResolvedValueOnce({ refs: [{ sourceRef: "book-2", sourceUrl: "https://x/2" }], nextPageCursor: null }),
    });
    const client = makeClient();

    const summary = await runImport({ publisherId: "pub-1", trigger: "scheduled", adapter, client, logger: silentLogger });

    expect(adapter.discover).toHaveBeenCalledTimes(2);
    expect(summary.booksProcessed).toBe(2);
  });

  it("marks the run partially_failed when some books fail after retries", async () => {
    const adapter = makeAdapter({
      discover: jest.fn().mockResolvedValueOnce({
        refs: [
          { sourceRef: "book-1", sourceUrl: "https://x/1" },
          { sourceRef: "book-2", sourceUrl: "https://x/2" },
        ],
        nextPageCursor: null,
      }),
      fetchBook: jest
        .fn()
        .mockResolvedValueOnce({ sourceRef: "book-1", sourceUrl: "https://x/1", raw: {} })
        .mockRejectedValue(new Error("network error")),
    });
    const client = makeClient();

    const summary = await runImport({
      publisherId: "pub-1",
      trigger: "manual",
      adapter,
      client,
      logger: silentLogger,
    });

    expect(summary.status).toBe("partially_failed");
    expect(summary.booksProcessed).toBe(1);
    expect(summary.booksFailed).toBe(1);
    expect(client.completeImportRun).toHaveBeenCalledWith("run-1", "partially_failed", expect.any(String), null);
  });

  it("marks the run failed and skips the cursor write-back when discover() fails entirely", async () => {
    const adapter = makeAdapter({
      discover: jest.fn().mockRejectedValue(new Error("site is down")),
    });
    const client = makeClient();

    const summary = await runImport({ publisherId: "pub-1", trigger: "manual", adapter, client, logger: silentLogger });

    expect(summary.status).toBe("failed");
    expect(client.completeImportRun).toHaveBeenCalledWith("run-1", "failed", null, "site is down");
  });

  it("downloads and forwards the cover when the book has one", async () => {
    const adapter = makeAdapter({
      discover: jest
        .fn()
        .mockResolvedValueOnce({ refs: [{ sourceRef: "book-1", sourceUrl: "https://x/1" }], nextPageCursor: null }),
      normalize: jest.fn().mockReturnValue(makeBook("book-1", { coverSourceUrl: "https://x/cover.jpg" })),
    });
    const client = makeClient();

    await runImport({ publisherId: "pub-1", trigger: "manual", adapter, client, logger: silentLogger });

    expect(adapter.downloadCover).toHaveBeenCalledWith("https://x/cover.jpg");
    expect(client.submitBook).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ sourceRef: "book-1" }),
      expect.objectContaining({ sourceUrl: "https://example.com/c.jpg", contentType: "image/jpeg" }),
    );
  });

  it("does not download a cover when the book has none", async () => {
    const adapter = makeAdapter({
      discover: jest
        .fn()
        .mockResolvedValueOnce({ refs: [{ sourceRef: "book-1", sourceUrl: "https://x/1" }], nextPageCursor: null }),
    });
    const client = makeClient();

    await runImport({ publisherId: "pub-1", trigger: "manual", adapter, client, logger: silentLogger });

    expect(adapter.downloadCover).not.toHaveBeenCalled();
    expect(client.submitBook).toHaveBeenCalledWith("run-1", expect.anything(), null);
  });

  describe("maxBooks", () => {
    it("stops mid-page once the limit is reached", async () => {
      const adapter = makeAdapter({
        discover: jest.fn().mockResolvedValueOnce({
          refs: [
            { sourceRef: "book-1", sourceUrl: "https://x/1" },
            { sourceRef: "book-2", sourceUrl: "https://x/2" },
            { sourceRef: "book-3", sourceUrl: "https://x/3" },
          ],
          nextPageCursor: null,
        }),
      });
      const client = makeClient();

      const summary = await runImport({
        publisherId: "pub-1",
        trigger: "manual",
        adapter,
        client,
        logger: silentLogger,
        maxBooks: 2,
      });

      expect(summary.status).toBe("completed");
      expect(summary.booksProcessed).toBe(2);
      expect(client.submitBook).toHaveBeenCalledTimes(2);
    });

    it("stops across pages once the limit is reached, without fetching further pages", async () => {
      const discover = jest
        .fn()
        .mockResolvedValueOnce({ refs: [{ sourceRef: "book-1", sourceUrl: "https://x/1" }], nextPageCursor: "2" })
        .mockResolvedValueOnce({
          refs: [
            { sourceRef: "book-2", sourceUrl: "https://x/2" },
            { sourceRef: "book-3", sourceUrl: "https://x/3" },
          ],
          nextPageCursor: "3",
        });
      const adapter = makeAdapter({ discover });
      const client = makeClient();

      const summary = await runImport({
        publisherId: "pub-1",
        trigger: "manual",
        adapter,
        client,
        logger: silentLogger,
        maxBooks: 2,
      });

      expect(summary.booksProcessed).toBe(2);
      expect(discover).toHaveBeenCalledTimes(2);
    });

    it("does not advance the cursor when the run was cut short by the limit", async () => {
      const adapter = makeAdapter({
        discover: jest.fn().mockResolvedValueOnce({
          refs: [
            { sourceRef: "book-1", sourceUrl: "https://x/1" },
            { sourceRef: "book-2", sourceUrl: "https://x/2" },
          ],
          nextPageCursor: null,
        }),
      });
      const client = makeClient();

      await runImport({
        publisherId: "pub-1",
        trigger: "manual",
        adapter,
        client,
        logger: silentLogger,
        maxBooks: 1,
      });

      expect(client.completeImportRun).toHaveBeenCalledWith("run-1", "completed", null, null);
    });
  });
});
