import type { McpAuthPort } from "../agent/mcp-connect.js";
import { type OAuthFetch, accessToken } from "./oauth.js";
import { type TokenStore, makeTokenStore } from "./token-store.js";

export const realFetch: OAuthFetch = (url, init) => fetch(url, init);

/** Stored MCP sign-ins as the connect step uses them: the current token, and a refreshed one on a 401. */
export function makeMcpAuth(
  store: TokenStore = makeTokenStore(),
  fetchImpl: OAuthFetch = realFetch,
): McpAuthPort {
  return {
    token: (url) => accessToken(url, { fetch: fetchImpl, store }),
    refresh: (url) => accessToken(url, { fetch: fetchImpl, store, forceRefresh: true }),
  };
}
