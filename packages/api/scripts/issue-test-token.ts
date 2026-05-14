/* eslint-disable no-console */
/**
 * Dev-only: issues a signed JWT against a local key pair for testing the API.
 *
 * Usage:
 *   pnpm --filter @untenanted/api issue-test-token -- \
 *     --sub user-1 --org org-a --aud platform-api --iss http://localhost:8080 \
 *     --scope "iam:read iam:delegate" --tids "tenant-a,tenant-b"
 *
 * It also exposes a /jwks.json endpoint at the chosen port so the API can verify
 * the produced tokens (point IDP_JWKS_URI at it).
 */
import http from "node:http";
import { writeFileSync } from "node:fs";
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from "jose";

interface Args {
  sub: string;
  org: string;
  aud: string;
  iss: string;
  scope?: string;
  tids?: string;
  ttl: number;
  port: number;
  serve: boolean;
  print: boolean;
}

function parseArgs(argv: string[]): Args {
  const o: Args = {
    sub: "user-1",
    org: "org-a",
    aud: "platform-api",
    iss: "http://localhost:9091",
    scope: undefined,
    tids: undefined,
    ttl: 3600,
    port: 9091,
    serve: true,
    print: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--sub": o.sub = String(next); i++; break;
      case "--org": o.org = String(next); i++; break;
      case "--aud": o.aud = String(next); i++; break;
      case "--iss": o.iss = String(next); i++; break;
      case "--scope": o.scope = String(next); i++; break;
      case "--tids": o.tids = String(next); i++; break;
      case "--ttl": o.ttl = Number(next); i++; break;
      case "--port": o.port = Number(next); i++; break;
      case "--no-serve": o.serve = false; break;
      default: break;
    }
  }
  return o;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = "untenanted-dev-key-1";

  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = "RS256";
  const jwksBody = JSON.stringify({ keys: [jwk] });

  if (args.serve) {
    const server = http.createServer((req, res) => {
      if (req.url === "/jwks.json") {
        res.setHeader("content-type", "application/json");
        res.end(jwksBody);
      } else if (req.url === "/health") {
        res.end("ok");
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    server.listen(args.port, "127.0.0.1", () => {
      console.error(`jwks available at http://127.0.0.1:${args.port}/jwks.json`);
    });
  }

  const claims: Record<string, unknown> = { sub: args.sub, org_id: args.org };
  if (args.scope) claims.scope = args.scope;
  if (args.tids) claims.tids = args.tids.split(",").map((s) => s.trim()).filter(Boolean);

  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(args.iss)
    .setAudience(args.aud)
    .setIssuedAt(now)
    .setExpirationTime(now + args.ttl)
    .setSubject(args.sub)
    .sign(privateKey as KeyLike);

  if (args.print) {
    console.log(token);
  }
  writeFileSync(".dev-token", token);
  console.error("token written to .dev-token");

  if (!args.serve) process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
