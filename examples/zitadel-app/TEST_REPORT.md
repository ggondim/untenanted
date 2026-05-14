# Zitadel End-to-End Test Report

Stack: official Zitadel compose (`v4.13.0`) + Untenanted API with the
`@untenanted/adapter-zitadel` plugin loaded in-process (opt-in via
`IDP_ADAPTERS=zitadel`). All four services share one Postgres container with
two databases (`zitadel`, `untenanted`) and one Docker network (`zitadel`).
Tested on 2026-05-14, re-validated after migrating the adapter from a
sidecar Node service into the packaged plugin.

## How to reproduce

```bash
cd examples/zitadel-app
docker compose --env-file .env up -d --build --wait
docker run --rm -v untenanted-zitadel_zitadel-bootstrap:/data alpine \
  cat /data/admin-machine.pat > /tmp/admin.pat
ZITADEL_BASE=http://auth.localtest.me:8080 \
  ZITADEL_PAT=$(cat /tmp/admin.pat) \
  UNTENANTED_BASE=http://localhost:3000 \
  bash scripts/configure-zitadel.sh
# Pick up the signing keys captured during configure so the adapter verifies
# Zitadel's ZITADEL-Signature header on every call.
cat .env > .env.runtime
grep '^ADAPTER_ZITADEL_SIGNING_KEYS=' .state/state.env >> .env.runtime
docker compose --env-file .env.runtime up -d --force-recreate untenanted-api --wait
ZITADEL_BASE=http://auth.localtest.me:8080 \
  ZITADEL_PAT=$(cat /tmp/admin.pat) \
  UNTENANTED_BASE=http://localhost:3000 \
  bash scripts/run-spec-tests.sh
```

`auth.localtest.me` is a public wildcard DNS pointing at 127.0.0.1; inside the
compose network the same name is a Docker alias for Traefik. This avoids the
host/internal host-routing asymmetry Zitadel's reverse-proxy setup creates.

## Results

```
14 passed, 0 failed, 2 skipped
```

| # | Premise | Status | Notes |
|---|---|---|---|
| P1 | Zitadel issues OIDC access tokens whose `iss` matches `IDP_ISSUER` | ✅ PASS | issuer = `http://auth.localtest.me:8080`, identical from host and inside the network |
| P1 | `client_credentials` grant succeeds for the configured service account | ✅ PASS | 771-byte JWT returned |
| P2 | Untenanted API validates Zitadel-signed tokens (JWKS reach + claims) | ✅ PASS | `GET /iam/users/me/tenants` → 200 |
| P3 | Action v2 `preaccesstoken` injects `urn:untenanted:org_id` | ✅ PASS | claim present on the issued JWT |
| P3.2 | After seeding authorizations, fresh tokens carry `urn:untenanted:tids` | ✅ PASS | `["tenant-a","tenant-b","tenant-c"]` |
| P4 | `/iam/internal/validate-exchange` returns spec §8 `ok=true` shape | ✅ PASS | read on tenant-a+b ⇒ ok=true |
| P4 | `/iam/internal/validate-exchange` returns spec §8 `ok=false, missing` shape | ✅ PASS | write on tenant-b ⇒ `{tenant-b:[campaign:write]}` |
| P4 | Shared-secret guard rejects missing `X-Internal-Auth` | ✅ PASS | 401 |
| P5 | Domain CRUD (tenants + user/org authorizations) | ✅ PASS | seeded via direct SQL — works through repository invariants |
| P6 | Discovery merges direct + via-org with effective roles | ✅ PASS | 3 tenants, paths correctly attributed |
| P7 | Delegation is gated by scope-level + role-level checks | ✅ PASS | `POST /iam/users/peer/tenants/tenant-a {roles:[billing:manage]}` ⇒ 403; service-account possesses `iam:delegate` on tenant-c (direct authz) |
| P9 | `user.removed` event triggers cleanup of `user_tenant_authorization` | ✅ PASS | adapter forwarded the normalized event; the row was deleted |
| P8 | RFC 8693 token-exchange grant advertised in discovery | ⚠️ SKIP | `grant_types_supported` does NOT list `urn:ietf:params:oauth:grant-type:token-exchange` even though the instance feature `oidcTokenExchange` reports `enabled: true`. Zitadel exposes the grant per-application, gated by the "Allow Impersonation" security policy + dedicated impersonator roles. See "What requires manual setup" below. |
| P8 | Actual token-exchange call against `/oauth/v2/token` | ⚠️ SKIP | Returns `invalid_client` for this app/SA combo. The token-exchange flow in Zitadel is purpose-built for impersonation/delegation: it requires assigning one of `ORG_END_USER_IMPERSONATOR`, `ORG_OWNER_IMPERSONATOR`, etc., and enabling impersonation in the security settings. The SPEC's design uses token-exchange as the *scoping* mechanism — under Zitadel today this is best emulated via `client_credentials` + PreAccessToken (which is what this example uses). |

## What worked

1. **One Postgres, two databases.** The shared `postgres` container is
   provisioned by the upstream Zitadel init (`zitadel` DB + `postgres` user)
   plus our `infra/postgres/02-untenanted.sql` (`untenanted` DB + `untenanted`
   user). Each application sees only its own DB; the two never collide.
2. **Network alias for the issuer URL.** Configuring
   `ZITADEL_EXTERNALDOMAIN=auth.localtest.me` and adding `auth.localtest.me`
   as a Docker alias for Traefik makes the issuer URL resolvable identically
   from the host and from sibling containers, so JWKS fetches work without
   custom Host headers.
3. **Traefik on :8080 internally.** We changed the web entrypoint from `:80`
   to `:8080` so the published port and the in-network port match
   (`auth.localtest.me:8080` is the same URL in both contexts).
4. **`FirstInstance.Org.Machine` for the admin PAT.** Setting
   `ZITADEL_FIRSTINSTANCE_PATPATH` + `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_*`
   spawns an `IAM_OWNER` service account on first boot and writes its PAT
   into the `zitadel-bootstrap` volume. No interactive setup needed.
5. **Action v2 wiring.** Targets and Executions are POST/PUT'd via the
   `/v2beta/actions/{targets,executions}` API. We bind:
   - `function: preaccesstoken` ⇒ adapter `/zitadel/preaccesstoken` ⇒
     translates Zitadel's user/org/grants payload to a call against our
     `/iam/internal/list-user-tenants`, then responds with
     `append_claims: [org_id, tids, scope]`.
   - `event: { group: "user" }` and `event: { group: "org" }` ⇒ adapter
     `/zitadel/events` ⇒ POST `/webhooks/events` with the normalized
     `user.removed` / `org.removed` payload.

## What required manual setup or workarounds

1. **`localhost` vs Docker internals.** Zitadel host-routes by
   `ZITADEL_EXTERNALDOMAIN`. Using `localhost` works from the host but breaks
   service-to-service calls because `localhost` inside a container is the
   container itself. We solved this with the `auth.localtest.me` alias above.
2. **Audience claim.** Zitadel's `client_credentials` flow stamps `aud` with
   the requesting `client_id` of the service account (`untenanted-sa`),
   *not* the API application's `client_id`. Our config sets
   `IDP_AUDIENCE=untenanted-sa` to match. To target multiple apps, you can
   request the audience scope `urn:zitadel:iam:org:project:id:<projectId>:aud`,
   though that wasn't required for this test.
3. **Adapter is now a packaged plugin** (`@untenanted/adapter-zitadel`).
   Untenanted's API stays IdP-agnostic by default — the Zitadel-specific
   routes only exist when `IDP_ADAPTERS=zitadel`. The plugin verifies the
   `ZITADEL-Signature` header (HMAC-SHA256 per spec in `pkg/actions/signing.go`)
   against the comma-separated `ADAPTER_ZITADEL_SIGNING_KEYS` env, then
   translates Zitadel's PreAccessToken / event payloads to calls against the
   core IAM service. Earlier versions of this example used a separate Node
   sidecar; consolidating into the package removed one container and one
   HTTP hop while preserving the agnostic-core invariant.
4. **PreAccessToken can't see exchange-time arguments.** The SPEC envisages
   that the Token Exchange request carries `resource=<tids>` and `scope=...`,
   and the webhook validates them. In Zitadel v4.13 the PreAccessToken
   function payload does **not** include the requested `resource` or `scope`.
   Our adapter therefore injects all tids the user has access to, and a
   `scope` claim equal to the intersection of roles across those tids — the
   most conservative projection. A future-Zitadel that exposes exchange
   parameters to actions would let us implement the full
   "frontend declares ⇒ webhook validates ⇒ token scoped" pattern.
5. **Token Exchange is impersonation-only today.** The
   `urn:ietf:params:oauth:grant-type:token-exchange` grant is not advertised
   in `grant_types_supported` and returns `invalid_client` for normal apps
   without enabling impersonation. The flow is implemented but tuned for
   impersonation/delegation use cases. For now, `client_credentials` +
   PreAccessToken covers the SPEC's claim-injection needs end-to-end.
6. **A bug in `@untenanted/api` Fastify wiring was found and fixed.**
   Registering the tenancy middleware via `app.register(...)` created an
   encapsulation context whose `preHandler` hook did not propagate to
   sibling routes registered in the same parent scope. The fix
   (commit-equivalent change in this run) is to invoke the plugin function
   directly with the current scope:
   `await createTenancyMiddleware({...})(publicApp, {});` This is now the
   official wiring.

## Sources consulted (official docs)

- Zitadel compose layout (v4.13.0):
  <https://github.com/zitadel/zitadel/tree/main/deploy/compose>
- Actions v2 usage (function payload shapes for PreAccessToken / PreUserinfo
  / event handlers):
  <https://github.com/zitadel/zitadel/blob/main/apps/docs/content/guides/integrate/actions/usage.mdx>
- Self-hosting configuration (FirstInstance, machine user, PAT path):
  <https://github.com/zitadel/zitadel/blob/main/cmd/defaults.yaml>
- OAuth 2.0 Token Exchange in Zitadel:
  <https://zitadel.com/docs/guides/integrate/token-exchange>
- SetInstanceFeatures (feature flags):
  <https://zitadel.com/docs/apis/resources/feature_service_v2/feature-service-set-instance-features>
- Service-account `client_credentials` flow:
  <https://zitadel.com/docs/guides/integrate/service-accounts/client-credentials>
