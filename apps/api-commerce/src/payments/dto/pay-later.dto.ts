import { IsUUID } from "class-validator";

export class PayLaterDto {
  @IsUUID()
  orderId!: string;
}
