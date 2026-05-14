#!/usr/bin/env bash
# Configure Zitadel for the Untenanted example:
#   - Create a project + API application (client_credentials grant)
#   - Create a service-account user + a PAT
#   - Create project roles (campaign:read, campaign:write, iam:delegate, iam:read,
#     iam:tenant:create)
#   - Create user grant for the service account (so the action sees role assignments)
#   - Create Action v2 Target pointing at the adapter
#   - Create Action v2 Execution for preaccesstoken
#   - Create Action v2 Target + Executions for user.removed / org.removed events
# All IDs are persisted in .state/state.env.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

require_jq

echo "==> Creating Untenanted project"
proj_resp=$(zcurl -X POST "$ZITADEL_BASE/management/v1/projects" \
  -d '{"name":"untenanted","projectRoleAssertion":true,"projectRoleCheck":false,"hasProjectCheck":false}')
PROJECT_ID=$(echo "$proj_resp" | jq -r '.id')
echo "    project id: $PROJECT_ID"
remember PROJECT_ID "$PROJECT_ID"

echo "==> Adding project roles"
for role in "iam:read" "iam:delegate" "iam:tenant:create" "iam:tenant:update" "iam:tenant:delete" "campaign:read" "campaign:write"; do
  zcurl -X POST "$ZITADEL_BASE/management/v1/projects/$PROJECT_ID/roles" \
    -d "{\"roleKey\":\"$role\",\"displayName\":\"$role\",\"group\":\"untenanted\"}" >/dev/null || true
done

echo "==> Creating API application (client_credentials)"
app_resp=$(zcurl -X POST "$ZITADEL_BASE/management/v1/projects/$PROJECT_ID/apps/api" \
  -d '{"name":"untenanted-api","authMethodType":"API_AUTH_METHOD_TYPE_BASIC"}')
APP_ID=$(echo "$app_resp" | jq -r '.appId')
APP_CLIENT_ID=$(echo "$app_resp" | jq -r '.clientId')
APP_CLIENT_SECRET=$(echo "$app_resp" | jq -r '.clientSecret')
echo "    app id: $APP_ID  client_id: $APP_CLIENT_ID"
remember APP_ID "$APP_ID"
remember APP_CLIENT_ID "$APP_CLIENT_ID"
remember APP_CLIENT_SECRET "$APP_CLIENT_SECRET"

echo "==> Creating service-account machine user"
sa_resp=$(zcurl -X POST "$ZITADEL_BASE/management/v1/users/machine" \
  -d '{"userName":"untenanted-sa","name":"Untenanted Service Account","description":"Service account for end-to-end tests","accessTokenType":"ACCESS_TOKEN_TYPE_JWT"}')
SA_USER_ID=$(echo "$sa_resp" | jq -r '.userId')
echo "    service-account user id: $SA_USER_ID"
remember SA_USER_ID "$SA_USER_ID"

echo "==> Creating PAT for the service account"
sa_pat_resp=$(zcurl -X POST "$ZITADEL_BASE/management/v1/users/$SA_USER_ID/pats" \
  -d '{"expirationDate":"2099-01-01T00:00:00Z"}')
SA_PAT=$(echo "$sa_pat_resp" | jq -r '.token')
remember SA_PAT "$SA_PAT"
echo "    PAT issued (truncated): ${SA_PAT:0:10}..."

echo "==> Adding client_credentials secret on the service account"
sec_resp=$(zcurl -X PUT "$ZITADEL_BASE/management/v1/users/$SA_USER_ID/secret" -d '{}')
SA_CLIENT_ID=$(echo "$sec_resp" | jq -r '.clientId')
SA_CLIENT_SECRET=$(echo "$sec_resp" | jq -r '.clientSecret')
remember SA_CLIENT_ID "$SA_CLIENT_ID"
remember SA_CLIENT_SECRET "$SA_CLIENT_SECRET"
echo "    client_id=$SA_CLIENT_ID  client_secret (truncated)=${SA_CLIENT_SECRET:0:8}..."

echo "==> Granting service account roles on the project"
zcurl -X POST "$ZITADEL_BASE/management/v1/users/$SA_USER_ID/grants" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"roleKeys\":[\"iam:read\",\"iam:delegate\",\"iam:tenant:create\",\"campaign:read\",\"campaign:write\"]}" >/dev/null
echo "    grants assigned"

echo "==> Creating Action v2 Target: preaccesstoken (points at the api's bundled adapter)"
tgt_resp=$(zcurl -X POST "$ZITADEL_BASE/v2beta/actions/targets" -d '{
  "name": "untenanted-preaccesstoken",
  "restCall": { "interruptOnError": true },
  "endpoint": "http://untenanted-api:3000/adapters/zitadel/preaccesstoken",
  "timeout": "10s"
}')
PRE_TARGET_ID=$(echo "$tgt_resp" | jq -r '.id')
PRE_TARGET_KEY=$(echo "$tgt_resp" | jq -r '.signingKey')
echo "    preaccesstoken target: $PRE_TARGET_ID  signing key (truncated): ${PRE_TARGET_KEY:0:8}..."
remember PRE_TARGET_ID "$PRE_TARGET_ID"
remember PRE_TARGET_KEY "$PRE_TARGET_KEY"

echo "==> Creating Action v2 Execution: function=preaccesstoken"
zcurl -X PUT "$ZITADEL_BASE/v2beta/actions/executions" -d "{
  \"condition\": { \"function\": { \"name\": \"preaccesstoken\" } },
  \"targets\": [\"$PRE_TARGET_ID\"]
}" >/dev/null

echo "==> Creating Action v2 Target: events (user/org removal)"
ev_resp=$(zcurl -X POST "$ZITADEL_BASE/v2beta/actions/targets" -d '{
  "name": "untenanted-events",
  "restCall": { "interruptOnError": false },
  "endpoint": "http://untenanted-api:3000/adapters/zitadel/events",
  "timeout": "10s"
}')
EV_TARGET_ID=$(echo "$ev_resp" | jq -r '.id')
EV_TARGET_KEY=$(echo "$ev_resp" | jq -r '.signingKey')
echo "    events target: $EV_TARGET_ID  signing key (truncated): ${EV_TARGET_KEY:0:8}..."
remember EV_TARGET_ID "$EV_TARGET_ID"
remember EV_TARGET_KEY "$EV_TARGET_KEY"

# Comma-separated list of signing keys to pass to the api via env so it can
# verify the ZITADEL-Signature header on adapter routes.
remember ADAPTER_ZITADEL_SIGNING_KEYS "$PRE_TARGET_KEY,$EV_TARGET_KEY"

echo "==> Creating Action v2 Executions for user.removed / org.removed events"
zcurl -X PUT "$ZITADEL_BASE/v2beta/actions/executions" -d "{
  \"condition\": { \"event\": { \"group\": \"user\" } },
  \"targets\": [\"$EV_TARGET_ID\"]
}" >/dev/null
zcurl -X PUT "$ZITADEL_BASE/v2beta/actions/executions" -d "{
  \"condition\": { \"event\": { \"group\": \"org\" } },
  \"targets\": [\"$EV_TARGET_ID\"]
}" >/dev/null

echo
echo "Done. State persisted at $STATE_DIR/state.env"
