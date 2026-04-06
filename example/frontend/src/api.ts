import { NitroAPI } from "backend";

// In a real app this would come from a login flow / localStorage / cookie.
const AUTH_TOKEN = "example-static-token";

/**
 * Shared API client with a custom fetch that injects an Authorization header
 * on every request — including SSE streams and WebSocket upgrades.
 *
 * Steps:
 *   1. Build a fresh Headers object so the original init is never mutated.
 *   2. Attach the token.
 *   3. Forward everything else unchanged.
 */
export const api = new NitroAPI({
  baseUrl: "http://localhost:3456",
  async fetch(input, init) {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${AUTH_TOKEN}`);
    return fetch(input, { ...init, headers });
  },
});
