#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this installer as root (for example, with sudo)." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
expected_root=/opt/netpanzer-ng
if [[ "$repo_root" != "$expected_root" ]]; then
  echo "The production checkout must be at $expected_root; current path is $repo_root." >&2
  exit 1
fi

archive="${1:-}"
if [[ -z "$archive" ]]; then
  echo "Usage: sudo deploy/outiva/install-host.sh /path/to/netpanzer-web-<commit>.tar.gz" >&2
  exit 1
fi
archive="$(realpath "$archive")"
checksum_file="$archive.sha256"

for required in \
  "$repo_root/build-native/netpanzer" \
  "$repo_root/support/web/server.mjs" \
  "$repo_root/support/web/node_modules/ws/package.json" \
  "$archive" \
  "$checksum_file"; do
  if [[ ! -e "$required" ]]; then
    echo "Required build output is missing: $required" >&2
    exit 1
  fi
done

archive_name="$(basename "$archive")"
if [[ ! "$archive_name" =~ ^netpanzer-web-([0-9a-f]{40})\.tar\.gz$ ]]; then
  echo "Browser archive name must contain a full 40-character commit SHA." >&2
  exit 1
fi
revision="${BASH_REMATCH[1]}"

(cd "$(dirname "$archive")" && sha256sum --check "$(basename "$checksum_file")")

expected_files=(
  client/index.html
  client/launcher.js
  client/netpanzer.js
  client/netpanzer.wasm
  client/netpanzer.data
  client/COPYING.txt
  manifest.json
)
mapfile -t archive_files < <(tar -tzf "$archive" | sed 's#^\./##' | sort)
for expected in "${expected_files[@]}"; do
  if ! printf '%s\n' "${archive_files[@]}" | grep -Fxq "$expected"; then
    echo "Browser archive is missing $expected" >&2
    exit 1
  fi
done
if printf '%s\n' "${archive_files[@]}" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Browser archive contains an unsafe path." >&2
  exit 1
fi

if ! getent group netpanzer >/dev/null; then
  groupadd --system netpanzer
fi
if ! id netpanzer >/dev/null 2>&1; then
  useradd --system --gid netpanzer --home-dir /var/lib/netpanzer \
    --create-home --shell /usr/sbin/nologin netpanzer
fi

install -d -o netpanzer -g netpanzer -m 0750 /var/lib/netpanzer/.netpanzer/config
install -d -o root -g root -m 0755 /etc/netpanzer /srv/netpanzer/releases
install -d -o root -g root -m 0750 /etc/ssl/netpanzer.outiva.com

install_if_missing() {
  local source="$1" destination="$2" owner="$3" group="$4" mode="$5"
  if [[ -e "$destination" ]]; then
    echo "Preserving existing configuration: $destination"
  else
    install -o "$owner" -g "$group" -m "$mode" "$source" "$destination"
  fi
}

install_if_missing deploy/outiva/config/server.cfg \
  /var/lib/netpanzer/.netpanzer/config/server.cfg netpanzer netpanzer 0640
install_if_missing deploy/outiva/config/servers.json \
  /etc/netpanzer/servers.json root netpanzer 0640

release_dir="/srv/netpanzer/releases/$revision"
if [[ ! -d "$release_dir" ]]; then
  staging="$(mktemp -d /srv/netpanzer/releases/.install.XXXXXX)"
  trap 'rm -rf "$staging"' EXIT
  tar -xzf "$archive" -C "$staging"
  manifest_revision="$(node -e \
    "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1])); process.stdout.write(m.release || '')" \
    "$staging/manifest.json")"
  if [[ "$manifest_revision" != "$revision" ]]; then
    echo "Manifest revision does not match the archive filename." >&2
    exit 1
  fi
  mv "$staging/client" "$release_dir"
  install -o root -g root -m 0644 "$staging/manifest.json" "$release_dir/manifest.json"
  rm -rf "$staging"
  trap - EXIT
fi
chown -R root:root "$release_dir"

next_link="/srv/netpanzer/.current-$revision"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" /srv/netpanzer/current

install -o root -g root -m 0644 deploy/outiva/systemd/netpanzer-game.service \
  /etc/systemd/system/netpanzer-game.service
install -o root -g root -m 0644 deploy/outiva/systemd/netpanzer-web.service \
  /etc/systemd/system/netpanzer-web.service
install -o root -g root -m 0644 deploy/outiva/apache/netpanzer.outiva.com.conf \
  /etc/apache2/sites-available/netpanzer.outiva.com.conf

systemctl daemon-reload

echo
echo "Installed browser release $revision. Existing game and gateway configuration was preserved."
echo "No service was started and no Apache site was enabled."
echo "Next: install the origin certificate, enable the Apache modules/site, then run the checks in deploy/outiva/README.md."
