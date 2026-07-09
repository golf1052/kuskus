import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock azure-kusto-data with a proper class constructor
vi.mock("azure-kusto-data", () => {
  class MockKustoClient {
    execute = vi.fn();
  }

  return {
    Client: MockKustoClient,
    KustoConnectionStringBuilder: {
      withTokenProvider: vi.fn().mockReturnValue({}),
    },
  };
});

const mockTokenProvider = () => Promise.resolve("mock-token");

describe("kustoConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("newGetClient", () => {
    it("should create a new client with token provider", async () => {
      const { newGetClient } = await import("../kustoConnection.js");

      const client = await newGetClient(
        "https://test.kusto.windows.net",
        mockTokenProvider,
      );

      expect(client).toBeDefined();
    });

    it("should throw if no token provider for new cluster", async () => {
      const { newGetClient } = await import("../kustoConnection.js");

      await expect(
        newGetClient("https://test.kusto.windows.net"),
      ).rejects.toThrow("Token provider is required");
    });

    it("should return cached client on second call", async () => {
      const { newGetClient } = await import("../kustoConnection.js");

      const client1 = await newGetClient(
        "https://test.kusto.windows.net",
        mockTokenProvider,
      );
      const client2 = await newGetClient("https://test.kusto.windows.net");

      expect(client1).toBe(client2);
    });

    it("should create separate clients for different clusters", async () => {
      const { newGetClient } = await import("../kustoConnection.js");

      const client1 = await newGetClient(
        "https://cluster1.kusto.windows.net",
        mockTokenProvider,
      );
      const client2 = await newGetClient(
        "https://cluster2.kusto.windows.net",
        mockTokenProvider,
      );

      expect(client1).not.toBe(client2);
    });
  });

  describe("getFirstOrDefaultClient", () => {
    it("should return null client when no clients exist", async () => {
      const { getFirstOrDefaultClient } = await import("../kustoConnection.js");

      const result = getFirstOrDefaultClient();

      expect(result.clusterUri).toBe("none");
      expect(result.kustoClient).toBeNull();
    });

    it("should return the first client when clients exist", async () => {
      const { newGetClient, getFirstOrDefaultClient } = await import(
        "../kustoConnection.js"
      );

      await newGetClient("https://test.kusto.windows.net", mockTokenProvider);

      const result = getFirstOrDefaultClient();

      expect(result.clusterUri).toBe("https://test.kusto.windows.net");
      expect(result.kustoClient).toBeDefined();
    });
  });
});
