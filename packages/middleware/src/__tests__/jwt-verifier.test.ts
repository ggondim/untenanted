import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from "jose";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { JwtVerifier } from "../jwt-verifier.js";

interface KeyMaterial {
  privateKey: KeyLike;
  publicKey: KeyLike;
  kid: string;
  jwksServerUrl: string;
}

async function startJwksServer(publicKey: KeyLike, kid: string): Promise<string> {
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = "RS256";
  const body = JSON.stringify({ keys: [jwk] });
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}/jwks.json`;
}

let mat: KeyMaterial;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = "test-key-1";
  const jwksServerUrl = await startJwksServer(publicKey, kid);
  mat = { privateKey, publicKey, kid, jwksServerUrl };
});

async function issue(
  claims: Record<string, unknown>,
  opts: { expSeconds?: number } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expSeconds ?? 300);
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: mat.kid })
    .setIssuer("https://idp.test")
    .setAudience("platform-api")
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setSubject((claims.sub as string) ?? "user-1")
    .sign(mat.privateKey);
}

describe("JwtVerifier", () => {
  it("verifies a fresh token and exposes claim accessors", async () => {
    const raw = await issue({
      sub: "user-1",
      org_id: "org-a",
      tids: ["t1", "t2"],
      scope: "campaign:read campaign:write",
    });
    const v = new JwtVerifier({
      jwksUri: mat.jwksServerUrl,
      issuer: "https://idp.test",
      audience: "platform-api",
    });
    const tok = await v.verify(raw);
    expect(tok.subject).toBe("user-1");
    expect(tok.orgId).toBe("org-a");
    expect(tok.tids).toEqual(["t1", "t2"]);
    expect([...tok.scopes].sort()).toEqual(["campaign:read", "campaign:write"]);
    expect(tok.isExpired).toBe(false);
  });

  it("rejects token with bad audience", async () => {
    const raw = await issue({ sub: "user-1" });
    const v = new JwtVerifier({
      jwksUri: mat.jwksServerUrl,
      issuer: "https://idp.test",
      audience: "other-api",
    });
    await expect(v.verify(raw)).rejects.toThrow();
  });

  it("allows expired tokens when allowExpired=true and marks them", async () => {
    const raw = await issue(
      { sub: "user-1", tids: ["t1"], scope: "campaign:read" },
      { expSeconds: -10 }
    );
    const v = new JwtVerifier({
      jwksUri: mat.jwksServerUrl,
      issuer: "https://idp.test",
      audience: "platform-api",
    });
    await expect(v.verify(raw)).rejects.toThrow();
    const tok = await v.verify(raw, { allowExpired: true });
    expect(tok.isExpired).toBe(true);
    expect(tok.tids).toEqual(["t1"]);
  });

  it("honors custom claim names", async () => {
    const raw = await issue({
      sub: "user-1",
      "urn:app:org_id": "org-z",
      "urn:app:tids": ["x"],
    });
    const v = new JwtVerifier({
      jwksUri: mat.jwksServerUrl,
      issuer: "https://idp.test",
      audience: "platform-api",
      claimNames: { orgId: "urn:app:org_id", tids: "urn:app:tids" },
    });
    const tok = await v.verify(raw);
    expect(tok.orgId).toBe("org-z");
    expect(tok.tids).toEqual(["x"]);
  });
});
