#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

for command_name in git meson ninja npm node emcc python3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

if [[ -n "$(git status --porcelain --untracked-files=no)" && "${ALLOW_DIRTY:-0}" != "1" ]]; then
  echo "Refusing to package a modified checkout. Commit it first, or set ALLOW_DIRTY=1 for a test build." >&2
  exit 1
fi

revision="$(git rev-parse HEAD)"
if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Could not determine the full source revision." >&2
  exit 1
fi

native_options=(-Dbuildtype=release -Db_sanitize=none -Dnls=false -Dbuild_tests=false)
if [[ -f build-native/build.ninja ]]; then
  meson setup --reconfigure build-native "${native_options[@]}"
else
  meson setup build-native "${native_options[@]}"
fi
meson compile -C build-native -j "${JOBS:-4}" netpanzer:executable

# The production gateway needs only the locked `ws` runtime dependency.
npm ci --prefix support/web --omit=dev

bash support/web/build.sh build-web
python3 support/web/package-release.py \
  --build build-web \
  --output dist-web \
  --revision "$revision" \
  --source-url https://github.com/johnsie/netpanzer-ng

echo
echo "Native server: $repo_root/build-native/netpanzer"
echo "Browser release: $repo_root/dist-web/netpanzer-web-$revision.tar.gz"
echo "Checksum: $repo_root/dist-web/netpanzer-web-$revision.tar.gz.sha256"
