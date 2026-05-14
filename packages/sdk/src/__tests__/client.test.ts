import { describe, expect, it } from "vitest";
import { UntenantedClient, UntenantedHttpError } from "../client.js";

interface SeenRequest {
  url: string;
  init: {
    method?: string;
    headers?: Record<string, string> | Headers;
    body?: string;
  };
}

function mockFetch(handler: (req: SeenRequest) => Response): typeof fetch {
  return (async (input: unknown, init?: SeenRequest["init"]) => {
    return handler({ url: String(input), init: init ?? {} });
  }) as unknown as typeof fetch;
}

function getHeader(
  h: Record<string, string> | Headers | undefined,
  name: string
): string | null {
  if (!h) return null;
  if (h instanceof Headers) return h.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

describe("UntenantedClient", () => {
  it("sends bearer + tenant-token headers and parses JSON", async () => {
    let seen: SeenRequest | undefined;
    const client = new UntenantedClient({
      baseUrl: "https://api.example",
      getToken: () => "PLATFORM",
      getTenantToken: () => "TENANT",
      fetchImpl: mockFetch((r) => {
        seen = r;
        return new Response(
          JSON.stringify({ tenants: [], nextCursor: null }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }),
    });
    const out = await client.tenants.list({ limit: 10 });
    expect(out.tenants).toEqual([]);
    expect(seen?.url).toBe("https://api.example/tenants?limit=10");
    expect(getHeader(seen?.init.headers, "authorization")).toBe("Bearer PLATFORM");
    expect(getHeader(seen?.init.headers, "tenant-token")).toBe("TENANT");
  });

  it("throws UntenantedHttpError on non-2xx", async () => {
    const client = new UntenantedClient({
      baseUrl: "https://api.example",
      fetchImpl: mockFetch(
        () =>
          new Response(JSON.stringify({ error: "boom" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          })
      ),
    });
    await expect(client.tenants.get("x")).rejects.toBeInstanceOf(
      UntenantedHttpError
    );
  });

  it("uses bypassAuth for internal validate-exchange", async () => {
    let seen: SeenRequest | undefined;
    const client = new UntenantedClient({
      baseUrl: "https://api.example",
      getToken: () => "PLATFORM",
      fetchImpl: mockFetch((r) => {
        seen = r;
        return new Response(
          JSON.stringify({ ok: true, effectiveScopes: ["s"] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }),
    });
    const out = await client.internal.validateExchange(
      {
        userId: "u",
        orgId: "o",
        requestedTids: ["t"],
        requestedScopes: ["s"],
      },
      "internal-secret"
    );
    expect(out).toMatchObject({ ok: true });
    expect(getHeader(seen?.init.headers, "authorization")).toBeNull();
    expect(getHeader(seen?.init.headers, "x-internal-auth")).toBe(
      "internal-secret"
    );
  });
});
