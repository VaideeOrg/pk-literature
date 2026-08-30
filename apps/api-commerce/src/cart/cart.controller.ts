import { Body, Controller, Delete, Get, Headers, Param, Patch, Post } from "@nestjs/common";
import type { CreateCartResponse, GetCartResponse, RemoveCartItemResponse, UpsertCartItemResponse } from "@pk-literature/contracts";
import { CartService } from "./cart.service";
import { UpsertCartItemDto } from "./dto/upsert-cart-item.dto";

@Controller("cart")
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Post()
  async create(@Headers("x-anonymous-id") anonymousId?: string): Promise<CreateCartResponse> {
    return this.cart.getOrCreateCart(anonymousId);
  }

  @Get()
  async get(@Headers("x-anonymous-id") anonymousId?: string): Promise<GetCartResponse> {
    return this.cart.getOrCreateCart(anonymousId);
  }

  @Patch("items")
  async upsertItem(
    @Body() dto: UpsertCartItemDto,
    @Headers("x-anonymous-id") anonymousId?: string,
    @Headers("x-market") market?: string,
  ): Promise<UpsertCartItemResponse> {
    return this.cart.upsertItem(anonymousId, dto.bookId, dto.quantity, market);
  }

  @Delete("items/:id")
  async removeItem(
    @Param("id") id: string,
    @Headers("x-anonymous-id") anonymousId?: string,
  ): Promise<RemoveCartItemResponse> {
    return this.cart.removeItem(anonymousId, id);
  }
}
