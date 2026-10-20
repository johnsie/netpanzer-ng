#!/usr/bin/env bash
# Creates/updates NetPanzer's confidential client and installs its server secrets.
# Run on the host as root after the repository and netpanzer user are installed.
set -euo pipefail

SOURCE_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CLIENT_JSON="$SOURCE_ROOT/deploy/outiva/keycloak/netpanzer-client.json"
KEYCLOAK_ENV=/etc/keycloak/keycloak.env
NETPANZER_ENV=/etc/netpanzer/oidc.env
KCADM=/opt/keycloak/bin/kcadm.sh

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this configuration as root (sudo $0)." >&2
  exit 1
fi
if [ ! -x "$KCADM" ] || [ ! -r "$KEYCLOAK_ENV" ] || [ ! -r "$CLIENT_JSON" ]; then
  echo "The Outiva Keycloak installation or NetPanzer client definition was not found." >&2
  exit 1
fi
if ! getent group netpanzer >/dev/null; then
  echo "Install the NetPanzer host service before configuring OIDC." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$KEYCLOAK_ENV"
set +a
: "${KC_BOOTSTRAP_ADMIN_USERNAME:?Missing Keycloak administrator username}"
: "${KC_BOOTSTRAP_ADMIN_PASSWORD:?Missing Keycloak administrator password}"

admin_config=$(mktemp)
trap 'rm -f "$admin_config"' EXIT
chmod 0600 "$admin_config"
"$KCADM" config credentials --config "$admin_config" \
  --server http://127.0.0.1:8180 --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"

client_id=$(
  "$KCADM" get clients --config "$admin_config" -r outiva -q clientId=netpanzer-web \
    --fields id --format csv --noquotes | head -n 1
)
if [ -n "$client_id" ]; then
  "$KCADM" update "clients/$client_id" --config "$admin_config" -r outiva -f "$CLIENT_JSON"
else
  client_id=$("$KCADM" create clients --config "$admin_config" -r outiva -f "$CLIENT_JSON" -i)
fi

client_secret=$(
  "$KCADM" get "clients/$client_id/client-secret" --config "$admin_config" -r outiva \
    --fields value --format csv --noquotes
)
if [ -z "$client_secret" ]; then
  client_secret_json=$(
    "$KCADM" create "clients/$client_id/client-secret" --config "$admin_config" -r outiva -o
  )
  client_secret=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])' <<<"$client_secret_json")
fi
if [ -r "$NETPANZER_ENV" ]; then
  session_secret=$(sed -n 's/^NETPANZER_SESSION_SECRET=//p' "$NETPANZER_ENV")
fi
session_secret=${session_secret:-$(openssl rand -hex 48)}

install -d -o root -g netpanzer -m 0750 /etc/netpanzer
umask 0077
secrets_tmp=$(mktemp /etc/netpanzer/oidc.env.XXXXXX)
trap 'rm -f "$admin_config" "$secrets_tmp"' EXIT
{
  echo 'NETPANZER_OIDC_ISSUER=https://accounts.outiva.com/realms/outiva'
  echo 'NETPANZER_OIDC_CLIENT_ID=netpanzer-web'
  printf 'NETPANZER_OIDC_CLIENT_SECRET=%s\n' "$client_secret"
  printf 'NETPANZER_SESSION_SECRET=%s\n' "$session_secret"
  echo 'NETPANZER_OUTIVA_ORIGIN=https://outiva.com'
} > "$secrets_tmp"
chown root:netpanzer "$secrets_tmp"
chmod 0640 "$secrets_tmp"
mv -f "$secrets_tmp" "$NETPANZER_ENV"
trap 'rm -f "$admin_config"' EXIT

install -o root -g root -m 0644 "$SOURCE_ROOT/deploy/outiva/systemd/netpanzer-web.service" \
  /etc/systemd/system/netpanzer-web.service
systemctl daemon-reload
systemctl restart netpanzer-web.service
echo "NetPanzer OIDC is configured. Secrets are stored in $NETPANZER_ENV and were not printed."
