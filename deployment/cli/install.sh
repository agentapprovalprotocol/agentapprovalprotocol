#!/bin/sh
# Install a checksum-verified AAP CLI release from the public R2 bucket.
# AAP_CLI_BASE selects a mirror, AAP_CLI_VERSION pins a release, and
# AAP_INSTALL_DIR selects the stable directory used by installed hooks.
set -eu

say() { printf '%s\n' "$*" >&2; }
die() { say "install.sh: $*"; exit 1; }
[ "$#" -eq 0 ] || die "this script takes no arguments; run aap install after installing the CLI"

base=${AAP_CLI_BASE:-https://downloads.agentapprovalprotocol.io}
version=${AAP_CLI_VERSION:-latest}
target=${AAP_INSTALL_DIR:-$HOME/.local/bin}
case "$target" in /*) ;; *) die "AAP_INSTALL_DIR must be an absolute path" ;; esac
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "supported operating systems are macOS and Linux" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "supported architectures are amd64 and arm64" ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q --timeout=300 --tries=3 "$1" -O "$2"; }
else
  die "curl or wget is required"
fi
if command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | awk '{print $1}'; }
else
  die "shasum or sha256sum is required"
fi

tmp=$(mktemp -d)
staged=
cleanup() {
  rm -r "$tmp"
  if [ -n "$staged" ] && [ -f "$staged" ]; then rm "$staged"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
if [ "$version" = latest ]; then
  fetch "$base/cli/latest/version" "$tmp/version"
  version=$(cat "$tmp/version")
fi
case "$version" in ''|*[!0-9.]*) die "invalid release version" ;; esac
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "invalid release version: $version"

file=aap-$os-$arch
say "Downloading aap $version for $os/$arch"
fetch "$base/cli/$version/$file" "$tmp/aap"
fetch "$base/cli/$version/SHA256SUMS" "$tmp/SHA256SUMS"
expected=$(awk -v file="$file" '$2 == file && NF == 2 {print $1}' "$tmp/SHA256SUMS")
[ "${#expected}" -eq 64 ] || die "SHA256SUMS must contain one checksum for $file"
case "$expected" in *[!0-9a-f]*) die "invalid checksum for $file" ;; esac
[ "$expected" = "$(digest "$tmp/aap")" ] || die "checksum mismatch for $file"

# Stage on the destination filesystem so replacement is atomic, including
# upgrades while a runtime still holds the previous executable open.
[ ! -d "$target/aap" ] || die "$target/aap is a directory"
mkdir -p "$target"
staged=$(mktemp "$target/.aap-install.XXXXXX")
cat "$tmp/aap" > "$staged"
chmod 0755 "$staged"
mv -f "$staged" "$target/aap"
staged=
"$target/aap" version
say "Installed $target/aap"
case ":$PATH:" in
  *":$target:"*) ;;
  *) say "Add $target to your PATH before installing adapters." ;;
esac
