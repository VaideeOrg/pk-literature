"use client";

import { throwIfProblem } from "./problem-details";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";
// See server-fetch.ts's MARKET for the non-NEXT_PUBLIC server-side
// copy — this one needs the prefix because Client Components run this
// in the browser, where only values inlined at `next build` time
// (package-opennext.sh's exported shell env, per this app's own
// NEXT_PUBLIC_* convention) are visible.
const MARKET = process.env.NEXT_PUBLIC_MARKET;

function readCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/**
 * Client Component counterpart to server-fetch.ts. `credentials:
 * "include"` is what makes the browser attach apps/api-identity's
 * httpOnly access/refresh-token cookies automatically (no way for
 * client JS to read or forward those itself, by design) — this only
 * actually works cross-subdomain because those cookies are set with
 * an explicit `domain` attribute and API Gateway's CORS config has
 * `allow_credentials: true` (both wired in this same change; see
 * apps/web/README.md). X-Anonymous-Id is attached manually since it's
 * a custom header, not something `credentials: "include"` covers.
 */
export async function clientFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const anonymousId = readCookie("anonymous_id");

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(anonymousId && { "x-anonymous-id": anonymousId }),
      ...(MARKET && { "x-market": MARKET }),
      ...init?.headers,
    },
  });

  await throwIfProblem(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
