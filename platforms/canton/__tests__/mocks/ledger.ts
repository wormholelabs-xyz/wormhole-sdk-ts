import type { FetchFunction } from "../../src/ledger.js";
import { CantonLedgerClient } from "../../src/ledger.js";

export interface RecordedRequest {
  path: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type MockReply = { status?: number; json?: unknown; text?: string } | "hang" | Error;

/** A fetch that answers from a queue per path and records every request */
export function mockFetch(replies: Record<string, MockReply[]>) {
  const requests: RecordedRequest[] = [];
  const fetchFunction: FetchFunction = async (url, init) => {
    const parsed = new URL(url);
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    let body: unknown = bodyText;
    try {
      body = bodyText === undefined ? undefined : JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
    requests.push({
      path: parsed.pathname,
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
    });
    const reply = replies[parsed.pathname]?.shift();
    if (reply === undefined)
      return new Response(`no reply for ${parsed.pathname}`, { status: 404 });
    if (reply instanceof Error) throw reply;
    if (reply === "hang")
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
    return new Response(text, { status: reply.status ?? 200 });
  };
  return { fetchFunction, requests };
}

/** A ledger client over a mock fetch */
export function mockLedger(replies: Record<string, MockReply[]>) {
  const { fetchFunction, requests } = mockFetch(replies);
  const ledger = new CantonLedgerClient({
    baseUrl: "http://participant.test",
    tokenProvider: async () => "token",
    fetch: fetchFunction,
  });
  return { ledger, requests };
}

/** One JsActiveContract entry of an active-contracts response */
export function activeContractEntry(
  createdEvent: Record<string, unknown>,
  synchronizerId = "global-domain::1220aa",
) {
  return {
    contractEntry: {
      JsActiveContract: { createdEvent, synchronizerId, reassignmentCounter: 0 },
    },
  };
}
