#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script as root (for example, with sudo)." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required." >&2
  exit 1
fi

certificate_dir=/etc/ssl/netpanzer.outiva.com
certificate="$certificate_dir/origin.crt"
private_key="$certificate_dir/origin.key"

if [[ -e "$certificate" || -e "$private_key" ]]; then
  echo "Refusing to replace an existing origin certificate or key in $certificate_dir." >&2
  exit 1
fi

install -d -o root -g root -m 0750 "$certificate_dir"
umask 077
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
  -subj /CN=netpanzer.outiva.com \
  -addext subjectAltName=DNS:netpanzer.outiva.com,IP:192.168.10.181 \
  -addext basicConstraints=critical,CA:FALSE \
  -addext keyUsage=critical,digitalSignature,keyEncipherment \
  -addext extendedKeyUsage=serverAuth \
  -keyout "$private_key" \
  -out "$certificate"
chmod 0600 "$private_key"
chmod 0644 "$certificate"

openssl x509 -in "$certificate" -noout -subject -issuer -dates -ext subjectAltName
echo "Created $certificate and $private_key"
