import { Controller, Get, Headers, Param, Query } from "@nestjs/common";
import type { ListBooksResponse, GetBookResponse } from "@pk-literature/contracts";
import { paginate } from "../common/paginate";
import { BooksService } from "./books.service";
import { ListBooksDto } from "./list-books.dto";

@Controller("books")
export class BooksController {
  constructor(private readonly books: BooksService) {}

  @Get()
  async list(
    @Query() query: ListBooksDto,
    @Headers("x-market") market?: string,
  ): Promise<ListBooksResponse> {
    const { items, totalItems } = await this.books.list(
      query,
      { workId: query.workId, publisherId: query.publisherId },
      market,
    );
    return paginate(items, totalItems, query);
  }

  @Get(":id")
  async getById(@Param("id") id: string, @Headers("x-market") market?: string): Promise<GetBookResponse> {
    return this.books.getById(id, market);
  }
}
