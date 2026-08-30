"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Heart, ShoppingBag, Eye } from "lucide-react";
import type { BookCard } from "@pk-literature/domain-types";
import { clientFetch } from "@/lib/api/client-fetch";
import { postLike } from "@/lib/api/feed";
import { upsertCartItem } from "@/lib/api/commerce";

// One full-viewport slide of /feed's reels-style vertical feed — an
// image zone (book.cover, full-bleed) plus a white "sheet" for
// title/author/price, per the approved design: a translucent dark
// scrim (the usual Reels/Shorts treatment) doesn't hold up against
// this app's white/red brand, so each slide is split into two honest
// zones instead of overlaying text on the image.
//
// Quick View has no backing feature anywhere in this app yet (the
// horizontal shelf's own BookCard doesn't have one either, per
// SPEC-05's comparison) - this treats it as a shortcut to the existing
// book detail page rather than inventing a new modal nobody asked for.
export function ReelBookSlide({ book }: { book: BookCard }) {
  const router = useRouter();
  const [liked, setLiked] = useState(false);
  const [likePending, setLikePending] = useState(false);
  const [cartStatus, setCartStatus] = useState<"idle" | "pending" | "added" | "error">("idle");

  // Same "no price = unavailable" convention as book-card.tsx's shelf
  // card - BookCard carries no separate stock/availability field.
  const unavailable = book.price === null;

  async function toggleLike() {
    if (likePending) return;
    const next = !liked;
    setLiked(next); // optimistic, same pattern as LikeButton
    setLikePending(true);
    try {
      await postLike(clientFetch, { bookId: book.id, liked: next });
    } catch {
      setLiked(!next);
    } finally {
      setLikePending(false);
    }
  }

  async function addToCart() {
    if (unavailable || cartStatus === "pending") return;
    setCartStatus("pending");
    try {
      await upsertCartItem(clientFetch, { bookId: book.id, quantity: 1 });
      setCartStatus("added");
      router.refresh(); // re-runs CartLink's server-side item count, same as AddToCartButton
    } catch {
      setCartStatus("error");
    } finally {
      setTimeout(() => setCartStatus("idle"), 1500);
    }
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="relative min-h-0 flex-1 bg-muted">
        {book.cover ? (
          <Image src={book.cover.url} alt={book.title} fill sizes="100vw" className="object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-lg font-semibold text-muted-foreground">
            {book.title}
          </div>
        )}

        {book.chips.isNew && (
          <span className="absolute left-4 top-4 rounded-full bg-brand px-3 py-1 text-xs font-bold uppercase tracking-wide text-brand-foreground">
            New
          </span>
        )}

        <div className="absolute bottom-4 right-3 flex flex-col items-center gap-3.5">
          <button
            type="button"
            onClick={toggleLike}
            aria-pressed={liked}
            aria-label={liked ? "Unlike this book" : "Like this book"}
            className={`flex h-11 w-11 items-center justify-center rounded-full shadow-md backdrop-blur ${
              liked ? "bg-background text-brand" : "bg-background/90 text-foreground"
            }`}
          >
            <Heart className="h-5 w-5" fill={liked ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            onClick={addToCart}
            disabled={unavailable || cartStatus === "pending"}
            aria-label="Add to cart"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-brand text-brand-foreground shadow-md disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ShoppingBag className="h-5 w-5" />
          </button>
          <Link
            href={`/books/${book.id}`}
            aria-label="View book details"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-background/90 text-foreground shadow-md backdrop-blur"
          >
            <Eye className="h-5 w-5" />
          </Link>
        </div>
      </div>

      <div className="flex flex-shrink-0 flex-col gap-1.5 rounded-t-2xl border-t border-border bg-background px-5 py-5">
        <Link href={`/books/${book.id}`} className="text-lg font-bold leading-snug">
          {book.title}
        </Link>
        {book.authorName && (
          <p className="text-sm text-muted-foreground">
            by {book.authorName} · {book.publisherName}
          </p>
        )}
        <div className="mt-1 flex items-center gap-3">
          {book.price !== null ? (
            <span className="text-xl font-extrabold text-brand">
              {book.currency} {book.price.toFixed(2)}
            </span>
          ) : (
            <span className="text-sm font-medium text-destructive">Unavailable</span>
          )}
          {cartStatus === "added" && <span className="text-xs font-semibold text-muted-foreground">Added to cart</span>}
          {cartStatus === "error" && <span className="text-xs font-semibold text-destructive">Couldn&rsquo;t add — try again</span>}
        </div>
      </div>
    </div>
  );
}
