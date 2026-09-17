#!/bin/sh
# Install a checksum-verified AAP CLI release from the public R2 bucket.
# AAP_CLI_BASE selects a mirror, AAP_CLI_VERSION pins a release, and
# AAP_INSTALL_DIR selects the stable directory used by installed hooks.
# AAP_NO_MODIFY_PATH=1 leaves shell startup files unchanged.
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
  *":$target:"*) say "Run aap adapters to choose a runtime."; exit 0 ;;
esac

# Quote paths as shell literals, including spaces, quotes and dollar signs.
quoted_target=$(printf "'%s'" "$(printf '%s' "$target" | sed "s/'/'\\\\''/g")")
path_line="case \":\$PATH:\" in *:$quoted_target:*) ;; *) export PATH=$quoted_target:\"\$PATH\" ;; esac"
path_command="export PATH=$quoted_target:\"\$PATH\""
shell_name=${SHELL:-}
shell_name=${shell_name##*/}
if [ "$shell_name" = fish ]; then
  quoted_target=$(printf "'%s'" "$(printf '%s' "$target" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g")")
  path_line="if not contains -- $quoted_target \$PATH; set -gx PATH $quoted_target \$PATH; end"
  path_command="set -gx PATH $quoted_target \$PATH"
fi

add_to_profile() {
  profile=$1
  if [ -f "$profile" ] && grep -Fqx -- "$path_line" "$profile"; then
    return 0
  fi
  if (mkdir -p "$(dirname "$profile")" && printf '\n# AAP CLI\n%s\n' "$path_line" >> "$profile"); then
    say "Added $target to PATH in $profile"
  else
    say "Could not update $profile. Add the PATH command below to your shell configuration."
    return 1
  fi
}

path_ready=1
case "$shell_name" in
  bash | zsh | fish) ;;
  *)
    say "Automatic PATH setup supports Bash, Zsh and Fish. Add $target to your shell's PATH."
    say "You can run the CLI now with: $quoted_target/aap adapters"
    exit 0
    ;;
esac
if [ "${AAP_NO_MODIFY_PATH:-0}" = 1 ]; then
  path_ready=0
  say "Skipping shell setup because AAP_NO_MODIFY_PATH=1."
else
  case "$shell_name" in
    zsh) add_to_profile "${ZDOTDIR:-$HOME}/.zshrc" || path_ready=0 ;;
    bash)
      # Interactive shells read .bashrc; login shells read the first of these
      # profiles. Do not create a file that would hide an existing login profile.
      add_to_profile "$HOME/.bashrc" || path_ready=0
      if [ -f "$HOME/.bash_profile" ]; then
        add_to_profile "$HOME/.bash_profile" || path_ready=0
      elif [ -f "$HOME/.bash_login" ]; then
        add_to_profile "$HOME/.bash_login" || path_ready=0
      else
        add_to_profile "$HOME/.profile" || path_ready=0
      fi
      ;;
    fish) add_to_profile "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" || path_ready=0 ;;
  esac
fi

if [ "$path_ready" = 1 ]; then
  say "Restart your terminal, then run: aap adapters"
fi
say "To use aap in this terminal now, run:"
say "  $path_command"
