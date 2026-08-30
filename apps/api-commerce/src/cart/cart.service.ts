import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { Cart, CartItem } from "@pk-literature/domain-types";
import { KYSELY } from "../database/database.module";
import type { Database } from "../database/database.types";
import { toMediaAsset } from "../common/media-url";
import { NotFoundProblem, ValidationProblem } from "../common/problem-details.exception";

@Injectable()
export class CartService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async getOrCreateCart(anonymousId: string | undefined): Promise<Cart> {
    const cartId = await this.getOrCreateCartId(anonymousId);
    return this.buildCart(cartId);
  }

  // This add-to-cart path reads catalog.inventory directly (own SQL,
  // not a call to api-catalog's HTTP API) — so unlike GET /books,
  // getting puthagakadai.sg's SGD pricing here needed its own copy of
  // api-catalog's toInventory() market branching, not something that
  // came for free from Task #1's price_sgd column. Same X-Market
  // header, same "SG" ->  price_sgd/'SGD' convention (migration
  // 20260101000028), same "NULL price_sgd = unavailable" fallback —
  // here surfaced as a rejected add-to-cart rather than a null
  // Inventory, since there's no "add an unavailable book" UI state to
  // fall through to.
  async upsertItem(
    anonymousId: string | undefined,
    bookId: string,
    quantity: number,
    market: string | undefined,
  ): Promise<Cart> {
    const cartId = await this.getOrCreateCartId(anonymousId);

    const book = await this.db
      .selectFrom("catalog.books")
      .innerJoin("catalog.inventory", "catalog.inventory.bookId", "catalog.books.id")
      .select([
        "catalog.books.title",
        "catalog.inventory.price",
        "catalog.inventory.currency",
        "catalog.inventory.priceSgd",
      ])
      .where("catalog.books.id", "=", bookId)
      .where("catalog.books.status", "=", "published")
      .executeTakeFirst();
    if (!book) throw new NotFoundProblem("Book", bookId);

    const isSg = market?.toUpperCase() === "SG";
    if (isSg && book.priceSgd === null) {
      throw new ValidationProblem(`"${book.title}" is not available in this market.`);
    }
    const unitPrice = isSg ? book.priceSgd! : book.price;
    const currency = isSg ? "SGD" : book.currency;

    await this.db
      .insertInto("commerce.cartItems")
      .values({
        cartId,
        bookId,
        titleSnapshot: book.title,
        unitPrice,
        currency,
        quantity,
      })
      .onConflict((oc) =>
        oc.columns(["cartId", "bookId"]).doUpdateSet((eb) => ({
          quantity: eb.ref("excluded.quantity"),
          // Re-snapshot title/price on every add — SPEC-06's "title
          // snapshot" freezes what the customer saw at add-to-cart
          // time, and re-adding the same book (quantity update) is a
          // fresh add-to-cart action, not a stale one; only the order
          // created at checkout freezes permanently from that point on.
          titleSnapshot: eb.ref("excluded.titleSnapshot"),
          unitPrice: eb.ref("excluded.unitPrice"),
          currency: eb.ref("excluded.currency"),
        })),
      )
      .execute();

    return this.buildCart(cartId);
  }

  async removeItem(anonymousId: string | undefined, itemId: string): Promise<Cart> {
    const cartId = await this.getOrCreateCartId(anonymousId);
    await this.db
      .deleteFrom("commerce.cartItems")
      .where("id", "=", itemId)
      .where("cartId", "=", cartId)
      .execute();
    return this.buildCart(cartId);
  }

  /**
   * Used by CheckoutService — the raw line items (not the hydrated
   * Cart-with-cover-images shape GET /cart returns) plus the cart id
   * itself, so checkout can freeze them into order_items and mark the
   * cart 'converted' in one transaction.
   */
  async getActiveCartForCheckout(anonymousId: string | undefined): Promise<{
    cartId: string;
    items: { bookId: string; titleSnapshot: string; unitPrice: number; currency: string; quantity: number }[];
  }> {
    const cartId = await this.getOrCreateCartId(anonymousId);
    const rows = await this.db
      .selectFrom("commerce.cartItems")
      .select(["bookId", "titleSnapshot", "unitPrice", "currency", "quantity"])
      .where("cartId", "=", cartId)
      .execute();

    return {
      cartId,
      items: rows.map((r) => ({ ...r, unitPrice: Number(r.unitPrice) })),
    };
  }

  private async getOrCreateCartId(anonymousId: string | undefined): Promise<string> {
    if (!anonymousId) {
      throw new ValidationProblem("X-Anonymous-Id header is required for cart operations.");
    }

    const existing = await this.db
      .selectFrom("commerce.cart")
      .select("id")
      .where("anonymousId", "=", anonymousId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (existing) return existing.id;

    const created = await this.db
      .insertInto("commerce.cart")
      .values({ anonymousId, status: "active" })
      .returning("id")
      .executeTakeFirstOrThrow();
    return created.id;
  }

  private async buildCart(cartId: string): Promise<Cart> {
    const rows = await this.db
      .selectFrom("commerce.cartItems")
      .leftJoin("catalog.books", "catalog.books.id", "commerce.cartItems.bookId")
      .leftJoin("catalog.mediaAssets", "catalog.mediaAssets.id", "catalog.books.coverAssetId")
      .select([
        "commerce.cartItems.id",
        "commerce.cartItems.bookId",
        "commerce.cartItems.titleSnapshot",
        "commerce.cartItems.unitPrice",
        "commerce.cartItems.currency",
        "commerce.cartItems.quantity",
        "catalog.mediaAssets.id as coverId",
        "catalog.mediaAssets.assetType as coverAssetType",
        "catalog.mediaAssets.s3Key as coverS3Key",
        "catalog.mediaAssets.widthPx as coverWidthPx",
        "catalog.mediaAssets.heightPx as coverHeightPx",
      ])
      .where("commerce.cartItems.cartId", "=", cartId)
      .orderBy("commerce.cartItems.createdAt")
      .execute();

    const items: CartItem[] = rows.map((row) => ({
      id: row.id,
      bookId: row.bookId,
      titleSnapshot: row.titleSnapshot,
      unitPrice: Number(row.unitPrice),
      currency: row.currency,
      quantity: row.quantity,
      cover: toMediaAsset(
        row.coverId
          ? {
              id: row.coverId,
              assetType: row.coverAssetType!,
              s3Key: row.coverS3Key!,
              widthPx: row.coverWidthPx,
              heightPx: row.coverHeightPx,
            }
          : null,
      ),
    }));

    const currency = items[0]?.currency ?? "INR";
    const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

    return { id: cartId, items, subtotal, currency };
  }
}
