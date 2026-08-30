import { Body, Controller, Headers, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import type { CreatePaymentOrderResponse, PayLaterResponse, WebhookAck } from "@pk-literature/contracts";
import { PaymentsService, verifyWebhookOrThrow } from "./payments.service";
import { CreatePaymentOrderDto } from "./dto/create-payment-order.dto";
import { PayLaterDto } from "./dto/pay-later.dto";
import { ValidationProblem } from "../common/problem-details.exception";

@Controller("payments")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post("create-order")
  async createOrder(@Body() dto: CreatePaymentOrderDto): Promise<CreatePaymentOrderResponse> {
    return this.payments.createPaymentOrder(dto.orderId);
  }

  @Post("pay-later")
  async payLater(
    @Body() dto: PayLaterDto,
    @Headers("x-market") market?: string,
  ): Promise<PayLaterResponse> {
    return this.payments.payLater(dto.orderId, market);
  }

  @Post("webhook")
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") signature?: string,
  ): Promise<WebhookAck> {
    if (!req.rawBody) {
      // Should be unreachable — create-app.ts sets rawBody: true
      // globally — but a missing raw body must never be silently
      // treated as a verified/empty payload.
      throw new ValidationProblem("Raw request body was not captured.");
    }

    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error("RAZORPAY_WEBHOOK_SECRET is not configured");
    }
    verifyWebhookOrThrow(req.rawBody.toString("utf-8"), signature, secret);

    await this.payments.handleWebhook(req.body);
    return { received: true };
  }
}
