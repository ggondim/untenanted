# IdP adapter sketches

The Untenanted API is intentionally generic. It speaks two normalized
contracts:

- `POST /iam/internal/validate-exchange` — called during token exchange to
  decide whether to enrich the token with `tids` + `scope`. Authenticated by
  the shared `X-Internal-Auth` header.
- `POST /webhooks/events` — called when the IdP removes a user or an org, so
  the domain storage can clean up authorizations. Authenticated by the shared
  `X-Webhook-Auth` header.

Both endpoints expect IdP-neutral payloads. Each IdP needs a tiny adapter
that translates its native payload into these contracts. Below are sketches
for the most common IdPs. None of this code lives in the Untenanted
repository — it goes wherever your IdP runs custom scripts/extensions.

## Zitadel Action v2 (pre-token-creation)

```js
// pre-token-creation Action: validate the exchange and enrich the token.
async function preTokenCreation(ctx, api) {
  const body = {
    userId: ctx.v1.user.id,
    orgId: ctx.v1.user.resourceOwner,
    requestedTids: ctx.v1.tokenRequest.resource ?? [],
    requestedScopes: (ctx.v1.tokenRequest.scope ?? []).filter(s => !s.startsWith("openid")),
  };
  const res = await fetch("http://untenanted:3000/iam/internal/validate-exchange", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-auth": ctx.secrets.UNTENANTED_INTERNAL_SECRET,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    return api.v1.deny({ reason: "insufficient_scope", details: data.missing });
  }
  api.v1.claims.set("tids", body.requestedTids);
  api.v1.claims.set("scope", data.effectiveScopes.join(" "));
}
```

## Zitadel Action v2 (user.removed / org.removed)

```js
async function onUserRemoved(ctx) {
  await fetch("http://untenanted:3000/webhooks/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-auth": ctx.secrets.UNTENANTED_WEBHOOK_SECRET,
    },
    body: JSON.stringify({ type: "user.removed", userId: ctx.v1.user.id }),
  });
}
async function onOrgRemoved(ctx) {
  await fetch("http://untenanted:3000/webhooks/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-auth": ctx.secrets.UNTENANTED_WEBHOOK_SECRET,
    },
    body: JSON.stringify({ type: "org.removed", orgId: ctx.v1.org.id }),
  });
}
```

## Keycloak event listener (SPI)

```java
public class UntenantedEventListener implements EventListenerProvider {
  @Override
  public void onEvent(AdminEvent event, boolean includeRepresentation) {
    if (event.getResourceType() == ResourceType.USER && event.getOperationType() == OperationType.DELETE) {
      post("/webhooks/events", Map.of(
        "type", "user.removed",
        "userId", lastSegment(event.getResourcePath())
      ));
    }
    if (event.getResourceType() == ResourceType.GROUP /* used as org */ && event.getOperationType() == OperationType.DELETE) {
      post("/webhooks/events", Map.of(
        "type", "org.removed",
        "orgId", lastSegment(event.getResourcePath())
      ));
    }
  }
}
```

For Keycloak token exchange, a protocol mapper or token-mapper SPI can call
`/iam/internal/validate-exchange` and reject the exchange or stamp the
resulting token with `tids` + `scope` based on the response.

## Auth0 Action (post-login or token exchange hook)

```js
exports.onExecutePostLogin = async (event, api) => {
  const body = {
    userId: event.user.user_id,
    orgId: event.user.app_metadata.org_id,
    requestedTids: event.transaction.requested_scopes
      .filter(s => s.startsWith("tid:"))
      .map(s => s.slice(4)),
    requestedScopes: event.transaction.requested_scopes
      .filter(s => !s.startsWith("tid:")),
  };
  const res = await fetch(`${event.secrets.UNTENANTED_BASE}/iam/internal/validate-exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-auth": event.secrets.UNTENANTED_INTERNAL_SECRET,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    return api.access.deny("insufficient_scope");
  }
  api.idToken.setCustomClaim("tids", body.requestedTids);
  api.idToken.setCustomClaim("scope", data.effectiveScopes.join(" "));
};
```

## Notes

- The shared secret should be rotated periodically and stored in the IdP's
  secret manager.
- The Untenanted API does not assume the IdP's webhook payload format. As
  long as the adapter posts the normalized event, any IdP — or even a custom
  authentication server — works.
