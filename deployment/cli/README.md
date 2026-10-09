# AAP CLI releases

The standalone `aap` executable is published to Cloudflare R2 at
`https://downloads.agentapprovalprotocol.io`. It supports macOS and Linux on
amd64 and arm64. Users do not need Go to install it.

```sh
curl -fsSL https://downloads.agentapprovalprotocol.io/install.sh | sh
```

The installer verifies SHA-256 checksums before replacing the executable and
prints the installed version. It defaults to `~/.local/bin/aap`; set
`AAP_INSTALL_DIR` to choose another absolute
directory. Keep the path stable because adapter hooks record it. `AAP_CLI_VERSION`
pins a release such as `0.1.0`, and `AAP_CLI_BASE` selects a mirror.

When the installation directory is absent from `PATH`, the installer uses
`SHELL` to configure Bash, Zsh or Fish. It respects `ZDOTDIR` and
`XDG_CONFIG_HOME`, preserves existing configuration and avoids duplicate entries
on reruns. Bash setup covers both interactive and login shells. Reopen the
terminal after setup or run the printed command to update the current shell.
Unsupported shells need manual PATH setup. Set `AAP_NO_MODIFY_PATH=1` to skip
startup-file changes, including in CI where you manage `PATH` yourself.

Rerunning the installer updates the binary and sets up PATH if needed; adapter
credentials and configuration stay in place. Restart runtime sessions after an update.

## Bucket layout

```text
install.sh
cli/<version>/aap-darwin-amd64
cli/<version>/aap-darwin-arm64
cli/<version>/aap-linux-amd64
cli/<version>/aap-linux-arm64
cli/<version>/SHA256SUMS
cli/<version>/version
cli/latest/aap-darwin-amd64
cli/latest/aap-darwin-arm64
cli/latest/aap-linux-amd64
cli/latest/aap-linux-arm64
cli/latest/SHA256SUMS
cli/latest/version
```

Version directories are immutable. The installer first resolves the small
`latest/version` pointer, then fetches the binary and checksum from that fixed
version. Publishing advances the pointer only after all files are uploaded, so
an installation cannot mix files from two releases. Checksums detect corruption;
they are delivered through the same HTTPS origin as the binaries.

The stable `cli/latest/` binary and checksum URLs serve the latest release for
direct downloads. Publishing refreshes these copies after the immutable version
is complete and before advancing `latest/version`. These copies update
individually; use the installer or a fixed version for downloads that must stay
on the same release during publication.

## Build and publish

The `Release CLI` GitHub Actions workflow runs for `vMAJOR.MINOR.PATCH` tags. It
checks that the tagged commit is on `main`, tests adapters and the installer,
uses GoReleaser to build all four targets and generate checksums, retains an
Actions artifact, and uploads to R2. It reads the R2 account, bucket and
credentials from repository variables and secrets that the maintainers manage.
Use its manual dispatch with an existing tag to retry a failed release.

After the PR checks pass and its changes land on `main`:

```sh
git tag v0.1.0
git push origin v0.1.0
```

GoReleaser 2.18.2 owns the build matrix, version injection, artifact names and
SHA-256 checksum manifest in `.goreleaser.yaml`. Build a snapshot locally with
Go 1.25 or later and GoReleaser:

```sh
goreleaser check
goreleaser release --snapshot --clean --skip=publish
```

`dist/` is ignored. For a real release, check out its tag and omit `--snapshot`.
The upload script consumes GoReleaser's artifact metadata and checksums; it does
not build binaries or calculate a separate release manifest. It keeps R2's
immutable version check and the final latest-pointer update outside the build.

Run `node --test deployment/cli/*.test.mjs` for installer and publication tests.
To upload a tagged release locally, export the same R2 settings and credentials
as CI and run `sh scripts/publish-release.sh 0.1.0`. This requires the AWS CLI
and `jq`. Snapshot versions cannot be published. A repeated upload refuses to
replace a published version with different checksums.
