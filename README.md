# Untenanted

IdP-agnostic aggregated IAM API for multi-tenant authorization. Implements the
architecture described in [SPEC.md](SPEC.md) and detailed in [PLAN.md](PLAN.md):
tenants live 100% in the domain; any IdP that speaks OIDC + JWKS + RFC 8693
plugs in via configuration and a thin adapter.

## Packages

| Package | What it is |
|---|---|
| [`@untenanted/types`](packages/types) | Zod schemas + TypeScript types shared across api and sdk |
| [`@untenanted/middleware`](packages/middleware) | RFC-standard middlewares: JWT verifier (JWKS), RFC 8693 token exchange client, tenancy middleware with in-line re-exchange, scope guard, tenancy filter helpers, shared-secret guard |
| [`@untenanted/adapter-zitadel`](packages/adapter-zitadel) | Opt-in Fastify plugin that bridges Zitadel Action v2 payloads (PreAccessToken + events) to the IdP-agnostic core. Verifies `ZITADEL-Signature` (HMAC-SHA256). Loaded into the api process when `IDP_ADAPTERS=zitadel`. |
| [`@untenanted/api`](packages/api) | Fastify server exposing the aggregated IAM API + storage (Kysely/Postgres) + migrations |
| [`@untenanted/sdk`](packages/sdk) | Typed HTTP client for the API |

## Quick start (Docker)

```bash
cp .env.example .env
# Edit .env: at minimum set IDP_JWKS_URI, IDP_ISSUER, IDP_AUDIENCE,
# IDP_TOKEN_ENDPOINT, IDP_CLIENT_ID, INTERNAL_AUTH_SECRET, WEBHOOK_AUTH_SECRET.

docker compose up --build
# API is at http://localhost:3000
# GET /health   -> { "ok": true }
# GET /ready    -> { "ok": true } once migrations applied
```

The first boot of the postgres container runs `infra/postgres/init.sql`, which
creates the `untenanted` database + user. On every API boot, pending migrations
are applied automatically (toggleable via `AUTO_MIGRATE`).

## Quick start (local node)

```bash
pnpm install
pnpm build
docker compose up -d postgres
pnpm --filter @untenanted/api dev
```

## Sharing one Postgres with Zitadel (or any other app)

If you already have a Postgres instance running (typical when Zitadel is in
the same environment), use `docker-compose.shared-pg.yml`:

```bash
# 1) Make sure the untenanted database + user exist in that postgres.
#    Easiest: mount infra/postgres/init.sql into the other compose's
#    /docker-entrypoint-initdb.d on its first boot. Or run it manually:
psql -h <pg-host> -U postgres -f infra/postgres/init.sql

# 2) Make sure the other compose exposes a docker network you can join.
#    Set its name in SHARED_PG_NETWORK (default "shared-pg").

DB_HOST=<pg-service-name-on-that-network> \
SHARED_PG_NETWORK=<network-name> \
docker compose -f docker-compose.shared-pg.yml --env-file .env up
```

All Postgres parameters (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
`DB_PASSWORD`, `DB_SSL`) are configurable via env, so this compose can connect
to a managed Postgres (RDS, Cloud SQL) just as easily.

## How the IdP integration works

The API does not import any IdP-specific SDK. Configuration:

- `IDP_JWKS_URI` — RFC 7517 JWKS endpoint to verify access tokens.
- `IDP_ISSUER` / `IDP_AUDIENCE` — RFC 7519 expectations.
- `IDP_TOKEN_ENDPOINT` — RFC 8693 token endpoint for in-line re-exchange.
- `CLAIM_ORG_ID` / `CLAIM_TIDS` / `CLAIM_SCOPE` / `CLAIM_SUBJECT` —
  overridable claim names so any IdP vocabulary works.

The IdP needs two thin adapters that translate native payloads into the
normalized contracts:

- On token exchange, call `POST /iam/internal/validate-exchange` with
  `{ userId, orgId, requestedTids, requestedScopes }` and the
  `X-Internal-Auth` shared secret. Enrich the resulting token with `tids` +
  `scope` based on the response.
- On user/org removal, call `POST /webhooks/events` with the normalized
  event and the `X-Webhook-Auth` shared secret.

See [examples/idp-adapter](examples/idp-adapter/README.md) for sketches
covering Zitadel Actions v2, Keycloak SPI, and Auth0 Actions.

## Endpoints (from SPEC §6)

```
# Tenant CRUD (domain)
GET    /tenants
POST   /tenants                          requires scope: iam:tenant:create
GET    /tenants/:id
PATCH  /tenants/:id                      requires scope: iam:tenant:update
DELETE /tenants/:id                      requires scope: iam:tenant:delete

# IAM discovery
GET    /iam/users/me/tenants
GET    /iam/users/:userId/tenants?orgId=…   requires scope: iam:read
GET    /iam/tenants/:tenantId/users         requires scope: iam:read
GET    /iam/tenants/:tenantId/organizations requires scope: iam:read
GET    /iam/organizations/:orgId/tenants    requires scope: iam:read

# IAM mutation (requires iam:delegate + caller possesses the roles)
POST   /iam/users/:userId/tenants/:tenantId       body: { roles }
DELETE /iam/users/:userId/tenants/:tenantId
POST   /iam/organizations/:orgId/tenants/:tenantId body: { roles }
DELETE /iam/organizations/:orgId/tenants/:tenantId

# Internal (X-Internal-Auth)
POST   /iam/internal/validate-exchange

# Normalized webhook (X-Webhook-Auth)
POST   /webhooks/events
       body: { "type": "user.removed", "userId": "..." }
            | { "type": "org.removed",  "orgId":  "..." }
```

## Development

```bash
pnpm install
pnpm build         # build all packages
pnpm test          # unit tests for all packages (Postgres not required)
pnpm typecheck

# Postgres-dependent integration tests for the api package:
UNTENANTED_PG_TEST=1 pnpm --filter @untenanted/api test
```

A dev script issues a signed JWT for ad-hoc testing without a real IdP:

```bash
pnpm --filter @untenanted/api issue-test-token -- \
  --sub user-1 --org org-a \
  --iss http://localhost:9091 --aud platform-api \
  --scope "iam:read iam:delegate iam:tenant:create"
# In another shell, point the api at the local JWKS:
IDP_JWKS_URI=http://localhost:9091/jwks.json IDP_ISSUER=http://localhost:9091 \
  IDP_AUDIENCE=platform-api pnpm --filter @untenanted/api dev
```

## Project layout

```
packages/
  types/          shared Zod schemas
  middleware/     RFC-standard middlewares (no IdP awareness)
  api/            Fastify server + storage + migrations
  sdk/            typed HTTP client
examples/
  sdk-usage/              SDK consumption scripts
  idp-adapter/            Zitadel/Keycloak/Auth0 adapter sketches
  global-and-tenanted-app/ Reference repository using the tenancy filter
infra/postgres/init.sql   Postgres bootstrap (idempotent)
docker-compose.yml        Standalone dev stack: pg + api
docker-compose.shared-pg.yml  API-only when pg is provided externally
```

## License

MIT — see [LICENSE](LICENSE).
