import { describe, it, expect, vi, beforeEach } from "vitest";

const getSession = vi.fn();

vi.mock("vscode", () => ({
  authentication: {
    getSession: (...args: unknown[]) => getSession(...args),
  },
}));

vi.mock("../../logger.js", () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  getAccessToken,
  createTokenProvider,
  clearCachedToken,
} from "../../tokenProvider.js";
import { log, logWarn, logError } from "../../logger.js";

/**
 * Builds a minimal JWT whose `exp` claim is `secondsFromNow` in the future.
 * Only the payload segment needs to be a decodable base64url JSON object.
 */
function makeToken(secondsFromNow: number, marker = "t"): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  const payload = Buffer.from(JSON.stringify({ exp, marker })).toString(
    "base64url",
  );
  return `header.${payload}.sig`;
}

describe("tokenProvider", () => {
  beforeEach(() => {
    getSession.mockReset();
    vi.mocked(log).mockClear();
    vi.mocked(logWarn).mockClear();
    vi.mocked(logError).mockClear();
    clearCachedToken();
  });

  it("acquires a token silently and returns it", async () => {
    const token = makeToken(3600);
    getSession.mockResolvedValueOnce({ accessToken: token });

    await expect(getAccessToken()).resolves.toBe(token);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith(
      "microsoft",
      expect.any(Array),
      expect.objectContaining({ silent: true }),
    );
  });

  it("caches the token and does not call getSession again while valid", async () => {
    const token = makeToken(3600);
    getSession.mockResolvedValueOnce({ accessToken: token });

    await getAccessToken();
    await getAccessToken();
    await getAccessToken();

    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the cached token is within the expiry safety margin", async () => {
    const nearExpiry = makeToken(60, "old"); // 1 min left -> inside 5 min margin
    const fresh = makeToken(3600, "new");
    getSession
      .mockResolvedValueOnce({ accessToken: nearExpiry })
      .mockResolvedValueOnce({ accessToken: fresh });

    const first = await getAccessToken();
    const second = await getAccessToken();

    expect(first).toBe(nearExpiry);
    expect(second).toBe(fresh);
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("falls back to an interactive login when silent refresh yields no session", async () => {
    const token = makeToken(3600);
    getSession
      .mockResolvedValueOnce(undefined) // silent
      .mockResolvedValueOnce({ accessToken: token }); // interactive

    await expect(getAccessToken()).resolves.toBe(token);
    expect(getSession).toHaveBeenNthCalledWith(
      1,
      "microsoft",
      expect.any(Array),
      expect.objectContaining({ silent: true }),
    );
    expect(getSession).toHaveBeenNthCalledWith(
      2,
      "microsoft",
      expect.any(Array),
      expect.objectContaining({ createIfNone: true }),
    );
  });

  it("throws when neither silent nor interactive login yields a session", async () => {
    getSession.mockResolvedValue(undefined);
    await expect(getAccessToken()).rejects.toThrow(
      /No Microsoft authentication session/,
    );
  });

  it("clearCachedToken forces a new getSession call", async () => {
    getSession.mockResolvedValue({ accessToken: makeToken(3600) });

    await getAccessToken();
    clearCachedToken();
    await getAccessToken();

    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("createTokenProvider returns a callback that yields a token", async () => {
    const token = makeToken(3600);
    getSession.mockResolvedValueOnce({ accessToken: token });

    const provider = createTokenProvider();
    await expect(provider()).resolves.toBe(token);
  });

  it("includes the caller context in the refresh log line", async () => {
    getSession.mockResolvedValueOnce({ accessToken: makeToken(3600) });

    await getAccessToken("https://help.kusto.windows.net");

    const logged = vi.mocked(log).mock.calls.map((c) => String(c[0]));
    expect(
      logged.some((m) => m.includes("https://help.kusto.windows.net")),
    ).toBe(true);
    expect(logged.some((m) => m.includes("Refreshed access token silently"))).toBe(
      true,
    );
  });

  it("warns before falling back to interactive login", async () => {
    getSession
      .mockResolvedValueOnce(undefined) // silent
      .mockResolvedValueOnce({ accessToken: makeToken(3600) }); // interactive

    await getAccessToken("ctx");

    expect(
      vi
        .mocked(logWarn)
        .mock.calls.some((c) => String(c[0]).includes("interactive")),
    ).toBe(true);
  });

  it("logs an error when no session can be acquired", async () => {
    getSession.mockResolvedValue(undefined);

    await expect(getAccessToken("ctx")).rejects.toThrow();
    expect(vi.mocked(logError)).toHaveBeenCalled();
  });
});
