# Untenanted × Zitadel example

A working stack that wires the Untenanted IAM API behind Zitadel as the IdP,
all in one Docker Compose. The two services share a single Postgres instance
with two databases (`zitadel`, `untenanted`). See [TEST_REPORT.md](TEST_REPORT.md)
for the end-to-end SPEC verification results (14 passed, 0 failed,
2 skipped — those two require Zitadel impersonation policy + impersonator
roles, which is out of scope here).

## Stack

```
+------------------------------------------------------------------------+
|  Docker network: zitadel                                               |
|                                                                        |
|  proxy (Traefik :8080)  ← host port 8080                              |
|    │                                                                   |
|    ├─ Host(`auth.localtest.me`) ┐                                      |
|    │                            ├──► zitadel-api (:8080)               |
|    │                            └──► zitadel-login (:3000)             |
|    │                                                                   |
|  untenanted-api (:3000) ← host port 3000                              |
|    │     ├── /iam, /tenants, /webhooks       (IdP-agnostic core)      |
|    │     └── /adapters/zitadel/*             (bundled @untenanted/    |
|    │                                          adapter-zitadel plugin) |
|    │                                                                   |
|    └──► postgres (databases: zitadel, untenanted)                     |
+------------------------------------------------------------------------+
```

The Zitadel-specific translation lives in `@untenanted/adapter-zitadel`, loaded
as a plugin inside the main API process when `IDP_ADAPTERS=zitadel`. There's
no separate container — Zitadel Action v2 Targets point straight at
`http://untenanted-api:3000/adapters/zitadel/{preaccesstoken,events}` and the
adapter verifies the `ZITADEL-Signature` header (HMAC-SHA256 per Target key)
before forwarding to the core IAM service.

## Quick start

```bash
# 1) Bring up the stack. The api boots with empty ADAPTER_ZITADEL_SIGNING_KEYS,
#    so the adapter accepts unsigned requests at first boot — fine for setup.
docker compose --env-file .env up -d --build --wait

# 2) Read the auto-provisioned admin PAT from the bootstrap volume.
docker run --rm -v untenanted-zitadel_zitadel-bootstrap:/data alpine \
  cat /data/admin-machine.pat > /tmp/admin.pat

# 3) Provision project, application, service-account, Action v2 Targets +
#    Executions. The script captures the signing keys returned by Zitadel.
ZITADEL_BASE=http://auth.localtest.me:8080 \
ZITADEL_PAT=$(cat /tmp/admin.pat) \
UNTENANTED_BASE=http://localhost:3000 \
  bash scripts/configure-zitadel.sh

# 4) Recreate the api picking up the signing keys so signatures are verified.
cat .env > .env.runtime && grep '^ADAPTER_ZITADEL_SIGNING_KEYS=' .state/state.env >> .env.runtime
docker compose --env-file .env.runtime up -d --force-recreate untenanted-api --wait

# 5) Run the SPEC verification suite.
ZITADEL_BASE=http://auth.localtest.me:8080 \
ZITADEL_PAT=$(cat /tmp/admin.pat) \
UNTENANTED_BASE=http://localhost:3000 \
  bash scripts/run-spec-tests.sh
```

`auth.localtest.me` resolves to `127.0.0.1` over public DNS, so the same
hostname (and the same issuer URL) works from the host shell and from sibling
containers — Docker network aliases map the same name to the Traefik service
inside the compose network.

## Files

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Merged Zitadel (v4.13.0) + Untenanted API stack |
| `.env` | Default config — local-dev secrets, change for anything reachable |
| `infra/postgres/02-untenanted.sql` | Creates `untenanted` DB + role alongside Zitadel's `zitadel` DB |
| `scripts/configure-zitadel.sh` | One-shot provisioner: project, app, SA, PATs, Action v2 Targets + Executions; captures signing keys |
| `scripts/run-spec-tests.sh` | End-to-end SPEC verification (issues real tokens, calls real endpoints, fires real events) |
| `scripts/lib.sh` | Shared bash helpers for the scripts above |
| `TEST_REPORT.md` | Latest run results + notes on workarounds discovered |

## Notes

- **Adapter is a packaged plugin, opt-in via env.** The core API stays
  IdP-agnostic by default. When `IDP_ADAPTERS=zitadel`, the
  `@untenanted/adapter-zitadel` plugin registers two extra routes
  (`/adapters/zitadel/preaccesstoken`, `/adapters/zitadel/events`) which
  translate Zitadel Action v2 payloads to the core's normalized contracts
  in-process. The same shape works for other IdPs — add a sibling package
  like `@untenanted/adapter-keycloak` and append it to `IDP_ADAPTERS`.
- **The admin machine user** is created at first-instance boot via
  `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_*` env vars. Its PAT is written into the
  `zitadel-bootstrap` volume. This avoids any interactive UI step.
- **Token Exchange (RFC 8693)** is enabled at the instance level in Zitadel
  v4.13 but not advertised in `grant_types_supported` and gated by
  impersonation policy. See TEST_REPORT.md §P8 for details — the SPEC's
  claim-injection design works under `client_credentials` + PreAccessToken.
