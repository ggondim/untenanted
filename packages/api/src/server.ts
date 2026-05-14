import Fastify, { type FastifyInstance } from "fastify";
import {
  JwtVerifier,
  TokenExchangeClient,
  createTenancyMiddleware,
  type ClientAuth,
} from "@untenanted/middleware";
import type { Config } from "./config.js";
import { createDb, type DB } from "./db/index.js";
import { TenantRepository } from "./repos/tenant.js";
import { UserAuthzRepository } from "./repos/user-authz.js";
import { OrgAuthzRepository } from "./repos/org-authz.js";
import { IamService } from "./services/iam.js";
import { tenantsRoutes } from "./routes/tenants.js";
import { iamPublicRoutes } from "./routes/iam-public.js";
import { iamInternalRoutes } from "./routes/iam-internal.js";
import { webhookRoutes } from "./routes/webhook.js";
import { createZitadelAdapter } from "@untenanted/adapter-zitadel";

export interface BuildServerOptions {
  config: Config;
  /** Optional override; tests inject their own DB. */
  db?: DB;
  /** Disable the tenancy/JWT middleware (useful in unit tests). */
  disableAuth?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  db: DB;
  shutdown: () => Promise<void>;
}

export async function buildServer(opts: BuildServerOptions): Promise<BuiltServer> {
  const { config } = opts;
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : {
              target: "pino-pretty",
              options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
            },
    },
  });

  let dbResources: { db: DB; close: () => Promise<void> };
  if (opts.db) {
    dbResources = { db: opts.db, close: async () => {} };
  } else {
    const { db, pool } = createDb(config);
    dbResources = {
      db,
      close: async () => {
        await db.destroy();
        await pool.end();
      },
    };
  }

  const tenants = new TenantRepository(dbResources.db);
  const userAuthz = new UserAuthzRepository(dbResources.db);
  const orgAuthz = new OrgAuthzRepository(dbResources.db);
  const iam = new IamService(userAuthz, orgAuthz);

  // ---- Health ----
  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async (_req, reply) => {
    try {
      await dbResources.db.selectFrom("tenants").select(["id"]).limit(0).execute();
      return { ok: true };
    } catch (e) {
      app.log.error({ err: e }, "readiness check failed");
      return reply.code(503).send({ ok: false, error: "db_unavailable" });
    }
  });

  // ---- Internal endpoints (shared secret) registered first; do NOT share auth middleware ----
  await app.register(async (internalApp) => {
    await internalApp.register(
      iamInternalRoutes({
        iam,
        sharedSecret: config.INTERNAL_AUTH_SECRET,
      })
    );
    await internalApp.register(
      webhookRoutes({
        userAuthz,
        orgAuthz,
        sharedSecret: config.WEBHOOK_AUTH_SECRET,
      })
    );
  });

  // ---- Public/IAM endpoints under JWT + tenancy middleware ----
  await app.register(async (publicApp) => {
    if (!opts.disableAuth) {
      const verifier = new JwtVerifier({
        jwksUri: config.IDP_JWKS_URI,
        issuer: config.IDP_ISSUER,
        audience: config.IDP_AUDIENCE,
        claimNames: {
          orgId: config.CLAIM_ORG_ID,
          tids: config.CLAIM_TIDS,
          scope: config.CLAIM_SCOPE,
          subject: config.CLAIM_SUBJECT,
        },
      });
      const auth: ClientAuth = config.IDP_CLIENT_SECRET
        ? {
            method: "client_secret_basic",
            clientId: config.IDP_CLIENT_ID,
            clientSecret: config.IDP_CLIENT_SECRET,
          }
        : { method: "none", clientId: config.IDP_CLIENT_ID };
      const exchange = new TokenExchangeClient({
        endpoint: config.IDP_TOKEN_ENDPOINT,
        auth,
      });
      // Call the plugin function directly (no register()) so its preHandler
      // hook applies to sibling routes in this same scope. Wrapping it in
      // `register` would create an encapsulation context that the hook
      // wouldn't escape.
      await createTenancyMiddleware({
        verifier,
        tokenExchange: exchange,
      })(publicApp, {});
    }

    await publicApp.register(tenantsRoutes({ tenants }));
    await publicApp.register(
      iamPublicRoutes({
        iam,
        userAuthz,
        orgAuthz,
        claimOrgIdName: config.CLAIM_ORG_ID,
      })
    );
  });

  // ---- Optional IdP adapters (opt-in via IDP_ADAPTERS env) ----
  await app.register(async (adapterApp) => {
    if (config.IDP_ADAPTERS.includes("zitadel")) {
      await createZitadelAdapter({
        iam: {
          listUserTenants: (userId, orgId) => iam.listUserTenants(userId, orgId),
          deleteAllUserAuthz: (userId) => userAuthz.deleteAllForUser(userId),
          deleteAllOrgAuthz: (orgId) => orgAuthz.deleteAllForOrg(orgId),
        },
        signingKeys: config.ADAPTER_ZITADEL_SIGNING_KEYS,
        orgClaim: config.ADAPTER_ZITADEL_ORG_CLAIM ?? config.CLAIM_ORG_ID,
        tidsClaim: config.ADAPTER_ZITADEL_TIDS_CLAIM ?? config.CLAIM_TIDS,
        routePrefix: config.ADAPTER_ZITADEL_ROUTE_PREFIX,
      })(adapterApp, {});
    }
  });

  return {
    app,
    db: dbResources.db,
    shutdown: async () => {
      await app.close();
      await dbResources.close();
    },
  };
}
