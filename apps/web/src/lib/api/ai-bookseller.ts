import type { AiBookContext, PostAiAsrResponse, PostAiChatResponse } from "@pk-literature/contracts";
import type { Fetcher } from "./fetcher";
import { throwIfProblem } from "./problem-details";

export function postAiChat(
  fetcher: Fetcher,
  body: { message: string; book: AiBookContext; conversationId: string; history?: { role: "user" | "assistant"; content: string }[] },
): Promise<PostAiChatResponse> {
  return fetcher("/v1/ai/chat", { method: "POST", body: JSON.stringify(body) });
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";

/**
 * Deliberately bypasses the shared Fetcher/clientFetch signature (every
 * other function in this directory takes one) - client-fetch.ts
 * unconditionally sets `content-type: application/json` on every
 * request, which would stomp the multipart boundary header the browser
 * needs to generate itself for a FormData body (setting
 * `multipart/form-data` manually, without the boundary, breaks the
 * server's parse). Every other endpoint this app calls is JSON;
 * special-casing FormData bodies inside client-fetch.ts felt like a
 * bigger, riskier change to a widely-shared utility than one small
 * standalone function here. Still reuses client-fetch.ts's
 * anonymous-id-cookie/credentials behavior directly rather than
 * duplicating it, and the same throwIfProblem error handling.
 */
export async function postAiAsr(audioBlob: Blob): Promise<PostAiAsrResponse> {
  const formData = new FormData();
  formData.append("audio", audioBlob, "recording.webm");

  const response = await fetch(`${API_BASE_URL}/v1/ai/asr`, {
    method: "POST",
    credentials: "include",
    body: formData,
  });

  await throwIfProblem(response);
  return (await response.json()) as PostAiAsrResponse;
}
