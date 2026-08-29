import { EthirveliyeeduAdapter, KalachuvaduAdapter, type PublisherAdapter } from "@pk-literature/adapter-sdk";

// One entry per onboarded publisher (SPEC-04 §8 Publisher Registration)
// — adding a new publisher means adding an adapter implementation under
// @pk-literature/adapter-sdk plus one line here, nothing else in this
// app changes (SPEC-04 §1: "new publishers... without changing the
// core platform").
const ADAPTER_FACTORIES: Record<string, (baseUrl: string) => PublisherAdapter> = {
  kalachuvadu: (baseUrl) => new KalachuvaduAdapter({ baseUrl }),
  ethirveliyeedu: (baseUrl) => new EthirveliyeeduAdapter({ baseUrl }),
};

export function getAdapter(publisherCode: string, baseUrl: string): PublisherAdapter {
  const factory = ADAPTER_FACTORIES[publisherCode];
  if (!factory) {
    throw new Error(`No adapter registered for publisher code "${publisherCode}"`);
  }
  return factory(baseUrl);
}
