# Plan — Untenanted: Aggregated IAM API for multi-tenant (IdP-agnostic)

## Context

SPEC.md describes an architecture for multi-tenant authorization in which **tenant lives 100% in the application domain** and the IdP (Zitadel or another) handles only identity/authentication. The IdP is extended via webhook (Action v2 in Zitadel) which enriches tokens with `tids` + scopes based on the domain storage.

Objective of this plan: implement this model in **TypeScript**, as a **monorepo of 4 packages**, with endpoints and middlewares **generic for any IdP** (RFC-standard only). Zitadel is not mentioned in code — any IdP that speaks OIDC + JWKS + RFC 8693 (Token Exchange) and that can call webhooks with a normalized payload works.

### How we keep the API IdP-agnostic

- **Token validation**: configurable JWKS endpoint + RFC 7515/7517/7519 verification via `jose`. There is no HTTP client of the IdP in the code.
- **Token Exchange (in-line re-exchange)**: calls the IdP's token endpoint in standard RFC 8693 format. Endpoint URL comes from config.
- **Webhook events**: internal endpoints accept **normalized payload** (not native to the IdP). Operator writes a minimal adapter in the IdP (Zitadel Action, Keycloak SPI, Auth0 hook, etc.) that translates the native payload to the normalized format.
- **`org_id`**: comes from the token claim (for self-service endpoints) or from the normalized webhook payload (for `validate-exchange`). Admin endpoints that need arbitrary `org_id` receive it as query param — caller's responsibility to resolve.

---

## Stack

- **Runtime**: Node.js 20+ (LTS).
- **Web**: Fastify 4 (typed, schema-driven, plugins).
- **DB**: Postgres 16 + `pg` driver + Kysely (type-safe query builder, no ORM).
- **Migrations**: Kysely migrator (TS-native, no external tool).
- **JWT/JWKS**: `jose` (RFC-compliant, well-maintained).
- **Validation**: Zod (shared across `api`, `sdk`, `types`).
- **Monorepo**: pnpm workspaces + Turbo (build orchestration).
- **Build**: tsup per package.
- **Lint/format**: minimal ESLint + Prettier.

---

## Monorepo structure

```
untenanted/
├── package.json                    # workspaces root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── turbo.json
├── .env.example
├── docker-compose.yml              # dev standalone: pg + api
├── docker-compose.shared-pg.yml    # api-only (external pg, e.g. shared with Zitadel)
├── README.md
├── infra/
│   └── postgres/
│       └── init.sql                # creates database + dedicated user (idempotent)
└── packages/
    ├── types/                      # @untenanted/types
    │   ├── package.json
    │   └── src/
    │       ├── index.ts
    │       ├── domain.ts           # Tenant, Authorization, ScopeSet
    │       ├── api.ts              # Zod schemas: request/response DTOs
    │       └── webhook.ts          # Zod schemas: normalized events
    ├── middleware/                 # @untenanted/middleware
    │   ├── package.json
    │   └── src/
    │       ├── index.ts
    │       ├── jwt-verifier.ts     # createJwtVerifier({jwksUri, issuer, audience})
    │       ├── tenancy.ts          # createTenancyMiddleware({...}) - reads tenant-token, in-line re-exchange
    │       ├── scope-guard.ts      # requireScope("campaign:write")
    │       ├── tenancy-filter.ts   # buildTenancyWhere(tids) -> Kysely expr
    │       └── token-exchange.ts   # rfc8693 client (subject_token + resource + scope)
    ├── sdk/                        # @untenanted/sdk
    │   ├── package.json
    │   └── src/
    │       ├── index.ts
    │       └── client.ts           # UntenantedClient — typed fetch over @untenanted/types
    └── api/                        # @untenanted/api
        ├── package.json
        ├── Dockerfile
        ├── src/
        │   ├── main.ts             # entrypoint
        │   ├── server.ts           # fastify build + plugins
        │   ├── config.ts           # env vars schema (Zod)
        │   ├── db/
        │   │   ├── index.ts        # Kysely instance
        │   │   ├── schema.ts       # Database interface (Kysely types)
        │   │   └── migrations/
        │   │       ├── 001_tenants.ts
        │   │       ├── 002_user_tenant_authorization.ts
        │   │       └── 003_org_tenant_authorization.ts
        │   ├── repos/
        │   │   ├── tenant.ts
        │   │   ├── user-authz.ts
        │   │   └── org-authz.ts
        │   ├── services/
        │   │   └── iam.ts          # listUserTenants, effectiveRoles, validateExchange
        │   └── routes/
        │       ├── tenants.ts      # CRUD of tenants (domain)
        │       ├── iam-public.ts   # discovery + delegation
        │       ├── iam-internal.ts # validate-exchange
        │       └── webhook.ts      # normalized events (user.removed, org.removed)
        └── tsconfig.json
```

---

## Contracts (summary)

### `@untenanted/types` — shared Zod schemas

```ts
// domain.ts
const Tenant = z.object({
  id: z.string(),
  name: z.string(),
  ownerOrgId: z.string().nullable(),  // informational; does not authorize
  status: z.enum(["active","suspended","archived"]),
  plan: z.string().nullable(),
  properties: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});

const UserTenantAuthz = z.object({
  userId: z.string(), tenantId: z.string(), roles: z.array(z.string()),
  createdAt: z.string().datetime(),
});
const OrgTenantAuthz = z.object({
  orgId: z.string(), tenantId: z.string(), roles: z.array(z.string()),
  createdAt: z.string().datetime(),
});

// api.ts — requests/responses
const ListUserTenantsResponse = z.object({
  tenants: z.array(z.object({
    tenantId: z.string(),
    effectiveRoles: z.array(z.string()),
    paths: z.array(z.enum(["direct","org"])),
  })),
});

const ValidateExchangeRequest = z.object({
  userId: z.string(),
  orgId: z.string(),                    // passed by the IdP adapter
  requestedTids: z.array(z.string()),
  requestedScopes: z.array(z.string()),
});
const ValidateExchangeResponse = z.union([
  z.object({ ok: z.literal(true), effectiveScopes: z.array(z.string()) }),
  z.object({ ok: z.literal(false), missing: z.record(z.array(z.string())) }),
]);

// webhook.ts — normalized events
const NormalizedWebhookEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user.removed"), userId: z.string() }),
  z.object({ type: z.literal("org.removed"), orgId: z.string() }),
]);
```

### `@untenanted/middleware` — generic middlewares

```ts
// jwt-verifier.ts
createJwtVerifier({
  jwksUri: string,         // RFC 8414 / 7517 (discovered via .well-known or config)
  issuer: string,
  audience: string | string[],
  claimNames?: {           // configurable: vocabulary of the IdP
    orgId?: string,        // default "org_id"
    tids?: string,         // default "tids"
    scope?: string,        // default "scope"
  },
}) -> FastifyPlugin

// tenancy.ts
createTenancyMiddleware({
  verifier: JwtVerifier,
  tokenExchange: {
    endpoint: string,
    clientId: string,
    clientSecret?: string,  // or client_assertion
  },
  claimNames?: {...},
  headerName?: string,      // default "tenant-token"
  newTokenHeader?: string,  // default "x-new-tenant-token"
}) -> FastifyPlugin

// scope-guard.ts
requireScope(scope: string) -> FastifyPreHandler

// tenancy-filter.ts
buildTenancyWhere<T>(qb: Kysely<T>, column: string, tids: string[]) -> ExpressionBuilder
// produces: column IS NULL OR column IN (tids)

// token-exchange.ts
exchangeToken({...}) -> Promise<{access_token, expires_in, scope, ...}>
// pure RFC 8693: grant_type=urn:ietf:params:oauth:grant-type:token-exchange
```

Nothing in these middlewares knows about Zitadel. Everything is resolved by config: `jwksUri`, `issuer`, `audience`, claim names. The name of the `tids` claim is configurable (default `tids`, but can be `urn:app:tids` if the operator wants).

### `@untenanted/api` — endpoints

Exact match with SPEC §6:

```
# Tenants (domain CRUD)
GET    /tenants                          (list, paginated)
POST   /tenants                          (create — requires scope iam:tenant:create)
GET    /tenants/:id
PATCH  /tenants/:id                      (requires scope in token + tid in token)
DELETE /tenants/:id

# IAM Discovery
GET    /iam/users/me/tenants             (uses org_id from token)
GET    /iam/users/:userId/tenants        (?orgId= required — admin)
GET    /iam/tenants/:tenantId/users      (lists direct + orgs with authz; users-via-org not enumerated)
GET    /iam/tenants/:tenantId/organizations
GET    /iam/organizations/:orgId/tenants

# IAM Mutation (requires iam:delegate + possession of roles)
POST   /iam/users/:userId/tenants/:tenantId       body: {roles, callerOrgId?}
DELETE /iam/users/:userId/tenants/:tenantId
POST   /iam/organizations/:orgId/tenants/:tenantId body: {roles}
DELETE /iam/organizations/:orgId/tenants/:tenantId

# Internal (consumed by the IdP webhook adapter)
POST   /iam/internal/validate-exchange
       body: ValidateExchangeRequest
       auth: shared secret (header X-Internal-Auth)

# Normalized webhook (IdP adapter translates and calls)
POST   /webhooks/events
       body: NormalizedWebhookEvent
       auth: shared secret (header X-Webhook-Auth)
```

### `@untenanted/sdk` — typed client

```ts
const client = new UntenantedClient({
  baseUrl: "https://untenanted.example",
  getToken: () => myPlatformToken,
});
await client.iam.listUserTenants("me");
await client.iam.grantUserAccess({ userId, tenantId, roles });
```

Types imported from `@untenanted/types`. No OpenAPI generation (keeps contracts as source-of-truth in Zod).

---

## Core logic (services/iam.ts)

```ts
// Resolves effective roles for a (user, tenant) pair using direct + org-to-tenant paths
async function effectiveRoles(userId, orgId, tenantId): Promise<Set<string>>

// Lists accessible tenants with effective roles + paths used
async function listUserTenants(userId, orgId): Promise<Map<tenantId, {roles, paths}>>

// Webhook validation: requested ⊆ effective in EACH tid (full-fail)
async function validateExchange(userId, orgId, requestedTids, requestedScopes):
  Promise<{ok: true, effectiveScopes} | {ok: false, missing}>

// Delegation: caller only delegates roles that they themselves possess
async function canDelegate(callerUserId, callerOrgId, tenantId, requestedRoles): Promise<boolean>
```

---

## Storage

Kysely migrations. Three tables + indexes. **No** `user_org_index` (decided: org comes from token/payload).

```sql
CREATE TABLE tenants (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  owner_org_id  text,
  status        text NOT NULL DEFAULT 'active',
  plan          text,
  properties    jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_tenant_authorization (
  user_id    text NOT NULL,
  tenant_id  text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  roles      text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX ON user_tenant_authorization (tenant_id);

CREATE TABLE org_tenant_authorization (
  org_id     text NOT NULL,
  tenant_id  text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  roles      text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, tenant_id)
);
CREATE INDEX ON org_tenant_authorization (tenant_id);
```

`tenants.id` is `text` (not UUID) to allow the operator to choose the format (slug, ULID, UUID). Logical FKs (`user_id`, `org_id`) have no DB constraint — cleanup via `user.removed`/`org.removed` webhook.

---

## Config (env vars)

Read via `config.ts` with Zod:

```
# Server
HTTP_PORT=3000
LOG_LEVEL=info

# Database — configurable to coexist with other postgres (Zitadel)
DB_HOST=postgres
DB_PORT=5432
DB_NAME=untenanted
DB_USER=untenanted
DB_PASSWORD=untenanted
DB_SSL=disable

# IdP (RFC-standard only)
IDP_JWKS_URI=https://auth.example/oauth/v2/keys
IDP_ISSUER=https://auth.example
IDP_AUDIENCE=platform-api
IDP_TOKEN_ENDPOINT=https://auth.example/oauth/v2/token
IDP_CLIENT_ID=untenanted-api
IDP_CLIENT_SECRET=...

# Claim names (configurable per IdP)
CLAIM_ORG_ID=org_id
CLAIM_TIDS=tids
CLAIM_SCOPE=scope

# Internal auth secrets
INTERNAL_AUTH_SECRET=...        # for /iam/internal/*
WEBHOOK_AUTH_SECRET=...         # for /webhooks/events

# Token TTLs (guiding, not used by the API)
```

The separate `DB_*` (instead of a single DATABASE_URL) allow combining with other docker-composes that already have postgres in the environment — just point `DB_HOST` to the existing service.

---

## Docker and deployment

### `docker-compose.yml` — dev standalone

Brings up **postgres + api** isolated. Postgres with `init.sql` that creates database `untenanted` + dedicated user, but **leaves postgres open** so that other composes can add databases (running their own init scripts via volumes).

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: untenanted-postgres
    environment:
      POSTGRES_USER: ${POSTGRES_ADMIN_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_ADMIN_PASSWORD:-postgres}
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./infra/postgres/init.sql:/docker-entrypoint-initdb.d/01-untenanted.sql:ro
    ports:
      - "${POSTGRES_HOST_PORT:-5432}:5432"
    healthcheck:
      test: ["CMD","pg_isready","-U","${POSTGRES_ADMIN_USER:-postgres}"]
      interval: 5s
    networks: [untenanted]

  api:
    build: { context: ., dockerfile: packages/api/Dockerfile }
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: ${DB_NAME:-untenanted}
      DB_USER: ${DB_USER:-untenanted}
      DB_PASSWORD: ${DB_PASSWORD:-untenanted}
      IDP_JWKS_URI: ${IDP_JWKS_URI}
      # ... rest of envs
    depends_on:
      postgres: { condition: service_healthy }
    ports:
      - "${API_HOST_PORT:-3000}:3000"
    networks: [untenanted]

volumes:
  postgres-data:

networks:
  untenanted:
    name: untenanted
```

### `docker-compose.shared-pg.yml` — "external postgres" mode

Brings up **only the api**, connects to an already-existing postgres (e.g., Zitadel's). Useful in environments where the operator wants a single postgres with multiple databases.

```yaml
services:
  api:
    build: { context: ., dockerfile: packages/api/Dockerfile }
    environment:
      DB_HOST: ${DB_HOST}           # required
      DB_PORT: ${DB_PORT:-5432}
      DB_NAME: ${DB_NAME:-untenanted}
      DB_USER: ${DB_USER:-untenanted}
      DB_PASSWORD: ${DB_PASSWORD}
      IDP_JWKS_URI: ${IDP_JWKS_URI}
      # ... etc
    ports: ["${API_HOST_PORT:-3000}:3000"]
    networks:
      - default
      - shared-pg-net
networks:
  shared-pg-net:
    external: true                  # network from the other compose (Zitadel)
```

Operator combines via `docker compose -f docker-compose.shared-pg.yml --env-file .env up`, ensuring the Zitadel network already exists and that the `untenanted` database was created in it (running `infra/postgres/init.sql` manually or via volume in the parent compose).

### `init.sql`

```sql
-- Idempotent. Creates DB + dedicated user. Does not touch other databases.
CREATE USER untenanted WITH PASSWORD 'untenanted';
CREATE DATABASE untenanted OWNER untenanted;
\connect untenanted
GRANT ALL ON SCHEMA public TO untenanted;
```

Can coexist peacefully with Zitadel's `init.sql` (postgres loads all scripts in `/docker-entrypoint-initdb.d` in order).

### Dockerfile

Multi-stage:
1. base node:20-alpine + pnpm
2. install deps with workspace
3. build `@untenanted/types`, `@untenanted/middleware`, `@untenanted/api`
4. runtime: copy only dist + production node_modules
5. entrypoint: `node dist/main.js` (which runs migrations on startup + brings up Fastify)

---

## Migrations on boot

`api/src/main.ts` calls `migrator.migrateToLatest()` before bringing up Fastify. Idempotent. In production the operator can disable via env (`AUTO_MIGRATE=false`) and run `pnpm migrate` separately.

---

## End-to-end verification

1. **Bring up**: `cp .env.example .env && docker compose up --build`. API responds at `http://localhost:3000/health`.
2. **Migrations**: startup log shows applied migrations; `psql` confirms tables `tenants`, `user_tenant_authorization`, `org_tenant_authorization`.
3. **Create tenant** (without auth in the testing MVP — or with `INTERNAL_AUTH_SECRET` bypass in the header): `POST /tenants {id, name}`. `GET /tenants/:id` returns.
4. **Authz**: `POST /iam/organizations/org-a/tenants/tenant-1 {roles: ["campaign:read"]}` (with `X-Internal-Auth`). `GET /iam/organizations/org-a/tenants` returns the tenant.
5. **Discovery**: generate test JWT signed by local key (dev script at `packages/api/scripts/issue-test-token.ts`), `IDP_JWKS_URI` points to a static server that serves the public key. `GET /iam/users/me/tenants` with `Authorization: Bearer ...` returns the merge of direct + via-org.
6. **validate-exchange**: `POST /iam/internal/validate-exchange {userId, orgId, requestedTids, requestedScopes}` with `X-Internal-Auth`. Returns `{ok:true, effectiveScopes}` or `{ok:false, missing}` according to scenarios in spec §12.
7. **Webhook**: `POST /webhooks/events {type:"user.removed", userId:"u1"}` with `X-Webhook-Auth`. `user_tenant_authorization` for that user is cleaned up.
8. **Shared-postgres mode**: bring up an `docker compose -f other.yml` that already has postgres; run `docker compose -f docker-compose.shared-pg.yml up` pointing `DB_HOST` to that postgres; API connects normally.
9. **SDK**: test script at `packages/sdk/examples/list-tenants.ts` consuming the API with `UntenantedClient`. Confirms types compile without `any`.

---

## What is out of scope for this MVP

- Concrete adapter implementation for Zitadel (Action v2 script). Operator writes based on the normalized contracts.
- Cache of `validate-exchange` (Redis with short TTL). Spec mentions it as an optimization; leave for later with a simple hook in the service.
- Generic repository of global/tenanted resources (spec §13). Resides in `@untenanted/middleware` as a helper (`buildTenancyWhere`), but the complete repository is the responsibility of the downstream app — it is outside the scope of the 4 packages.
- Denylist of `jti` (immediate revocation). Spec lists it as "rarely needed".
- OpenAPI generation. Contracts live in Zod; SDK consumes directly.
- Dedicated audit log (mutation events go to standard structured log).

---

## Order of implementation

1. Root: monorepo skeleton (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `turbo.json`, `.env.example`).
2. `@untenanted/types`: Zod schemas (domain, api, webhook).
3. `@untenanted/middleware`: jwt-verifier, token-exchange, scope-guard, tenancy, tenancy-filter.
4. `@untenanted/api`: config, db + migrations, repos, services/iam, routes, server, main.
5. `@untenanted/sdk`: typed client.
6. Docker: `Dockerfile`, `docker-compose.yml`, `docker-compose.shared-pg.yml`, `infra/postgres/init.sql`.
7. Short `README.md`: how to bring it up, how to integrate webhook adapter, env vars.

---

## Critical files (list for review)

- `pnpm-workspace.yaml`, `package.json` (root)
- `packages/types/src/{domain,api,webhook}.ts`
- `packages/middleware/src/{jwt-verifier,tenancy,scope-guard,tenancy-filter,token-exchange}.ts`
- `packages/api/src/config.ts`
- `packages/api/src/db/migrations/*`
- `packages/api/src/services/iam.ts`
- `packages/api/src/routes/{iam-public,iam-internal,webhook,tenants}.ts`
- `packages/api/src/main.ts`
- `packages/sdk/src/client.ts`
- `docker-compose.yml`, `docker-compose.shared-pg.yml`, `infra/postgres/init.sql`
- `packages/api/Dockerfile`
