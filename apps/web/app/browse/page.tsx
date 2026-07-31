import Link from "next/link";
import { serverFetch } from "@/lib/api/server-fetch";
import { listBooks } from "@/lib/api/catalog";
import { BookCard } from "@/components/book-card";

interface BrowseSearchParams {
  page?: string;
}

interface BrowsePageProps {
  searchParams: Promise<BrowseSearchParams>;
}

const PAGE_SIZE = 24;

export default async function BrowsePage({ searchParams }: BrowsePageProps) {
  const params = await searchParams;
  const page = params.page ? Number(params.page) : 1;
  const result = await listBooks(serverFetch, { page, pageSize: PAGE_SIZE });

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">All Books</h1>

      <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
        {result.items.map((book) => (
          <BookCard key={book.id} book={book} />
        ))}
      </div>
      {result.totalItems === 0 && <p className="text-muted-foreground">No books available yet.</p>}

      <div className="mt-8 flex justify-center gap-4">
        {page > 1 && (
          <Link href={`/browse?page=${page - 1}`} className="text-sm underline">
            Previous
          </Link>
        )}
        {page < result.totalPages && (
          <Link href={`/browse?page=${page + 1}`} className="text-sm underline">
            Next
          </Link>
        )}
      </div>
    </div>
  );
}
