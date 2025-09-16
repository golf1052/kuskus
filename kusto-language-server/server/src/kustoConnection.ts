import { default as Client } from "azure-kusto-data/types/src/client";
import KustoConnectionStringBuilder from "azure-kusto-data/types/src/connectionBuilder";

export interface TokenResponse {
  verificationUrl: string;
  userCode: string;
}

// Resource string to kusto client. The azure-kusto-data package
// does not have typescript support.
const clients: Map<string, Client> = new Map();

export function getClient(
  clusterUri: string,
  tenantId: string | undefined,
  authCallback: (tokenResponse: TokenResponse) => void,
) {
  if (clients.has(clusterUri)) {
    return clients.get(clusterUri)!;
  } else {
    // If tenant id is empty in the input, consider it undefined when building the connection string
    if (!tenantId) {
      tenantId = undefined;
    }

    const kcsb = KustoConnectionStringBuilder.withAadDeviceAuthentication(
      clusterUri,
      tenantId,
      (deviceCodeInfo) => {
        authCallback({
          verificationUrl: deviceCodeInfo.verificationUri,
          userCode: deviceCodeInfo.userCode,
        });
      },
    );
    const kustoClient = new Client(kcsb);
    clients.set(clusterUri, kustoClient);
    return kustoClient;
  }
}

export function getFirstOrDefaultClient(): {
  clusterUri: string;
  kustoClient: Client | null;
} {
  if (clients.size > 0) {
    const key = clients.keys().next().value;
    return {
      clusterUri: key!,
      kustoClient: clients.get(clients.keys().next().value!)!,
    };
  }
  return {
    clusterUri: "none",
    kustoClient: null,
  };
}
