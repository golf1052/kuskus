import { authentication } from "vscode";
import { log, logDebug, logError, logWarn } from "./logger.js";

const KUSTO_SCOPES = [
  "https://management.core.windows.net/.default",
  "offline_access",
];

// Refresh the cached token when it is within this many milliseconds of its
// expiry. Access tokens are typically valid for ~1h; a 5-minute safety margin
// ensures we never hand out a token that is about to expire mid-request.
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

// In-memory cache of the most recently acquired token and its expiry time
// (epoch ms). `azure-kusto-data` calls the token provider on every request, so
// without this cache each Kusto request would trigger a separate VS Code
// authentication.getSession call — hundreds per session.
let cachedToken: string | undefined;
let cachedTokenExpiryMs = 0;

// Lightweight diagnostics counters (reset on extension reload). They are
// included in log lines so a captured log makes it obvious how often tokens are
// served from cache versus freshly refreshed — useful when investigating both
// token-expiry failures and excessive `getSession` traffic.
let servedFromCacheCount = 0;
let refreshCount = 0;

/** Formats an expiry epoch (ms) as an ISO timestamp plus minutes-from-now. */
function formatExpiry(expiryMs: number): string {
  if (!expiryMs) {
    return "unknown";
  }
  const remainingMinutes = Math.round((expiryMs - Date.now()) / 60000);
  return `${new Date(expiryMs).toISOString()} (~${remainingMinutes} min from now)`;
}

/**
 * Extracts the `exp` (expiry) claim from a JWT access token, in epoch ms.
 * Returns undefined if the token can't be decoded.
 */
function getTokenExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as { exp?: number };
    if (typeof payload.exp === "number") {
      return payload.exp * 1000;
    }
  } catch {
    // Not a decodable JWT — fall through.
  }
  return undefined;
}
/**
 * Returns a fresh access token by calling the VS Code Microsoft authentication API.
 *
 * The result is cached in memory and reused until it is within
 * {@link EXPIRY_SAFETY_MARGIN_MS} of expiry, so the common case (many Kusto
 * requests in quick succession) does not trigger a `getSession` call each time.
 *
 * On a cache miss it first attempts a `silent: true` refresh — this covers the
 * common case where only the ~1h access token has expired but VS Code still
 * holds a valid refresh token, so a new access token is returned without
 * prompting.
 *
 * If no session can be obtained silently (the user signed out or the refresh
 * token itself expired), it falls back to an interactive `createIfNone: true`
 * request, which surfaces VS Code's native re-login prompt instead of failing
 * the pending operation with a raw error.
 *
 * @param context A short label describing who requested the token (e.g. a
 *   cluster URI or "language server request"). Included in log lines so failures
 *   can be traced back to the operation that triggered them.
 * @throws If both the silent and interactive requests fail to yield a session.
 */
export async function getAccessToken(context = "unknown"): Promise<string> {
  // Serve from cache while the token is comfortably far from expiry.
  if (
    cachedToken &&
    Date.now() < cachedTokenExpiryMs - EXPIRY_SAFETY_MARGIN_MS
  ) {
    servedFromCacheCount++;
    logDebug(
      `Access token served from cache for [${context}]; expires ${formatExpiry(
        cachedTokenExpiryMs,
      )} (cache hits so far: ${servedFromCacheCount})`,
    );
    return cachedToken;
  }

  const reason = !cachedToken
    ? "no cached token"
    : `cached token is within the ${EXPIRY_SAFETY_MARGIN_MS / 60000}-min expiry margin (expires ${formatExpiry(
        cachedTokenExpiryMs,
      )})`;
  log(`Refreshing access token for [${context}]: ${reason}`);

  let silentSession;
  try {
    silentSession = await authentication.getSession("microsoft", KUSTO_SCOPES, {
      silent: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Silent token refresh threw for [${context}]: ${msg}`);
    throw err;
  }

  if (silentSession) {
    cacheToken(silentSession.accessToken);
    refreshCount++;
    log(
      `Refreshed access token silently for [${context}]; new token expires ${formatExpiry(
        cachedTokenExpiryMs,
      )} (total refreshes: ${refreshCount})`,
    );
    return silentSession.accessToken;
  }

  // Silent refresh failed — prompt the user to re-authenticate.
  logWarn(
    `Silent token refresh returned no session for [${context}]; prompting for interactive re-login`,
  );
  let interactiveSession;
  try {
    interactiveSession = await authentication.getSession(
      "microsoft",
      KUSTO_SCOPES,
      { createIfNone: true },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Interactive re-login threw for [${context}]: ${msg}`);
    throw err;
  }
  if (!interactiveSession) {
    logError(
      `Interactive re-login yielded no session for [${context}] (user likely cancelled)`,
    );
    throw new Error(
      "No Microsoft authentication session available. Please log in first.",
    );
  }
  cacheToken(interactiveSession.accessToken);
  refreshCount++;
  log(
    `Acquired access token via interactive re-login for [${context}]; token expires ${formatExpiry(
      cachedTokenExpiryMs,
    )} (total refreshes: ${refreshCount})`,
  );
  return interactiveSession.accessToken;
}

/**
 * Stores a token in the in-memory cache, deriving its expiry from the JWT `exp`
 * claim. If the expiry can't be decoded, the token is cached for a short,
 * conservative window so we still avoid hammering the auth API.
 */
function cacheToken(token: string): void {
  cachedToken = token;
  const expiryMs = getTokenExpiryMs(token);
  if (expiryMs === undefined) {
    cachedTokenExpiryMs = Date.now() + EXPIRY_SAFETY_MARGIN_MS + 60 * 1000;
    logWarn(
      `Could not decode access token expiry (exp claim); caching conservatively until ${formatExpiry(
        cachedTokenExpiryMs,
      )}`,
    );
  } else {
    cachedTokenExpiryMs = expiryMs;
  }
}

/**
 * Clears the cached access token. Call when the user signs out or switches
 * accounts so the next request re-authenticates.
 *
 * @param reason A short label describing why the cache was cleared, for logging.
 */
export function clearCachedToken(reason = "unspecified"): void {
  if (cachedToken) {
    log(`Clearing cached access token (${reason})`);
  } else {
    logDebug(`clearCachedToken called with no token cached (${reason})`);
  }
  cachedToken = undefined;
  cachedTokenExpiryMs = 0;
}

/**
 * Returns a token-provider callback suitable for
 * `KustoConnectionStringBuilder.withTokenProvider()`.
 *
 * Each invocation of the returned function fetches a token (from cache when
 * valid, refreshing otherwise) so that `azure-kusto-data` never uses a stale
 * credential.
 *
 * @param context A short label (typically the cluster URI) identifying the
 *   connection this provider serves, included in token log lines.
 */
export function createTokenProvider(
  context = "kusto request",
): () => Promise<string> {
  return async () => {
    try {
      return await getAccessToken(context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Token provider failed for [${context}]: ${msg}`);
      throw err;
    }
  };
}
