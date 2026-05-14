import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { requireScope, requireAllScopes } from "../scope-guard.js";
import type { DecodedToken } from "../jwt-verifier.js";

function makeToken(scopes: string[]): DecodedToken {
  return {
    raw: "raw",
    payload: {},
    subject: "u",
    orgId: "o",
    tids: [],
    scopes: new Set(scopes),
    isExpired: false,
  };
}

describe("requireScope", () => {
  it("401 when no token attached", async () => {
    const app = Fastify();
    app.get("/r", { preHandler: requireScope("campaign:write") }, async () => ({
      ok: true,
    }));
    const res = await app.inject({ method: "GET", url: "/r" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403 when scope missing", async () => {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      req.token = makeToken(["campaign:read"]);
    });
    app.get("/r", { preHandler: requireScope("campaign:write") }, async () => ({
      ok: true,
    }));
    const res = await app.inject({ method: "GET", url: "/r" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "insufficient_scope" });
    await app.close();
  });

  it("200 when scope present", async () => {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      req.token = makeToken(["campaign:read", "campaign:write"]);
    });
    app.get("/r", { preHandler: requireScope("campaign:write") }, async () => ({
      ok: true,
    }));
    const res = await app.inject({ method: "GET", url: "/r" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("requireAllScopes", () => {
  it("403 when any scope missing, body lists missing", async () => {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      req.token = makeToken(["a"]);
    });
    app.get(
      "/r",
      { preHandler: requireAllScopes(["a", "b"]) },
      async () => ({ ok: true })
    );
    const res = await app.inject({ method: "GET", url: "/r" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ missing: ["b"] });
    await app.close();
  });
});
