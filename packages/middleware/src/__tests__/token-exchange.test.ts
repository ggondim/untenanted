import { describe, it, expect } from "vitest";
import {
  TokenExchangeClient,
  TokenExchangeFailure,
} from "../token-exchange.js";

interface MockInit {
  headers?: Record<string, string> | Headers;
  body?: string;
}

function mockFetch(
  handler: (form: URLSearchParams, headers: Headers) => Response
): typeof fetch {
  return (async (_input: unknown, init?: MockInit) => {
    const rawHeaders = init?.headers;
    const headers = new Headers();
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => {
        headers.set(k, v);
      });
    } else if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) headers.set(k, v);
    }
    const body = typeof init?.body === "string" ? init.body : "";
    const form = new URLSearchParams(body);
    return handler(form, headers);
  }) as unknown as typeof fetch;
}

describe("TokenExchangeClient", () => {
  it("submits standard RFC 8693 parameters with client_secret_basic", async () => {
    let seenForm: URLSearchParams | undefined;
    let seenHeaders: Headers | undefined;
    const fetchImpl = mockFetch((form, headers) => {
      seenForm = form;
      seenHeaders = headers;
      return new Response(
        JSON.stringify({
          access_token: "new-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 1800,
          scope: "campaign:read",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = new TokenExchangeClient({
      endpoint: "https://idp.test/token",
      auth: { method: "client_secret_basic", clientId: "cid", clientSecret: "csec" },
      fetchImpl,
    });
    const res = await client.exchange({
      subjectToken: "sub-token",
      resource: ["t1", "t2"],
      scope: ["campaign:read"],
    });
    expect(res.access_token).toBe("new-token");
    expect(seenForm?.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:token-exchange"
    );
    expect(seenForm?.get("subject_token")).toBe("sub-token");
    expect(seenForm?.getAll("resource")).toEqual(["t1", "t2"]);
    expect(seenForm?.get("scope")).toBe("campaign:read");
    expect(seenHeaders?.get("authorization")).toMatch(/^Basic /);
  });

  it("throws TokenExchangeFailure on non-2xx with parsed body", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "insufficient_scope",
            missing: { "tenant-b": ["campaign:write"] },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
    );
    const client = new TokenExchangeClient({
      endpoint: "https://idp.test/token",
      auth: { method: "none", clientId: "cid" },
      fetchImpl,
    });
    await expect(
      client.exchange({ subjectToken: "x", resource: "t1", scope: "s" })
    ).rejects.toMatchObject({
      name: "TokenExchangeFailure",
      status: 400,
      body: { error: "insufficient_scope" },
    });
  });

  it("uses client_secret_post when configured", async () => {
    let seenForm: URLSearchParams | undefined;
    const fetchImpl = mockFetch((form) => {
      seenForm = form;
      return new Response(
        JSON.stringify({
          access_token: "t",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
        })
      );
    });
    const client = new TokenExchangeClient({
      endpoint: "https://idp.test/token",
      auth: { method: "client_secret_post", clientId: "cid", clientSecret: "csec" },
      fetchImpl,
    });
    await client.exchange({ subjectToken: "x" });
    expect(seenForm?.get("client_id")).toBe("cid");
    expect(seenForm?.get("client_secret")).toBe("csec");
  });
});
