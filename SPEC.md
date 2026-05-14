# Tenant-Based Multi-Tenant Authorization on Zitadel

> Architectural spec for implementing multi-tenant authorization on top of
> Zitadel, with the **Tenant** concept living entirely in the application
> domain (not as an IAM entity). Zitadel handles identity and authentication;
> the application handles the user/org → tenant relationship via its own
> storage. Zitadel's Token Exchange is extended via Action v2 (webhook) that
> injects tenant claims based on the domain storage.
>
> Applicable to any B2B product where multiple real organizations access a
> shared set of tenants — advertising accounts, projects, workspaces,
> contracts, any resource that is a unit of data isolation.

## Summary

1. [Context and motivation](#context-and-motivation)
2. [About Groups (#5822) — adjacent feature, not solution](#about-groups-5822--adjacent-feature-not-solution)
3. [Conceptual model](#conceptual-model)
4. [Division of responsibilities: Zitadel vs domain storage](#division-of-responsibilities-zitadel-vs-domain-storage)
5. [Mapping to Zitadel + domain storage](#mapping-to-zitadel--domain-storage)
6. [Aggregated I&AM API](#aggregated-iam-api)
7. [Authentication flow](#authentication-flow)
8. [Authorization flow — Token Exchange with custom claims](#authorization-flow--token-exchange-with-custom-claims)
9. [Token model](#token-model)
10. [Zitadel ↔ domain storage synchronization](#zitadel--domain-storage-synchronization)
11. [Access resolution](#access-resolution)
12. [Roles, scopes and delegation](#roles-scopes-and-delegation)
13. [Global vs tenanted resources](#global-vs-tenanted-resources)
14. [Unified deployment](#unified-deployment)
15. [Operational considerations](#operational-considerations)
16. [Trade-offs and rejected decisions](#trade-offs-and-rejected-decisions)
17. [Appendix — terminology and mappings](#appendix--terminology-and-mappings)

---

## Context and motivation

### The typical B2B scenario

B2B platforms frequently operate with this model:

- **Real organizations** (companies, agencies, clients) are units of
  identity. Each user works in one organization.
- **Tenants** are units of data isolation (workspaces, advertising
  accounts, projects, contracts). They can be accessed by users from
  multiple organizations.
- **Macro delegation** happens organization → tenant: an entire
  organization gets access to a tenant, and all its users inherit it.
- **Individual exceptions** happen user → tenant: occasionally, a
  specific user needs ad-hoc access that their organization does not have.

### Why this spec exists

Zitadel is excellent as a multi-tenant IDP: it offers Organizations,
Projects, native Authorizations, Token Exchange, Actions. But **its
primitives don't directly model the user/org → specific-tenant
relationship** when "tenant" is a resource shared across orgs.

Attempts to force Tenant into Zitadel's primitives (Tenant as Project,
Tenant as empty Organization) introduce real complications:

- **Tenant as Project:** Applications are per Project; having N apps per
  tenant is infeasible.
- **Tenant as empty Organization:** Zitadel Authorization validates the
  target org against Project Grant; empty orgs don't receive grants
  naturally; the model gets twisted.

This spec adopts the pragmatic solution: **Tenant lives 100% in the
domain**. Zitadel issues tokens, validates identity, operates Token
Exchange. The application carries the knowledge that tenants exist and
who can access them, and injects this into tokens via Action v2
(Zitadel's webhook).

### When this model applies

Use when:

1. You have **individual users** organized in **real organizations**
   (companies/clients/partners), and these organizations need to access
   **shared tenants**.
2. Access can be granted in two ways:
   - **Org-to-Tenant:** all users of an org access the tenant.
   - **Direct (user-to-tenant):** individual exception.
3. You need a **unified IAM API** that answers "which tenants can this
   user access?" without the consumer knowing whether access is direct
   or inherited.

Typical cases:

- **Ads/marketing platform:** Advertising accounts as tenants;
  advertisers and agencies as real organizations.
- **Multi-project SaaS:** Workspaces as tenants; client companies as
  real organizations.
- **Multi-client management system:** Contracts as tenants; consulting
  companies as real organizations.

### When it does NOT apply

- Each user belongs to only one tenant (no sharing) — use plain Zitadel
  organizations.
- All access is individual, with no inheritance by organization — use
  plain Authorizations.

---

## About Groups (#5822) — adjacent feature, not solution

Zitadel has a Groups feature in development (Issue #5822, planned for
v5). It's important to clarify what it covers, because the name "Group"
suggests a solution that it **is not**:

**Zitadel's Groups = grouping of users within an organization.**

- Classic Keycloak/AD/LDAP model.
- Use cases: departments, teams, squads — grouping employees within
  the same company to assign roles in bulk.
- Authorization assigned to the group → group's users inherit.

**What Groups does NOT do:**

- It is not a "resource delegable between organizations".
- It does not model "Org A delegates a set of tenants to Org B".
- It does not replace Project Grant.
- It does not fill the gap of this spec.

Groups and the user/org → tenant relationship of this spec are
**orthogonal axes**:

| Dimension | Granularity | Coverage |
|---|---|---|
| Groups (#5822) | Group users **within** an org | In development (v5) |
| User/Org → Tenant Auth | Access to shared resources (this spec) | Domain storage |

When Groups arrives, it may be used as a complement (e.g., grouping
employees by department). But the user/org → tenant relationship
remains the problem of this spec.

---

## Conceptual model

```mermaid
flowchart LR
  U[User]
  O[Organization]
  T[Tenant]
  R[Role]

  U -->|belongs to| O
  O -.->|org-to-tenant authorization| T
  U -.->|direct authorization| T
  T -.->|defines| R

  classDef entity fill:#eee,stroke:#333,stroke-width:1px
  class U,O,T,R entity
```

### Primitives

- **User:** individual identity in the IDP (Zitadel).
- **Organization:** unit of identity isolation (Zitadel Organization).
  Each user belongs to exactly one. Maps to a real
  company/client/partner.
- **Tenant:** unit of data isolation. Exists **only in the domain** of
  the application. Has no representation in Zitadel.
- **Role:** permission label that defines **what** can be done in the
  tenant. Defined in Zitadel's project but the usage (which role
  applies in which tenant) is resolved in the domain.
- **Authorization:** binding `(subject → tenant → roles[])` where
  subject is User (direct) or Organization (org-to-tenant). Lives in
  the domain storage.

### Two types of Authorization

| Type | Subject | Storage | When to use |
|---|---|---|---|
| **Org-to-Tenant** | Organization | Domain storage | Bulk delegation |
| **Direct (user-to-tenant)** | User | Domain storage | Individual exception |

### Resolution

For a user U asking "which tenants can I access?":

```
accessible_tenants(U) =
    { T | a direct authorization (U, T, _) exists }
  ∪ { T | an org-to-tenant authorization (O, T, _) exists AND U belongs to O }
```

Effective roles in the tenant are the merge of both paths when both
exist.

### Operational principles

1. **Zitadel handles identity; domain handles tenants.** Clean
   division, each does what it knows.
2. **Zitadel's Token Exchange injects custom claims via webhook.**
   Action v2 queries the domain at exchange time and enriches the
   token with `tids` + effective roles.
3. **Org-to-Tenant is the rule; Direct is the exception.** Configuring
   hundreds of direct authorizations following the same pattern is a
   design smell.
4. **The aggregated I&AM API is the only public authorization
   surface.** Consumers don't query Zitadel directly nor the storage
   directly.

---

## Division of responsibilities: Zitadel vs domain storage

The central piece of this spec is the **clear division** between what
Zitadel does and what the domain does. Worth being explicit:

### What Zitadel does

- **Identity:** who the user is, password, MFA, federated IDPs.
- **Organizations as a pool of users:** each user belongs to one org;
  each org has its own branding, policies, login.
- **Project + Applications + Roles:** defines the "product" being
  protected, the OIDC apps that authenticate, and the available role
  vocabulary.
- **Authorization native (user → project):** indicates "this user can
  use the platform" (general access). Has no per-tenant granularity.
- **Token issuance:** emits access tokens, ID tokens, refresh tokens.
  Signed with a key managed by it.
- **Token Exchange (RFC 8693):** standard OAuth2 mechanism to exchange
  one token for another.
- **Actions v2 (webhooks):** extends token flows (login, exchange,
  userinfo) by calling custom HTTP endpoints.

### What the domain storage does

- **Knows the tenants:** business properties, status, plan, billing,
  contract.
- **Knows the user/org → tenant relationship:** who accesses what,
  with which roles.
- **Resolves "accessible tenants":** the aggregated I&AM API queries
  the storage to answer this question.

### The bridge: Action v2

Zitadel does not know about tenants. But when it issues a token, it
can call a webhook (Action v2) that **does know** about tenants. The
webhook queries the domain storage and returns custom claims for
Zitadel to inject into the token.

Practical result: the **token signed by Zitadel** carries
`app:tids=[...]` + effective roles. Consumers of the token see a
standard Zitadel JWT, validate it with Zitadel's public key, and trust
the claims that are there.

---

## Mapping to Zitadel + domain storage

### Structure in Zitadel

```mermaid
flowchart LR
  subgraph Instance[Zitadel Instance]
    subgraph OrgPlat[Org Platform - owner]
      direction TB
      ProjMain[Project Main]
      AppWeb[Application Web]
      AppAPI[Application API]
      Roles[Roles: editor, viewer,<br/>iam_admin, billing_admin...]
      UsersPlat[Internal platform users]
    end

    subgraph IdOrgs[Identity Organizations - clients]
      direction TB
      OrgA[Org Advertiser X<br/>users + login + branding]
      OrgB[Org Agency Y<br/>users + login + branding]
      OrgC[Org ...]
    end

    ProjMain -.->|project grant| OrgA
    ProjMain -.->|project grant| OrgB
    ProjMain -.->|project grant| OrgC

    Action[Action v2<br/>pre-token-creation<br/>pre-userinfo]
    
    ProjMain -.->|emit token| Action
    Action -.->|webhook| External[Domain storage<br/>via aggregated I&AM API]
  end
```

**Key points:**

- **Project Main** is unique, lives in the Platform org (owner). Hosts
  apps, roles, and is the `aud` (audience) of tokens.
- **Project Grant** is Zitadel's native mechanism to allow users from
  other orgs (clients) to access the project. The Advertising Company
  (or analog) creates a Project Grant for each Identity Org client.
- **Authorization native** is created for each user (internal or via
  external user role assignment) — grants platform access with at
  least one project role. No per-tenant granularity — that's resolved
  in the domain.
- **Action v2** intercepts token issuance and injects custom claims.

### Structure in the domain storage

```mermaid
erDiagram
  TENANT ||--o{ ORG_TENANT_AUTHORIZATION : "receives org auth"
  TENANT ||--o{ USER_TENANT_AUTHORIZATION : "receives direct auth"
  TENANT {
    string id
    string owner_org_id "Zitadel Org ID (ownership; does NOT authorize)"
    string name
    string status
    string plan
    object properties "domain-specific"
    datetime createdAt
  }
  ORG_TENANT_AUTHORIZATION {
    string org_id "Zitadel Organization ID"
    string tenant_id "FK -> Tenant"
    string[] roles
    datetime createdAt
  }
  USER_TENANT_AUTHORIZATION {
    string user_id "Zitadel User ID"
    string tenant_id "FK -> Tenant"
    string[] roles
    datetime createdAt
  }
```

**Notes:**

- `Tenant` is a domain entity (business properties live here).
- `Tenant.owner_org_id` points to the Zitadel Organization that is
  the **owner** of the tenant (the client company that contracted).
  This field is **purely informational / ownership** — it records
  "this tenant belongs to Advertiser X" for billing, auditing, and
  queries like "which tenants belong to Advertiser X?" purposes. It
  **does not influence authorization** — authorization is resolved
  exclusively via `USER_TENANT_AUTHORIZATION` and
  `ORG_TENANT_AUTHORIZATION`.
- The owner org itself, if it wants its users to access the tenant,
  must explicitly have an `ORG_TENANT_AUTHORIZATION`. There is no
  automatic "owner ⇒ accesses" inheritance.
- `org_id` and `user_id` in authorizations are logical FKs to
  entities in Zitadel (referenced by ID, not a database constraint).
- Cleanup when a user or org is deleted in Zitadel: done via webhook
  reacting to `user.removed` or `org.removed`.

### Summary of where things live

| Operational question | Source |
|---|---|
| Who is this user? | Zitadel |
| Which organization do they belong to? | Zitadel (User → Org native) |
| Is the user active? | Zitadel |
| What tenants exist? | Domain storage |
| Tenant properties? | Domain storage |
| Who owns this tenant (ownership)? | Storage (`Tenant.owner_org_id`) — informational only |
| Can this org access this tenant? | Storage (`ORG_TENANT_AUTHORIZATION`) |
| Can this user access this tenant (exception)? | Storage (`USER_TENANT_AUTHORIZATION`) |
| Which tenants can this user access (any path)? | Aggregated I&AM API (composition) |
| Token signed by whom? | **Zitadel** (always) |
| Custom claims (`tids`) come from where? | Webhook (Action v2) querying storage |

---

## Aggregated I&AM API

Thin layer on the backend that **unifies** queries against Zitadel +
queries against the domain storage. It is the only public
authorization interface — Zitadel's webhook and the application's
endpoints consume it.

### Main operations

```
# Discovery
GET    /iam/users/:userId/tenants
       → lists accessible tenants (direct + via org-to-tenant)

GET    /iam/tenants/:tenantId/users
       → lists users with access (direct + via orgs), with effective roles

GET    /iam/tenants/:tenantId/organizations
       → lists orgs with org-to-tenant authorization

GET    /iam/organizations/:orgId/tenants
       → lists tenants accessible by the org via org-to-tenant

# Direct authorizations (domain storage)
POST   /iam/users/:userId/tenants/:tenantId
       body: { roles: [...] }
       → insert into USER_TENANT_AUTHORIZATION

DELETE /iam/users/:userId/tenants/:tenantId
       → delete from USER_TENANT_AUTHORIZATION

# Org-to-Tenant authorizations (domain storage)
POST   /iam/organizations/:orgId/tenants/:tenantId
       body: { roles: [...] }
       → insert into ORG_TENANT_AUTHORIZATION

DELETE /iam/organizations/:orgId/tenants/:tenantId
       → delete from ORG_TENANT_AUTHORIZATION

# Endpoint consumed by the webhook (internal)
POST   /iam/internal/validate-exchange
       body: { user_id, requested_tids: [...], requested_scopes: [...] }
       → returns { ok: true } if all scopes exist in all tids
       → returns { ok: false, missing: { tenant_id: [scopes] } } otherwise
       → used by Action v2 during Token Exchange
```

### Internal composition

```python
def list_user_tenants(user_id):
    """Discovery: lists accessible tenants with effective roles.
    Used by discovery endpoints (not by the exchange webhook)."""
    user = zitadel.get_user(user_id)
    org_id = user.organization_id

    # 1. Direct authorizations (storage)
    direct_rows = storage.query(
        "SELECT tenant_id, roles FROM user_tenant_authorization "
        "WHERE user_id = ?", user_id
    )
    direct = {(r.tenant_id, set(r.roles)) for r in direct_rows}

    # 2. Org-to-Tenant authorizations (storage)
    via_org_rows = storage.query(
        "SELECT tenant_id, roles FROM org_tenant_authorization "
        "WHERE org_id = ?", org_id
    )
    via_org = {(r.tenant_id, set(r.roles)) for r in via_org_rows}

    # 3. Merge: a tenant may appear in both; roles are union'd
    merged = {}
    for tenant_id, roles in direct | via_org:
        merged.setdefault(tenant_id, set()).update(roles)
    return merged


def validate_exchange(user_id, requested_tids, requested_scopes):
    """Exchange webhook: validates that the user has all requested
    scopes in all requested tids."""
    accessible = list_user_tenants(user_id)
    missing = {}

    for tid in requested_tids:
        effective = accessible.get(tid, set())
        lacking = set(requested_scopes) - effective
        if lacking:
            missing[tid] = list(lacking)

    if missing:
        return { "ok": False, "missing": missing }
    return { "ok": True }
```

### Why this layer exists

- **Composes Zitadel + storage** into a single interface.
- **Consumed by the webhook** during Token Exchange.
- **Consumed by the application's endpoints** for discovery and mutation.
- **Encapsulates the complexity** of "where each thing lives".

### Authorization to call the API

- Discovery operations (`GET`) → self-service or administrative role.
- Mutating operations → require an administrative role on the
  Zitadel project.
- Internal endpoint (`/iam/internal/validate-exchange`) → authenticated
  via service account credentials, accessible only over the internal
  network (not publicly exposed).

---

## Authentication flow

```mermaid
sequenceDiagram
  participant U as User
  participant FE as Frontend
  participant Z as Zitadel
  participant BE as Backend

  U->>FE: accesses app
  FE->>Z: redirect /authorize (PKCE)
  Z->>U: login screen (branded by user's org)
  U->>Z: credentials
  Z->>Z: identifies org by loginname
  Z->>Z: applies org policies (MFA, etc)
  Z->>Z: validates native authorization on project
  Z->>FE: redirect with code
  FE->>Z: exchange code → tokens
  Z-->>FE: access_token (platform) + refresh + id_token
  FE->>FE: stores
  FE->>BE: requests with Bearer
```

**Characteristics:**

- Single login, automatically branded by the user's Identity Org.
- Native Authorization (of the user on the project) is what permits
  login. Without it, "Check Authorization on Authentication" fails.
- Login token (platform) has no `tids` — the user hasn't yet chosen a
  tenant context.

---

## Authorization flow — Token Exchange with custom claims

### Entering a tenant in the UI

```mermaid
sequenceDiagram
  participant U as User
  participant FE as Frontend
  participant Z as Zitadel
  participant W as Action v2<br/>(webhook)
  participant API as Aggregated I&AM API
  participant S as Domain storage

  U->>FE: selects "Tenant A"
  FE->>FE: does at_tenant-a with adequate scopes exist in sessionStorage?
  alt Valid scoped token
    FE->>FE: uses existing token
  else Missing/expired/insufficient
    FE->>Z: Token Exchange<br/>subject_token=platform<br/>resource=tenant-a<br/>scope=campaign:read campaign:write
    Z->>Z: validates subject_token
    Z->>W: pre-token-creation event
    W->>API: validate(user, tids=[tenant-a],<br/>requested_scopes=[campaign:read, campaign:write])
    API->>S: queries direct + org-to-tenant
    S-->>API: effective_roles per tid
    API->>API: requested_scopes ⊆ effective_roles in all tids?
    alt Yes
      API-->>W: ok
      W-->>Z: append scope + app:tids
      Z->>Z: signs token
      Z-->>FE: new access_token<br/>scope=campaign:read campaign:write<br/>tids=[tenant-a]
      FE->>FE: stores at_tenant-a
    else Some scope missing in some tid
      API-->>W: missing: {tenant-a: [campaign:write]}
      W-->>Z: deny insufficient_scope
      Z-->>FE: 403 + details of what was missing
      FE->>FE: handles (retries with subset or shows error)
    end
  end
```

**The crucial point:**

- **Zitadel is still the issuer and signer.** The token remains a JWT
  issued by Zitadel, signed with its key, validatable via its JWKS.
  There is no second auth server.
- **Action v2 only enriches.** The webhook does not issue a token or
  sign — it only returns "which additional claims to insert" and
  Zitadel does the rest.
- **Scope is validated once (at exchange) and guaranteed for the
  entire life of the token.** Downstream endpoints only check scope
  presence, they do not cross role-with-tenant.

### Multiple tenants in the same token

For aggregated views (multi-tenant dashboards), the exchange accepts
an array of tids alongside scopes:

```http
POST /oauth/v2/token
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token={platform_token}
resource=tenant-a,tenant-b,tenant-c
scope=campaign:read
```

The webhook validates that `campaign:read` ∈ effective_roles for
**each** of the tids. If any doesn't have it, the exchange fails
(full-fail) with a useful response:

```json
{
  "error": "insufficient_scope",
  "missing": {
    "tenant-c": ["campaign:read"]
  }
}
```

The frontend chooses how to handle it — retry the exchange with a
smaller subset of tids, retry with a smaller subset of scopes, or
propagate the error to the user.

### Tenant token renewal

An important detail unlocks in-line re-exchange on the backend: **a
tenant token expired by TTL is still authentic**. The signature
remains valid (Zitadel's key doesn't change); only the `exp` claim
indicates that its usage time has passed. The claims can be read with
confidence — the backend can extract `app:tids` from the expired
token and use it as input for the exchange.

This enables transparent renewal without an endpoint hierarchy and
without a dedicated tenant header — the expired token itself carries
the necessary context.

```mermaid
sequenceDiagram
  participant FE as Frontend
  participant BE as Backend
  participant Z as Zitadel

  FE->>BE: GET /campaigns/123<br/>Authorization: Bearer {platform}<br/>Tenant-Token: {expired but authentic}
  BE->>BE: validates platform (ok)
  BE->>BE: validates tenant token signature (ok)
  BE->>BE: tenant token expired → extracts tids from claims
  BE->>Z: Token Exchange<br/>subject_token=platform<br/>resource=[extracted tids]
  Z->>Z: webhook re-validates access
  alt Access still valid
    Z-->>BE: new tenant_token
    BE->>BE: processes request with new token
    BE-->>FE: 200 + data<br/>X-New-Tenant-Token: {new}
    FE->>FE: updates sessionStorage
  else Access revoked
    Z-->>BE: deny
    BE-->>FE: 403 (frontend clears cache, updates UI)
  end
```

### Behavior by token presence

The authentication middleware on the backend is simple and doesn't
require a tenant token. It accepts whatever comes:

| Scenario | Treatment |
|---|---|
| Only platform token (no tenant token) | Accepts; `tids = []` in context; request accesses only global resources |
| Platform + valid tenant token | Accepts; uses `tids` from the token |
| Platform + expired but signature-valid tenant token | In-line re-exchange reading tids from the token; new token in `X-New-Tenant-Token` |
| Tenant token with invalid signature | 401 (forged or corrupted) |
| Attempt to operate on a tenanted resource without coverage | Repository returns 404 (filter `tenant_id IN (tids)` is empty); not the middleware's responsibility |
| Re-exchange fails (access revoked between TTLs) | 403; frontend clears tenant token cache and redoes the selection |

Key points:

- **Amplified endpoints work with only the platform token.** `/me`,
  `/iam/users/me/tenants`, listings of global resources — all
  accessible without a tenant token. There is no forced 401 due to
  absence of a tenant token; the tenancy filter resolves it naturally.
- **Tenanted-resource endpoints "self-validate".** If the user has no
  coverage for the requested tenant, the filter returns empty, the
  response is 404. There is no special logic in the middleware.
- **First entry into a tenant requires an explicit exchange from the
  frontend.** When the user clicks "select Account B" in the UI, the
  frontend calls Zitadel to obtain the first tenant token for that
  context. From there, renewals are automatic via in-line.
- **Re-exchange uses the expired tenant token as "context memory".**
  Without it, the backend would not know which `tids` to request.

### Middleware validation (sketch)

```python
async def authn_middleware(req, res, next):
    platform_token = validate_platform_token(req.headers.authorization)
    if not platform_token:
        return res.status(401).send('not authenticated')

    tenant_token_raw = req.headers.get('tenant-token')

    if not tenant_token_raw:
        # No tenant token — operate with globals only
        req.token = platform_token
        req.tids = []
        req.scopes = set()
        return next()

    try:
        claims = validate_signature(tenant_token_raw)
    except InvalidSignature:
        return res.status(401).send('invalid tenant token')

    if is_expired(claims):
        # Authentic but expired token — renew preserving the tids AND scopes
        # from the expired token (the user asked for that combination before;
        # we renew the same one).
        expired_tids = claims.get('app:tids', [])
        expired_scope = claims.get('scope', '')
        try:
            new_raw = await zitadel.token_exchange(
                subject_token=platform_token.raw,
                resource=expired_tids,
                scope=expired_scope
            )
            claims = parse(new_raw)
            res.set_header('X-New-Tenant-Token', new_raw)
        except ExchangeDenied:
            # Access revoked between TTLs (lost some role)
            return res.status(403).send('access revoked')

    req.token = claims
    req.tids = claims.get('app:tids', [])
    req.scopes = set(claims.get('scope', '').split())
    next()
```

After the middleware, handlers consult `req.scopes` (for validation
via `@requires_scope`) and `req.tids` (for repository filtering).

---

## Token model

A single token schema, with optional `tids` defining scope. All tokens
are issued and signed by Zitadel.

### Platform token (no tids)

Issued at login. Covers aggregated, self-service, and discovery
endpoints.

```json
{
  "sub": "user-123",
  "iss": "https://auth.platform.example",
  "aud": ["platform-api"],
  "azp": "platform-web",
  "org_id": "org-a",
  "urn:zitadel:iam:org:project:roles": {
    "user": { "platform-org": "Platform" }
  },
  "exp": 1735000000,
  "iat": 1734996400
}
```

`roles` here is the user's native role on the Zitadel project
(authorizes platform login). No `tids` and no tenant `scope`.

### Tenant token (with tids and scope)

Issued via Token Exchange when entering tenant(s). The frontend
declares at exchange time which scopes it needs; the webhook validates
that the user has those roles in **all** the requested tids, and
injects the claims if ok.

```json
{
  "sub": "user-123",
  "iss": "https://auth.platform.example",
  "aud": ["platform-api"],
  "org_id": "org-a",
  "urn:zitadel:iam:org:project:roles": {
    "user": { "platform-org": "Platform" }
  },
  "scope": "campaign:read campaign:write",
  "app:tids": ["tenant-a", "tenant-b"],
  "exp": 1734998200,
  "iat": 1734996400
}
```

**Invariant:** if the token has `scope: "campaign:write"` with
`tids: [A, B]`, then the user **has** the `campaign:write` role in
both A **and** B. The backend only validates `scope ∈ token.scope`
(simple boolean) + filters data by `tenant_id IN (token.tids)`. No
need to cross role-with-tenant per row.

Token size: linear in tids + small fixed component in scopes,
independent of the total number of roles defined in the system.

> The `app:` namespace in `tids` is a convention. `scope` is a
> standard OAuth2 claim and uses the standard format (space-separated
> string).

### When to use each

| Endpoint | Accepts platform | Accepts tenant | Behavior |
|---|---|---|---|
| Aggregated/self | ✅ | ✅ | Uses platform; tenant ignored |
| Resources (mixed global + tenanted) | ✅ | ✅ | With platform: sees only globals. With tenant: sees globals + tenanted from `tids` |
| Context switch | ✅ | ❌ | Exchange requires platform as subject |

Resource endpoints automatically filter by the combination
`tenant_id IS NULL OR tenant_id IN (token.app:tids)`. When the token
has no `tids` (pure platform), the second term is `IN ([])` which
naturally becomes false, so only global resources appear. If the
query returns empty for a GET-by-id, the response is **404** —
intentionally indistinguishable to avoid info leak.

### Storage on the frontend

Differentiated persistence reflects distinct roles:

```
Persistent (localStorage or httpOnly cookie):
  at_platform           → platform token
  rt_platform           → refresh token

Session (sessionStorage):
  at_tenant-a           → tenant token
  at_tenant-b           → tenant token
  at_tenants-a-b        → multi-tids tenant token
```

**Why platform is persistent:**

- Amplified endpoints (`/me`, `/iam/users/me/tenants`) must work
  before the user selects context.
- Global-resource endpoints work with only the platform token.
- Backend uses the platform token as `subject_token` for the in-line
  re-exchange when the tenant token expires — it must be available in
  every request.
- UX of reopening the browser without re-login is expected.

**Why tenant in session:**

- Disposable tokens (re-exchange is cheap).
- Not persisting between sessions limits blast radius in XSS.
- Multiple tabs on different tenants work.

---

## Zitadel ↔ domain storage synchronization

### Reactive cleanup via webhook

The domain storage carries logical FKs to Zitadel entities (`user_id`,
`org_id`). When these entities are deleted in Zitadel, the storage
needs to react.

```mermaid
sequenceDiagram
  participant Admin as Admin / API
  participant Z as Zitadel
  participant W as Webhook (Actions v2)
  participant S as Domain storage

  Admin->>Z: deletes user X
  Z->>W: dispatch user.removed
  W->>S: DELETE FROM user_tenant_authorization WHERE user_id = X
  W-->>Z: 200

  Admin->>Z: deletes org Y
  Z->>W: dispatch org.removed
  W->>S: DELETE FROM org_tenant_authorization WHERE org_id = Y
  W-->>Z: 200
```

**Relevant events:**

- `user.removed` → cleans up `USER_TENANT_AUTHORIZATION` for that user.
- `org.removed` → cleans up `ORG_TENANT_AUTHORIZATION` for that org.
- `user.deactivated` / `user.locked` → no cleanup needed (Zitadel
  already blocks login; authorizations remain temporarily orphaned,
  with no effect).

### The reverse direction does not exist

There is no automatic storage → Zitadel sync. All user/org creation
and editing happens via the Zitadel API (IAM operations are Zitadel's
prerogative). The storage only **reacts** to those events.

Tenants, on the other hand, are **purely domain** entities. Tenant
CRUD does not involve Zitadel.

---

## Access resolution

The full logic is in the aggregated I&AM API. Here we formalize it.

### Rule

A user has access to a tenant if **any** condition is true:

1. A Direct Authorization `(user_id, tenant_id, _)` exists in the
   storage.
2. The user's Identity Organization has an Org-to-Tenant Authorization
   `(org_id, tenant_id, _)` in the storage.

### Effective roles

When there is access via both paths, the roles are **merged**:

```
effective_roles(user, tenant) =
    roles_from_direct_authorization
  ∪ roles_from_org_to_tenant_authorization
```

### Illustrative scenarios

**Scenario 1 — Access via org-to-tenant.**

Org A has `org_tenant_authorization` for Tenant-A. User Alice belongs
to Org A.

```
list_user_tenants(Alice) includes Tenant-A
```

Adding user Bob to Org A in Zitadel:

```
list_user_tenants(Bob) includes Tenant-A (automatically)
```

**Scenario 2 — Direct + via-org access.**

User Maria in Org B. Org B has authorization on Tenant-B with role
`viewer`. Maria has a direct authorization on Tenant-B with role
`editor`.

```
list_user_tenants(Maria) includes { Tenant-B: roles={viewer, editor} }
```

**Scenario 3 — Direct outside the org.**

User John in Org C. Org C has no authorization on Tenant-D. John has
a direct authorization on Tenant-D with role `viewer`.

```
list_user_tenants(John) includes { Tenant-D: roles={viewer} }
```

**Scenario 4 — Bulk revocation.**

Org A loses authorization on Tenant-A:

```sql
DELETE FROM org_tenant_authorization
 WHERE org_id = 'org-a' AND tenant_id = 'tenant-a';
```

All users of Org A lose access to Tenant-A simultaneously. Tokens
issued before remain valid until they expire.

**Scenario 5 — User moved between orgs.**

Zitadel does not support moving users between orgs natively. If
this is necessary:
- Recreate the user in the new org.
- The old user's direct authorizations are lost (the logical FK is
  broken — the `user.removed` webhook cleans up).
- Access via org-to-tenant adjusts automatically based on the user's
  new org.

---

## Roles, scopes and delegation

This section defines how authorization works in two layers: **roles**
in the storage (what the user has) and **scopes** in the token (what
the session has declared and been authorized for).

### Roles vs scopes — the distinction

| Concept | What it is | Where it lives |
|---|---|---|
| **Role** | Capability the user **has** in a tenant | Domain storage (`USER/ORG_TENANT_AUTHORIZATION.roles`) |
| **Scope** | Capability the token **carries** (projection of roles authorized in the session) | JWT `scope` claim |

Roles are the durable source of truth — "Maria is `campaign:write` in
tenant-a". Scopes are the temporary projection in the token — "this
session can write campaigns". The scope is in the token only if the
user has the corresponding role in **all** the token's tids.

The role vocabulary and the scope vocabulary coincide by convention.
There is no translation — `campaign:write` in the storage is
`campaign:write` in scope.

### Roles are flat labels (no hierarchy)

Roles do not form a hierarchy. There is no implicit
`admin > editor > viewer`. Each role is an independent label,
semantically equivalent to an OAuth2 scope:

```
roles = ["campaign:read", "campaign:write", "billing:manage", "iam:delegate"]
```

or, in a more concise model:

```
roles = ["editor", "billing_admin", "iam_admin"]
```

The choice of vocabulary is the product's. The important thing:
**each role is atomic**, with no implicit relations. A user with
`iam_admin` does not automatically have `editor` — if both are needed,
both are assigned explicitly.

### Where roles live

Roles live in the `roles[]` column of authorizations:

```
ORG_TENANT_AUTHORIZATION:
  { org_id: agency-1, tenant_id: advertiser-a, 
    roles: ["campaign:read", "campaign:write", "iam:delegate"] }

USER_TENANT_AUTHORIZATION:
  { user_id: maria, tenant_id: advertiser-a, 
    roles: ["campaign:read"] }
```

### Resolution: union across all paths

Effective roles in the tenant for a user = union of roles obtained by
any path:

```
effective_roles(user, tenant) =
    roles_from_direct_authorization
  ∪ roles_from_org_to_tenant_authorization
```

When both paths exist, the roles add up. There is no "override" —
only accumulation.

### Scopes in the token: projection, not enumeration

The first temptation would be to carry `{ tenant_id: [roles] }` per
tenant in the token. This explodes in size with many tenants. The
correct model is different:

**The frontend declares, at exchange time, which capabilities it
needs.** The webhook validates that the user has those capabilities
in **all** the requested tids. If yes, the token is issued with the
scopes as a **uniform guarantee**.

Resulting token:

```json
{
  "scope": "campaign:read campaign:write",
  "app:tids": ["tenant-a", "tenant-b", "tenant-c"]
}
```

Invariant: **if the token has scope X with tids [A, B, C], then the
user has role X in A, B, and C — guaranteed**. The backend does not
need to verify tenant by tenant; it just validates
`scope ∈ token.scope` and filters data by `tenant_id ∈ token.tids`.

Token size: linear in tids + small constant in scopes, independent of
the total number of roles in the system.

### Exchange flow with scopes

```mermaid
sequenceDiagram
  participant FE as Frontend
  participant Z as Zitadel
  participant W as Webhook
  participant API as I&AM API

  FE->>Z: Token Exchange<br/>resource=tenant-a,tenant-b<br/>scope=campaign:read campaign:write
  Z->>W: pre-token-creation
  W->>API: validate(user, [tenant-a, tenant-b],<br/>requested=[campaign:read, campaign:write])
  loop for each tid
    API->>API: effective_roles(user, tid)
    API->>API: requested ⊆ effective_roles?
  end
  alt all tids cover the requested scopes
    API-->>W: ok
    W-->>Z: append scope + tids
    Z-->>FE: token with scope + tids
  else some tid doesn't cover
    API-->>W: missing: {tenant-b: [campaign:write]}
    W-->>Z: deny insufficient_scope
    Z-->>FE: 403 insufficient_scope<br/>+ details of what was missing
  end
```

### Failure policy: full-fail with useful info

If any requested scope is not present in some tid, the exchange
**fails entirely** (there is no automatic adjustment to the subset).
The error response carries enough information for the frontend to
handle it:

```json
{
  "error": "insufficient_scope",
  "missing": {
    "tenant-b": ["campaign:write"]
  }
}
```

The frontend handles:
- Retry exchange with a smaller scope subset (only `campaign:read`)
- Retry exchange with a smaller tids subset (only `tenant-a`)
- Show error to the user explaining which permission is missing where

Why full-fail and not automatic adjustment: automatic adjustment masks
bugs in the frontend (the client thinks it asked for X and got less
without knowing). Explicit failure forces the client to deal with
reality.

### Backend validation

Endpoints declare which scope they require. Validation is boolean:

```python
@requires_scope("campaign:write")
def update_campaign(req, campaign_id, payload):
    # @requires_scope already validated that "campaign:write" is in token.scope
    # repository already filters by tenant_id ∈ token.tids
    return repo.update(campaign_id, payload)
```

Decorator:

```python
def requires_scope(scope):
    def decorator(handler):
        def wrapper(req, *args, **kwargs):
            token_scopes = req.token.get("scope", "").split()
            if scope not in token_scopes:
                return res.status(403).send({
                    "error": "insufficient_scope",
                    "required_scope": scope
                })
            return handler(req, *args, **kwargs)
        return wrapper
    return decorator
```

Repository filters by tenancy normally:
`WHERE tenant_id IS NULL OR tenant_id IN (token.tids)`.

The combination:
- **scope authorizes what to do** (operation)
- **tids restrict where to do** (tenants)

### Delegation: who can create/revoke authorizations

A specific role carries the capability to delegate access to the
tenant. Suggested convention: `iam:delegate` (or `iam_admin`, named at
the product's discretion).

Delegation operations (create/revoke authorizations) require the
token to have that scope, and the user to **possess** the roles they
are delegating.

```python
@requires_scope("iam:delegate")
def grant_user_tenant_access(req, target_user, tenant_id, requested_roles):
    # Caller must hold the roles being granted
    caller_effective_roles = api_iam.effective_roles(
        req.token.sub, tenant_id
    )
    if not set(requested_roles).issubset(caller_effective_roles):
        return res.status(403).send({
            "error": "cannot_delegate",
            "reason": "caller does not possess all requested roles"
        })

    storage.insert(USER_TENANT_AUTHORIZATION, ...)
```

Two combined checks:
1. **Scope-level (token):** `iam:delegate` ∈ `token.scope` —
   authorizes the "delegate" action as a general capability.
2. **Role-level (storage query):** `requested_roles ⊆ effective_roles(caller, tenant)` — authorizes delegating **these specific roles**, validating against what the caller actually possesses.

The "you only delegate what you have" rule is the classical
delegation principle — it avoids privilege escalation. The same rule
holds for revocation: requires `iam:delegate` in scope + authority
over the tenant in question.

A user can always revoke their own direct authorizations
(self-revoke is trivial and does not require `iam:delegate`).

### Separation between operational and administrative roles

Since roles are flat, **separating capabilities is the vocabulary's
responsibility**. Instead of a single `admin` role that gives
everything, prefer:

| Role / Scope | Meaning |
|---|---|
| `campaign:read` or `viewer` | Reads tenant data |
| `campaign:write` or `editor` | Creates/edits operational resources |
| `iam:delegate` or `iam_admin` | Creates/revokes authorizations on the tenant |
| `billing:manage` or `billing_admin` | Operates billing/plan of the tenant |

A user can have `[campaign:write]` (operates, but doesn't delegate),
`[iam:delegate]` (delegates, but doesn't operate), or both. Each
combination makes sense in different contexts.

### Illustrative scenario

Maria is from Agency Y. She has:
- `USER_TENANT_AUTHORIZATION: (maria, tenant-a, [campaign:read, campaign:write])`
- `ORG_TENANT_AUTHORIZATION: (agency-y, tenant-b, [campaign:read])` — Maria inherits

**Scenario 1: Maria wants to view the A + B dashboard (read-only).**

```http
POST /oauth/v2/token
resource=tenant-a,tenant-b
scope=campaign:read
```

Webhook validates: `campaign:read` ∈ effective_roles in A ✓ and in B ✓.

Token issued:
```json
{ "scope": "campaign:read", "app:tids": ["tenant-a", "tenant-b"] }
```

Maria operates the dashboard smoothly.

**Scenario 2: Maria wants to edit a campaign in B.**

```http
POST /oauth/v2/token
resource=tenant-b
scope=campaign:write
```

Webhook validates: `campaign:write` ∈ effective_roles in B? ✗ (Maria
only has read in B, inherited from Agency Y).

Exchange fails:
```json
{ "error": "insufficient_scope", 
  "missing": { "tenant-b": ["campaign:write"] } }
```

Frontend shows: "you cannot edit in this account".

**Scenario 3: Maria wants to edit a campaign in A.**

```http
POST /oauth/v2/token
resource=tenant-a
scope=campaign:write
```

Webhook validates: `campaign:write` in A ✓ (direct).

Token is issued and Maria edits.

**Scenario 4: Bulk action in both.**

```http
POST /oauth/v2/token
resource=tenant-a,tenant-b
scope=campaign:write
```

Webhook: in A ✓, in B ✗.

Exchange fails. Frontend chooses: (a) retry with only A (write
scope), or (b) retry with both at read-only (degrade to read-only).

---

## Global vs tenanted resources

Real applications mix resources:

- **Globals:** templates, categories, predefined types, platform
  configuration.
- **Tenanted:** data from a specific tenant.

### Modeling: tenancy is row-level

**There is no per-entity-type declaration of tenancy.** Tenancy is a
property of the **row**, not the schema: each record has (or does not
have) a `tenant_id`. Records with `tenant_id = null` are global;
records with `tenant_id` filled belong to that tenant.

This allows the same collection/table to freely mix:

```
templates:
  { _id: "tmpl-1", tenant_id: null,         name: "Default Template" }     # global
  { _id: "tmpl-2", tenant_id: "tenant-a",   name: "Tenant A Template" }    # tenanted
  { _id: "tmpl-3", tenant_id: "tenant-b",   name: "Tenant B Template" }    # tenanted
```

No schema metadata declares "templates is global or tenanted" — the
answer varies row by row.

### Endpoints are not grouped by tenant

**There is no per-tenant endpoint hierarchy.** URLs operate over
resources directly, without a tenant prefix or dedicated header:

```
GET /campaigns/123
GET /templates
POST /reports
```

**Not:**

```
GET /tenants/:id/campaigns/123      ← we do not use this pattern
GET /campaigns/123  + X-Tenant-Id   ← also not
```

Tenancy is **inferred exclusively from the token**. The backend reads
`app:tids` from the token and filters automatically — the client does
not need to say "I am operating in tenant X".

This simplifies:
- Frontend does not build different URLs per tenant.
- Backend does not validate coherence between path/header and token.
- Switching the active tenant in the UI = switching the token sent in
  requests.

### Filtering on reads

The single rule (with no schema distinction): brings global records
**union** with records from the tenants authorized by the token.

```python
def apply_filter(query, token):
    tids = token.get("app:tids") or []
    return query.filter({
        "$or": [
            { "tenant_id": None },              # globals (always visible)
            { "tenant_id": { "$in": tids } }     # accessible tenanted
        ]
    })
```

**Behavior per operation:**

- **LIST:** applies the filter. The result naturally mixes globals +
  accessible tenanted.
- **GET by id:** also applies the filter. If the query returns empty,
  the response is **404** — intentionally indistinguishable to avoid
  info leak (does not distinguish "does not exist" from "no access"
  from "global").

### Filtering on writes

CREATE/UPDATE/DELETE need to decide case by case, **based on whether
the resource is global or tenanted** (and that is a property of the
row, not the type).

**CREATE:**

```python
def can_create(payload, user):
    # payload.tenant_id may be present or null
    if payload.tenant_id is None:
        # creating a global resource → requires platform administrative role
        return user.has_project_role("platform_admin")
    # creating a tenanted resource → tenant_id must be in the token
    return payload.tenant_id in user.token["app:tids"]
```

**UPDATE/DELETE:**

Atomic operation with implicit filter:

```sql
UPDATE table SET ... 
 WHERE id = :id 
   AND (tenant_id IS NULL OR tenant_id IN (:tids))
```

But who can modify what depends on the row's `tenant_id`:
- Global row (`tenant_id IS NULL`): requires administrative role.
- Tenanted row: the `IN (:tids)` in the WHERE already ensures the
  user only modifies rows of tenants they have in the token.

If `affected_rows == 0`, return 404.

### Behavior table

| Operation | Behavior |
|---|---|
| LIST | `WHERE tenant_id IS NULL OR tenant_id IN (tids)` |
| GET | Same; empty → 404 |
| CREATE with `tenant_id IS NULL` | Requires `platform_admin` role |
| CREATE with `tenant_id` filled | Requires `tenant_id ∈ tids` |
| UPDATE/DELETE | `WHERE id = X AND (tenant_id IS NULL OR tenant_id IN (tids))` + role check for global rows |

### Centralized implementation

The filtering **does not live in the handlers**. It lives in the
central repository, which:

1. Applies `tenant_id IS NULL OR tenant_id IN (tids)` automatically on
   every read.
2. Applies the role/tids rule automatically on every write,
   inspecting `payload.tenant_id` or `existing.tenant_id`.
3. Blocks operations that violate the rules before touching the DB.

Endpoints become thin handlers. **They do not write authorization
logic.**

> Discipline: no application layer accesses the DB outside the
> central repository. Lint/test enforces it. Code review checks it.

---

## Unified deployment

Since Zitadel and the aggregated I&AM API need to talk via webhook
(Action v2), it makes sense to deploy them together. Topology
suggestion for development and self-hosted production.

### Components

```mermaid
flowchart TB
  subgraph stack[Docker Compose stack]
    Z[Zitadel]
    PG[(Postgres<br/>databases: zitadel + domain)]
    R[(Redis - Zitadel cache)]
    API[Aggregated I&AM API + Platform Backend]
  end
  
  Z -.->|stores events| PG
  Z -.->|cache org/instance| R
  Z -.->|Action v2 webhook| API
  API -.->|domain data| PG
  API -.->|user/org info| Z
  
  Client[External client] --> Z
  Client --> API
```

A single Postgres instance serves both applications in **separate
databases** (`zitadel` and `domain`), with distinct users and
permissions. It saves physical resources (one installation, one
volume, one process) without logical coupling — each database is
independent; backup, migrations and ownership are separate.

### `compose.dev.yml` sketch

Illustrative example (adjust images, versions and secrets as needed):

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      # initial superuser
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - postgres-data:/var/lib/postgresql/data
      # init script creates both databases + dedicated users
      - ./infra/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 5s

  zitadel-cache:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s

  zitadel:
    image: ghcr.io/zitadel/zitadel:latest
    command: 'start-from-init --masterkey "${ZITADEL_MASTERKEY}" --tlsMode disabled'
    environment:
      ZITADEL_DATABASE_POSTGRES_HOST: postgres
      ZITADEL_DATABASE_POSTGRES_DATABASE: zitadel
      ZITADEL_DATABASE_POSTGRES_USER_USERNAME: zitadel
      ZITADEL_DATABASE_POSTGRES_USER_PASSWORD: ${ZITADEL_DB_PASSWORD}
      ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME: zitadel
      ZITADEL_DATABASE_POSTGRES_ADMIN_PASSWORD: ${ZITADEL_DB_PASSWORD}
      ZITADEL_CACHES_CONNECTORS_REDIS_ENABLED: 'true'
      ZITADEL_CACHES_CONNECTORS_REDIS_ADDR: 'zitadel-cache:6379'
      ZITADEL_CACHES_INSTANCE_CONNECTOR: 'redis'
      ZITADEL_CACHES_ORGANIZATION_CONNECTOR: 'redis'
      ZITADEL_EXTERNALSECURE: 'false'
      ZITADEL_EXTERNALDOMAIN: 'zitadel.localhost'
      ZITADEL_EXTERNALPORT: '8080'
    depends_on:
      postgres:
        condition: service_healthy
      zitadel-cache:
        condition: service_healthy
    ports:
      - "8080:8080"

  backend:
    build: ./backend  # or published image
    environment:
      ZITADEL_DOMAIN: http://zitadel:8080
      ZITADEL_INTROSPECTION_KEY: ${ZITADEL_INTROSPECTION_KEY}
      DOMAIN_DB_URL: postgresql://domain_app:${DOMAIN_DB_PASSWORD}@postgres:5432/domain
      ACTION_WEBHOOK_SECRET: ${ACTION_WEBHOOK_SECRET}
    depends_on:
      zitadel:
        condition: service_started
      postgres:
        condition: service_healthy
    ports:
      - "3000:3000"

volumes:
  postgres-data:
```

`init.sql` creates both databases with dedicated users:

```sql
-- Zitadel
CREATE USER zitadel WITH PASSWORD '...';
CREATE DATABASE zitadel OWNER zitadel;

-- Domain
CREATE USER domain_app WITH PASSWORD '...';
CREATE DATABASE domain OWNER domain_app;
```

Each user only accesses its own database. Separate backups per
database. Independent migrations.

### Composition root pattern

If each service (Zitadel, backend) has its own `compose.yml`
optimized for independent deploy (e.g., Cloud Run, k8s), the
`compose.dev.yml` at the root uses `include` to bring both in and
wire up local networking + volumes. This preserves the
production/dev separation:

```yaml
# compose.dev.yml (root)
include:
  - ./infra/zitadel/compose.yml
  - ./services/backend/compose.yml

# compose.override.yml (root, automatically applied in dev)
# adds exposed ports, hot-reload, code volumes, etc.
```

### Internal communication

- Backend calls Zitadel via service account (machine user) for
  management operations (list users, create authorization, etc.).
- Zitadel calls the Backend via webhook configured in Actions
  (`http://backend:3000/iam/internal/webhook`).
- Webhook authenticated via shared secret (header `X-Webhook-Secret`)
  or JWT signed by Zitadel.
- Everything on the same Docker network — internal calls do not
  leave the host.

### In production

Same topology, different orchestrators:

- **k8s:** each component becomes Deployment + Service. Networking
  via ClusterIP. Database as StatefulSet or managed (RDS, Cloud SQL).
- **Cloud Run + managed DBs:** backend and zitadel as Cloud Run
  services; Postgres on Cloud SQL (one instance with two databases,
  or two instances if physical isolation is necessary); cache on
  Memorystore.
- **Single VM:** same `compose.yml` from dev with production
  configuration; OK for low/medium loads.

---

## Operational considerations

### Performance and scale

**Volume of Organizations in Zitadel:**

- 1 Platform org (project owner)
- N Identity Organizations (one per real company/client)
- Total: tens of thousands is within the envelope Zitadel supports.
  They position themselves as a platform for "millions of tenants"
  and maintainers have validated architectures with 100k+ orgs
  publicly.

**Caching of Organizations (Zitadel native):**

Zitadel supports caching of Organizations and Instances via Redis,
Valkey or Postgres — opt-in native feature, enabled via Zitadel
configuration (it is not a custom cache on the backend).

In B2B environments with many orgs, this is **necessary** to avoid a
context-resolution bottleneck per request ("N-over-N scaling
bottleneck").

Typical configuration:
- **Redis** or Valkey as connector.
- Cache enabled for `Instances` and `Organizations`.
- Conservative TTL (minutes).

Details: https://zitadel.com/docs/self-hosting/manage/cache

**Expected latencies:**

- Token Exchange (with cache + local webhook): 30-80ms (webhook adds
  ~30ms; acceptable given that it happens only on context switch).
- Tenant token validation on endpoints: zero additional queries.
- `/iam/users/me/tenants`: 20-50ms.

### Recommended TTL

| Token | Suggested TTL | Rationale |
|---|---|---|
| Platform access | 15 min | Short staleness window |
| Refresh token | 8h | Typical work session |
| Tenant access | 30 min | Re-exchange is cheap |

### Access revocation

**Org-to-Tenant authorization revoked:**

1. `DELETE` from `ORG_TENANT_AUTHORIZATION`.
2. Tokens issued before remain valid until they expire.
3. The next re-exchange fails.

**Direct authorization revoked:**

1. `DELETE` from `USER_TENANT_AUTHORIZATION`.
2. Same TTL window.

**User removed from Zitadel:**

1. Zitadel dispatches `user.removed`.
2. Webhook cleans up orphan authorizations.
3. The user's tokens expire normally.

**Immediate revocation (rarely necessary):**

- Frontend clears the token cache when showing the "access revoked"
  UI.
- jti denylist on the backend (more complex).

### Practical limits

- Direct authorizations per user: hundreds is ok; thousands starts
  to weigh. Above a thousand, rethink — probably an org-to-tenant
  case.
- Org-to-tenant authorizations per organization: tens/hundreds is
  trivial.
- Tenant tokens in the frontend storage: cap at ~20 with LRU.

### Webhook availability

The webhook (Action v2) is a **runtime dependency** of Token Exchange.
If it's down, exchanges fail.

Mitigations:
- Deploy the backend in the same cluster/host as Zitadel (low
  latency, joint failure unlikely).
- Health checks and auto-restart in the orchestrator.
- Consider fallback: should Zitadel emit a token without `tids` if
  the webhook fails? Probably **no** — that would be a failure-open,
  dangerous for authorization. Failure-closed (exchange fails) is
  safer.

### Zitadel schema migrations

Updating the Zitadel version may run DB migrations. In environments
with many orgs, this can take minutes to tens of minutes. A
controlled maintenance window is recommended.

---

## Trade-offs and rejected decisions

### Adopted decisions

| Decision | Rejected alternative | Reason |
|---|---|---|
| Tenant 100% in the domain | Tenant = empty Organization in Zitadel | Zitadel's native Authorizations require a target org with Project Grant; empty orgs don't naturally receive grants; the model gets twisted |
| Tenant 100% in the domain | Tenant = Project in Zitadel | Applications are per Project; N apps per tenant does not scale |
| Zitadel as the only auth server | Backend as secondary AS for tenant tokens | Single issuer is simpler (one JWKS key, unified audit); the webhook resolves customization |
| Action v2 (webhook) for claims | Sniffing Zitadel's Postgres | The internal schema is not a public API; changes between versions; the webhook is the official mechanism |
| Zitadel's native Authorization ≠ "user → tenant" | Try to use Authorization for per-tenant granularity | Authorization is "user → project with role in org X"; tenant is none of those |
| Direct + Org-to-Tenant in the same storage | Separate sources | Unified resolution simplifies; same conceptual table |
| Token Exchange scoped by tenant(s) | Everything in a broad token | Lean token; trivial authorization at endpoints; limited blast radius |
| Multiple `tids` in the token | Multiple tokens per request | UX for multi-tenant views without complicating requests |
| Filtering in the central repository | Filtering in the handlers | Reduces the error surface; endpoints become thin |
| Flat roles (scope-like, no hierarchy) | Hierarchical roles (`admin > editor > viewer`) | Implicit hierarchy hides authorization decisions; scope-like is explicit and composable. Delegation uses a strict subset |
| Delegation capability as an explicit role (`iam:delegate`) | Implicit administrative role | Without hierarchy, "admin" as an implicit concept does not exist; capability is just another label, assigned explicitly |
| Token carries `scope` + `tids` (uniform projection) | Token carries `{ tenant_id: [roles] }` matrix | Token size linear in tids (not N×M); endpoint validation is boolean (`scope in token.scope`); native OAuth2 alignment |
| Exchange full-fail with useful info in `insufficient_scope` | Exchange automatically adjusts to subset | Automatic adjustment masks client bugs; full-fail is the OAuth2 default and forces explicit handling |
| Row-level tenancy (presence of `tenant_id`) | Tenancy declared per entity type | The same collection can mix globals + tenanted; greater flexibility, no schema metadata |
| Endpoints with no tenant hierarchy; tenancy inferred from the token | URLs prefixed by tenant or dedicated header | Frontend doesn't have to build per-tenant URLs; backend doesn't validate path/header/token coherence; switching tenant = switching token |
| In-line re-exchange on the backend | Frontend orchestrates all renewal | The expired token carries authenticated tids in the claims (signature still valid); the backend extracts and renews without needing a hierarchy or tenant header |
| Platform token sufficient to access global resources | Require a tenant token on every request | Amplified endpoints (`/me`, global listings) work with just the platform token; tenancy filter naturally resolves when `tids = []` |
| Persistent platform, session tenant | Everything in session / everything persistent | Different roles; appropriate security and UX for each |
| 404 for "does not exist or no access" | Explicit 403 | Avoids info leak |
| Native Organizations cache (Redis) | No cache | Necessary for scale; native to Zitadel |
| Unidirectional webhook (Zitadel→storage) | Bidirectional sync | Bidirectional adds complexity without real gain |
| Unified deployment (Compose) | Zitadel and backend on separate hosts/clusters | Webhook latency is critical; co-location reduces risk |

### Explicitly rejected decisions

**Tenant = Organization (empty or with users) in Zitadel.** Evaluated
repeatedly. Rejected because Project Grant is Org → Org (between real
orgs with users); empty orgs pretending to be grant recipients goes
against Zitadel's design; orgs with account-users confuses identity
with tenancy.

**Tenant = Project in Zitadel.** Rejected because Applications are
per Project. It would force 1 Web app per tenant (infeasible) or a
twisted modeling (Project Main + auxiliary Projects with no apps).

**Group as a resource delegable between orgs.** Evaluated. Does not
exist in Zitadel, and is not proposed (Issue #5822 is about grouping
users within an org, not about delegation between orgs).

**Backend as a second auth server.** Evaluated. Rejected because it
introduces two issuers (Zitadel and backend), two signing keys,
fragmented audit. Action v2 resolves customization without
fragmenting the issuer.

**Direct sniffing of Zitadel's Postgres.** Rejected because the
internal schema is not a public API.

### Accepted limitations

- **The webhook is a runtime dependency of Token Exchange.**
  Co-location mitigates; failure-closed is the safe choice.

- **Eventual consistency on revocations.** Tokens issued before
  remain valid until they expire (short TTL).

- **Users do not change Identity Organization.** Zitadel does not
  support it natively. The user must be recreated in the new org if
  this happens.

- **Logical FKs (not constraints).** `user_id`, `org_id` in the
  storage point to Zitadel without a DB constraint. The reactive
  webhook cleans up orphans.

---

## Appendix — terminology and mappings

### Mapping of terms to real products

| Spec | Ads platform | Multi-project SaaS | Management system |
|---|---|---|---|
| Tenant | Advertising account | Workspace | Contract / Client |
| Organization | Company (advertiser, agency) | Client org | Client company |
| Role | editor, viewer, iam_admin | editor, viewer, admin_iam | read:contracts, write:contracts, manage:iam |

### Zitadel ↔ spec-concept mapping

| Zitadel | Spec | Notes |
|---|---|---|
| Instance | Instance | Not exposed |
| Organization | Organization | Real company/client, with users |
| User | User | Individual identity |
| Project | Project | Single; hosts apps + defines role vocabulary |
| Application | Application | OIDC clients (Web, API) |
| Project Role | Role (catalog) | Defines the capability vocabulary; same labels used in storage and in the token's scopes |
| Authorization (Role Assignment) | "Platform access" | Native; user → project. **Not** "user → tenant" |
| Project Grant | Allows users from other orgs to access the project | Native |
| Claim `scope` (OAuth2) | Scope in the tenant token | Validated by the webhook as a uniform projection of the roles across all tids |
| Action v2 | Webhook to validate exchange + inject claims | Official mechanism |
| (does not exist) | **Tenant** | Lives in the domain storage |
| (does not exist) | **User-Tenant Authorization** | Domain storage; carries `roles[]` |
| (does not exist) | **Org-Tenant Authorization** | Domain storage; carries `roles[]` |
| Groups (Issue #5822) | (not used in this spec) | Adjacent feature |

### Glossary

- **Tenant.** Unit of data isolation. Lives in the domain.
- **Organization (Identity).** Real org in Zitadel; hosts users.
- **User-Tenant Authorization.** Individual user → tenant permission,
  with a list of roles.
- **Org-Tenant Authorization.** Collective org → tenant permission
  (inherited by all users of the org), with a list of roles.
- **Role.** Flat label that identifies a specific capability in the
  tenant. No implicit hierarchy. Lives in the domain storage
  (`roles[]` column of authorizations). It is what the user **has**.
- **Effective roles.** Union of roles obtained by all paths
  (direct + via org) for a (user, tenant) pair.
- **Scope.** Capability declared at Token Exchange and validated by
  the webhook. Projected into the JWT's `scope` claim. Lives in the
  token. It is what the session **asked for and was authorized to
  use**. The scope vocabulary coincides with the role vocabulary.
- **Delegation.** The act of creating/revoking an authorization.
  Requires: (a) `iam:delegate` in the token's scope; (b) that the
  caller **possesses** all the roles being delegated.
- **Action v2.** Zitadel webhook that extends token flows.
- **Platform token.** Access token without `tids` or tenant-specific
  scopes; accesses amplified endpoints and global resources.
- **Tenant token.** Access token with `tids` + `scope`; accesses
  tenanted resources from the listed tenants, limited to the
  operations authorized by the scopes.
- **Token Exchange.** OAuth2 mechanism (RFC 8693) that exchanges one
  token for another with a different scope.

### Next steps for implementation

- Definition of the product's role/scope vocabulary (operational
  like `campaign:read`, `campaign:write`; administrative like
  `iam:delegate`, `billing:manage`) and UI mapping
- Migration strategy when coming from another IDP
- Endpoint × required-scope matrix
- Zitadel cache-specific configuration (TTLs, eviction)
- Aggregated I&AM API cache (Redis with short TTL for
  `validate-exchange`)
- Audit policy (Zitadel generates natively; integrate with
  observability)
- localStorage vs httpOnly cookie decision for the platform token
- Compose production configuration (TLS, secrets, backup)
