import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

// Same client/env-var/source-name pattern as
// src/subscribers/eventbridge-order-placed.ts - a second, independent
// publish site (the store-order creation route, not a Medusa
// subscriber) rather than sharing that file's own client instance,
// since subscribers and custom admin routes are loaded by entirely
// different parts of Medusa's own bootstrap.
const client = new EventBridgeClient({});

export async function publishEvent(detailType: string, detail: object): Promise<void> {
  const busName = process.env.EVENTBRIDGE_BUS_NAME;
  if (!busName) {
    // eslint-disable-next-line no-console
    console.warn(`EVENTBRIDGE_BUS_NAME is not configured — skipping publish of ${detailType}`);
    return;
  }

  const result = await client.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: busName,
          Source: "pk-literature.medusa",
          DetailType: detailType,
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );

  const entry = result.Entries?.[0];
  if (entry?.ErrorCode) {
    // eslint-disable-next-line no-console
    console.error(`EventBridge PutEvents failed for ${detailType}: ${entry.ErrorCode} — ${entry.ErrorMessage}`);
  }
}
