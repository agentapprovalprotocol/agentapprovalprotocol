#!/bin/sh
set -eu
version=${1:?usage: build-release.sh VERSION [OUTPUT_DIRECTORY]}
case "$version" in ''|*[!0-9.]*) echo 'invalid version' >&2; exit 1 ;; esac
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo 'version must be MAJOR.MINOR.PATCH' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
out=${2:-$root/dist}
mkdir -p "$out/cli/$version"
out=$(CDPATH= cd -- "$out" && pwd)
cd "$root"
for platform in darwin/amd64 darwin/arm64 linux/amd64 linux/arm64; do
  os=${platform%/*}
  arch=${platform#*/}
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
    -ldflags "-s -w -X main.version=$version" \
    -o "$out/cli/$version/aap-$os-$arch" ./cmd/aap
done
(
  cd "$out/cli/$version"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum aap-* > SHA256SUMS
  else
    shasum -a 256 aap-* > SHA256SUMS
  fi
)
cp deployment/cli/install.sh "$out/install.sh"
printf '%s\n' "$version" > "$out/cli/$version/version"
printf 'Built aap %s in %s\n' "$version" "$out"
