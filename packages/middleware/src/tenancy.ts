import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { JwtVerifier, type DecodedToken } from "./jwt-verifier.js";
import {
  TokenExchangeClient,
  TokenExchangeFailure,
  type ClientAuth,
  type TokenExchangeClientOptions,
} from "./token-exchange.js";

export interface TenancyMiddlewareOptions {
  verifier: JwtVerifier;
  /**
   * Token exchange client config used for in-line re-exchange when the tenant
   * token's `exp` has passed but its signature is still valid.
   */
  tokenExchange:
    | TokenExchangeClient
    | { endpoint: string; auth: ClientAuth; fetchImpl?: typeof fetch };
  /** Header containing the platform access token. Default "authorization". */
  platformHeader?: string;
  /** Header containing the tenant token. Default "tenant-token". */
  tenantHeader?: string;
  /** Response header to surface a newly-issued tenant token. Default "x-new-tenant-token". */
  newTenantHeader?: string;
  /**
   * Whether requests without a platform token are rejected. Default: true.
   * If false, `request.token` may be undefined and downstream handlers must
   * handle that (useful for fully-public endpoints).
   */
  requirePlatformToken?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Effective token after the middleware (tenant token if present, else platform). */
    token?: DecodedToken;
    /** Original platform token, always present when requirePlatformToken=true. */
    platformToken?: DecodedToken;
  }
}

export function createTenancyMiddleware(
  opts: TenancyMiddlewareOptions
): FastifyPluginAsync {
  const platformHeader = (opts.platformHeader ?? "authorization").toLowerCase();
  const tenantHeader = (opts.tenantHeader ?? "tenant-token").toLowerCase();
  const newTenantHeader = opts.newTenantHeader ?? "x-new-tenant-token";
  const requirePlatform = opts.requirePlatformToken ?? true;

  const exchange =
    opts.tokenExchange instanceof TokenExchangeClient
      ? opts.tokenExchange
      : new TokenExchangeClient(opts.tokenExchange as TokenExchangeClientOptions);

  return async function tenancyPlugin(app: FastifyInstance): Promise<void> {
    app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      const rawAuth = req.headers[platformHeader];
      const rawPlatform = extractBearer(
        typeof rawAuth === "string" ? rawAuth : Array.isArray(rawAuth) ? rawAuth[0] : undefined
      );

      let platform: DecodedToken | undefined;
      if (rawPlatform) {
        try {
          platform = await opts.verifier.verify(rawPlatform);
        } catch (e) {
          void reply.code(401).send({
            error: "invalid_token",
            message: (e as Error).message,
          });
          return reply;
        }
      } else if (requirePlatform) {
        void reply.code(401).send({ error: "unauthenticated" });
        return reply;
      }

      req.platformToken = platform;
      req.token = platform;

      const rawTenant = req.headers[tenantHeader];
      const tenantRaw = typeof rawTenant === "string" ? rawTenant : Array.isArray(rawTenant) ? rawTenant[0] : undefined;
      if (!tenantRaw) {
        return;
      }

      let tenant: DecodedToken;
      try {
        tenant = await opts.verifier.verify(tenantRaw, { allowExpired: true });
      } catch (e) {
        void reply.code(401).send({
          error: "invalid_tenant_token",
          message: (e as Error).message,
        });
        return reply;
      }

      if (tenant.isExpired) {
        if (!platform) {
          void reply.code(401).send({ error: "unauthenticated" });
          return reply;
        }
        const expiredTids = tenant.tids;
        const expiredScopes = [...tenant.scopes];
        try {
          const exchanged = await exchange.exchange({
            subjectToken: platform.raw,
            resource: expiredTids,
            scope: expiredScopes,
          });
          tenant = await opts.verifier.verify(exchanged.access_token);
          void reply.header(newTenantHeader, exchanged.access_token);
        } catch (e) {
          if (e instanceof TokenExchangeFailure) {
            void reply.code(403).send({
              error: "tenant_access_revoked",
              details: e.body,
            });
          } else {
            void reply.code(502).send({
              error: "token_exchange_failed",
              message: (e as Error).message,
            });
          }
          return reply;
        }
      }

      req.token = tenant;
    });
  };
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}
