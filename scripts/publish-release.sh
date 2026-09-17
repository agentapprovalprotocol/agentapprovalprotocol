#!/bin/sh
set -eu
version=${1:?usage: publish-release.sh VERSION [GORELEASER_DIST_DIRECTORY]}
case "$version" in ''|*[!0-9.]*) echo 'invalid version' >&2; exit 1 ;; esac
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo 'invalid version' >&2; exit 1; }
: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}"
: "${R2_PUBLIC_BUCKET:?R2_PUBLIC_BUCKET is required}"
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
out=${2:-$root/dist}
export AWS_DEFAULT_REGION=auto
export AWS_ENDPOINT_URL="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
prefix="cli/$version"
test "$(jq -er .version "$out/metadata.json")" = "$version"
tmp=$(mktemp -d)
trap 'rm -r "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$tmp/release"
# Use GoReleaser's artifact names and paths, including its architecture suffixes.
for file in aap-darwin-amd64 aap-darwin-arm64 aap-linux-amd64 aap-linux-arm64; do
  artifact=$(jq -er --arg name "$file" \
    '[.[] | select(.type == "Binary" and .name == $name)] | if length == 1 then .[0].path else error("missing or duplicate binary") end' \
    "$out/artifacts.json")
  case "$artifact" in /*) ;; *) artifact="$root/$artifact" ;; esac
  cp "$artifact" "$tmp/release/$file"
done
cp "$out/SHA256SUMS" "$tmp/release/SHA256SUMS"
printf '%s\n' "$version" > "$tmp/release/version"
(
  cd "$tmp/release"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check SHA256SUMS
  else
    shasum -a 256 --check SHA256SUMS
  fi
)

# A published version is immutable. An interrupted upload without a manifest
# can be retried; a completed upload can only be retried with identical bytes.
existing=$(aws s3api list-objects-v2 --bucket "$R2_PUBLIC_BUCKET" \
  --prefix "$prefix/SHA256SUMS" --query 'Contents[].Key' --output text)
if [ -n "$existing" ] && [ "$existing" != None ]; then
  aws s3 cp "s3://$R2_PUBLIC_BUCKET/$prefix/SHA256SUMS" "$tmp/SHA256SUMS" --only-show-errors
  cmp "$tmp/release/SHA256SUMS" "$tmp/SHA256SUMS" || { echo 'refusing to replace a published version' >&2; exit 1; }
fi
for file in aap-darwin-amd64 aap-darwin-arm64 aap-linux-amd64 aap-linux-arm64 version; do
  aws s3 cp "$tmp/release/$file" "s3://$R2_PUBLIC_BUCKET/$prefix/$file" \
    --cache-control 'public, max-age=31536000, immutable' --only-show-errors
done
aws s3 cp "$tmp/release/SHA256SUMS" "s3://$R2_PUBLIC_BUCKET/$prefix/SHA256SUMS" \
  --cache-control 'public, max-age=31536000, immutable' --content-type text/plain --only-show-errors
aws s3 cp "$root/deployment/cli/install.sh" "s3://$R2_PUBLIC_BUCKET/install.sh" \
  --cache-control 'public, max-age=300' --content-type text/x-shellscript --only-show-errors
# Publish stable direct-download URLs after all immutable objects exist.
for file in aap-darwin-amd64 aap-darwin-arm64 aap-linux-amd64 aap-linux-arm64; do
  aws s3 cp "$tmp/release/$file" "s3://$R2_PUBLIC_BUCKET/cli/latest/$file" \
    --cache-control 'no-cache' --only-show-errors
done
aws s3 cp "$tmp/release/SHA256SUMS" "s3://$R2_PUBLIC_BUCKET/cli/latest/SHA256SUMS" \
  --cache-control 'no-cache' --content-type text/plain --only-show-errors
# Advance the installer pointer only after all uploads succeed.
aws s3 cp "$tmp/release/version" "s3://$R2_PUBLIC_BUCKET/cli/latest/version" \
  --cache-control 'no-cache' --content-type text/plain --only-show-errors
