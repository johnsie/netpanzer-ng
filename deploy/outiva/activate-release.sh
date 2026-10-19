#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$repo_root" != /opt/netpanzer-ng ]]; then
  echo "The production checkout must be at /opt/netpanzer-ng." >&2
  exit 1
fi

archive="${1:-}"
if [[ -z "$archive" ]]; then
  echo "Usage: deploy/outiva/activate-release.sh dist-web/netpanzer-web-<commit>.tar.gz" >&2
  exit 1
fi
archive="$(realpath "$archive")"
checksum_file="$archive.sha256"
archive_name="$(basename "$archive")"

if [[ ! "$archive_name" =~ ^netpanzer-web-([0-9a-f]{40})\.tar\.gz$ ]]; then
  echo "Browser archive name must contain a full 40-character commit SHA." >&2
  exit 1
fi
revision="${BASH_REMATCH[1]}"
if [[ ! -f "$checksum_file" ]]; then
  echo "Missing checksum: $checksum_file" >&2
  exit 1
fi
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
  install -m 0644 "$staging/manifest.json" "$release_dir/manifest.json"
  rm -rf "$staging"
  trap - EXIT
fi

previous_release="$(readlink -f /srv/netpanzer/current 2>/dev/null || true)"
next_link="/srv/netpanzer/.current-$revision"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" /srv/netpanzer/current

if ! sudo -n /usr/bin/systemctl restart netpanzer-game.service netpanzer-web.service; then
  if [[ "$previous_release" == /srv/netpanzer/releases/* && -d "$previous_release" ]]; then
    rollback_link="/srv/netpanzer/.rollback-$revision"
    ln -s "$previous_release" "$rollback_link"
    mv -Tf "$rollback_link" /srv/netpanzer/current
    sudo -n /usr/bin/systemctl restart netpanzer-game.service netpanzer-web.service || true
  fi
  echo "Service restart failed; the previous browser release was restored." >&2
  exit 1
fi

echo "Activated NetPanzer release $revision"
