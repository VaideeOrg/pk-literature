import Link from "next/link";
import { notFound } from "next/navigation";
import { serverFetch } from "@/lib/api/server-fetch";
import { getOrder } from "@/lib/api/commerce";
import { ApiError } from "@/lib/api/problem-details";

export default async function OrderConfirmationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ method?: string }>;
}) {
  const { orderId } = await params;
  const { method } = await searchParams;
  const order = await getOrderOr404(orderId);
  // Set by checkout-form.tsx's redirect right after POST
  // /payments/pay-later succeeds — there's no webhook to wait for with
  // this method, so the generic "confirmation can take a moment"
  // copy below would be actively misleading here.
  const isPayLater = method === "pay_later";

  return (
    <div className="mx-auto max-w-xl text-center">
      <h1 className="text-2xl font-bold">Thank you!</h1>
      <p className="mt-2 text-muted-foreground">
        Order <span className="font-mono">{order.orderNumber}</span> is{" "}
        <span className="font-medium">{order.status.replace("_", " ")}</span>.
      </p>
      {isPayLater ? (
        <p className="mt-2 text-sm text-muted-foreground">Pay in cash when you collect your order.</p>
      ) : (
        order.status === "pending_payment" && (
          <p className="mt-2 text-sm text-muted-foreground">
            Payment confirmation can take a moment to arrive — refresh this page shortly if the status above still says
            &ldquo;pending payment&rdquo;.
          </p>
        )
      )}
      <ul className="mt-8 flex flex-col divide-y divide-border text-left">
        {order.items.map((item) => (
          <li key={item.id} className="flex justify-between py-2 text-sm">
            <span>
              {item.titleSnapshot} &times; {item.quantity}
            </span>
            <span>
              {item.currency} {(item.unitPrice * item.quantity).toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-right font-semibold">
        Total: {order.currency} {order.total.toFixed(2)}
      </p>
      <Link href="/" className="mt-8 inline-block underline">
        Continue shopping
      </Link>
    </div>
  );
}

async function getOrderOr404(orderId: string) {
  try {
    return await getOrder(serverFetch, orderId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}
