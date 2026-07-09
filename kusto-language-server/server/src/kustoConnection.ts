import {
  Client as KustoClient,
  KustoConnectionStringBuilder,
} from "azure-kusto-data";

export interface TokenResponse {
  verificationUrl: string;
  userCode: string;
}

// Cluster URI to kusto client.
const clients: Map<string, KustoClient> = new Map();

/**
 * Returns (or creates) a KustoClient for the given cluster.
 *
 * When `tokenProvider` is supplied and no client exists yet, a new client is
 * created using `KustoConnectionStringBuilder.withTokenProvider` so that every
 * request automatically fetches a fresh token — preventing expiry issues.
 */
export async function newGetClient(
  clusterUri: string,
  tokenProvider?: () => Promise<string>,
): Promise<KustoClient> {
  if (clients.has(clusterUri)) {
    return clients.get(clusterUri)!;
  } else {
    if (!tokenProvider) {
      throw new Error("Token provider is required");
    }

    const kcsb = KustoConnectionStringBuilder.withTokenProvider(
      clusterUri,
      tokenProvider,
    );
    const client = new KustoClient(kcsb);
    clients.set(clusterUri, client);
    return client;
  }
}

export function getFirstOrDefaultClient(): {
  clusterUri: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kustoClient: any;
} {
  if (clients.size > 0) {
    const key = clients.keys().next().value!;
    return {
      clusterUri: key,
      kustoClient: clients.get(key),
    };
  }
  return {
    clusterUri: "none",
    kustoClient: null,
  };
}

/**
 * Returns an existing client for the given cluster URI without creating one.
 * Returns undefined if no client is cached for this cluster.
 * Uses normalized matching (case-insensitive, trailing-slash-insensitive).
 */
export function getExistingClient(clusterUri: string): KustoClient | undefined {
  const exact = clients.get(clusterUri);
  if (exact) {
    return exact;
  }

  const normalize = (uri: string) => uri.toLowerCase().replace(/\/+$/, "");
  const normalized = normalize(clusterUri);
  for (const [key, client] of clients.entries()) {
    if (normalize(key) === normalized) {
      return client;
    }
  }
  return undefined;
}
