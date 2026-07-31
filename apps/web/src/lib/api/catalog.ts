import type { GetBookResponse, ListBooksResponse } from "@pk-literature/contracts";
import type { BookCard, BookListItem } from "@pk-literature/domain-types";
import type { Fetcher } from "./fetcher";
import { toQueryString } from "./fetcher";

// apps/api-catalog — read-only (SPEC-02). Routed through the same
// shared API Gateway as every other service (ANY /v1/books/{proxy+}).
export function getBook(fetcher: Fetcher, bookId: string): Promise<GetBookResponse> {
  return fetcher(`/v1/books/${bookId}`);
}

export interface ListBooksParams {
  page?: number;
  pageSize?: number;
}

// api-catalog's list endpoint returns the full BookListItem shape
// (work/publisher objects, nested inventory) rather than the lighter
// BookCard shape apps/api-feed and apps/api-search return — map it here
// so callers can render results with the same <BookCard> component
// already used by the feed and search pages.
function bookListItemToCard(item: BookListItem): BookCard {
  return {
    id: item.id,
    title: item.title,
    authorName: item.work.authors[0]?.author.canonicalName ?? null,
    publisherName: item.publisher.name,
    cover: item.cover,
    price: item.inventory?.price ?? null,
    currency: item.inventory?.currency ?? null,
    chips: { theme: null, isNew: false },
  };
}

export interface ListBooksResult {
  items: BookCard[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export async function listBooks(fetcher: Fetcher, params: ListBooksParams): Promise<ListBooksResult> {
  const result = await fetcher<ListBooksResponse>(`/v1/books${toQueryString({ ...params })}`);
  return { ...result, items: result.items.map(bookListItemToCard) };
}
