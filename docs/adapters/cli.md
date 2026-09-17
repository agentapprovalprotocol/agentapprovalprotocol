---
lastModified: 2026-09-17
---

# AAP CLI

Use the `aap` CLI to install and manage [AAP adapters](overview.md). It connects your runtime to an existing AAP provider using an instance token and the provider's AAP base URL.

## Install the CLI

Download the standalone `aap` binary for macOS or Linux, on amd64 or arm64:

```sh
curl -fsSL https://downloads.agentapprovalprotocol.io/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
aap version
```

The installer checks the download against the release's SHA-256 checksums and installs to `~/.local/bin/aap`. Add that directory to your shell's startup configuration so it remains on `PATH`. It does not require Go or install an adapter until you run `aap install`.

Keep the binary at a stable absolute path: installed hooks record that path. Runtime applications must already be installed and configured.

To choose a different directory or pin a version, download the installer and set its options:

```sh
curl -fsSL https://downloads.agentapprovalprotocol.io/install.sh -o /tmp/install-aap.sh
AAP_INSTALL_DIR="$HOME/.local/bin" AAP_CLI_VERSION=0.1.0 sh /tmp/install-aap.sh
```

`AAP_CLI_BASE` selects a download mirror. Rerun the installer to update the executable in place, then start fresh runtime sessions or restart the runtime's plugin host. Existing adapter credentials and configuration stay in their configuration directory.

You can also download release 0.1.0 directly:

| Platform | Binary |
| --- | --- |
| macOS, Apple silicon | [aap-darwin-arm64](https://downloads.agentapprovalprotocol.io/cli/0.1.0/aap-darwin-arm64) |
| macOS, Intel | [aap-darwin-amd64](https://downloads.agentapprovalprotocol.io/cli/0.1.0/aap-darwin-amd64) |
| Linux, arm64 | [aap-linux-arm64](https://downloads.agentapprovalprotocol.io/cli/0.1.0/aap-linux-arm64) |
| Linux, amd64 | [aap-linux-amd64](https://downloads.agentapprovalprotocol.io/cli/0.1.0/aap-linux-amd64) |

Verify direct downloads against [SHA256SUMS](https://downloads.agentapprovalprotocol.io/cli/0.1.0/SHA256SUMS), make the binary executable and name it `aap` in your chosen installation directory.

### Build from source

With Go 1.25 or later, run from the [repository](https://github.com/agentapprovalprotocol/agentapprovalprotocol) root:

```sh
mkdir -p "$HOME/.local/bin"
go build -o "$HOME/.local/bin/aap" ./cmd/aap
aap version
```

## Install an adapter

Obtain an instance token and the AAP base URL from your provider or provisioner, then run:

```sh
aap adapters
aap install claude-code --instance-token "$INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
aap status claude-code
```

The URL is the complete AAP root, including any path prefix. The example creates approval requests at `https://approvals.example.com/api/aap/v1/requests`. HTTPS is required except for local development on `localhost`, `127.0.0.1` or `::1`.

Installation does not enroll an instance, select provider policies or contact the provider. Follow the returned restart or runtime-consent notes, then make a harmless tool call. Approve it through your provider and repeat with a denial. `status` inspects local configuration; it does not prove provider reachability or that a running session has reloaded its hooks.

## Optional tool filter

Every intercepted call is submitted by default. To limit coverage:

```sh
aap install claude-code --instance-token "$INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap" --tool-glob 'create_*'
```

The filter uses case-sensitive Go `path.Match` syntax: `*`, `?` and character classes. A slash separates path segments for matching. Quote the pattern so the shell does not expand it. Empty or omitted patterns cover every tool; malformed patterns are rejected before installation changes anything.

Matching happens after runtime-specific normalization. For example, `mcp__stripe__create_refund` becomes `create_refund`, so the same pattern can match tools from multiple MCP servers. Calls outside the filter continue through the runtime's normal local permission flow without contacting AAP.

## Credentials and maintenance

AAP stores one installation per runtime under the operating system's user configuration directory plus `aap`. `AAP_CONFIG_DIR` selects a different root. Installed commands and plugins retain that root even if the launching runtime has a different environment.

Tokens are stored in `credentials/<runtime>.json` with owner-only access. They are absent from installed hook commands, status output and plugin configuration. Reinstalling replaces the credential, URL and filter without adding duplicate hooks. Omitting a previously configured filter removes it.

```sh
aap status
aap uninstall claude-code
```

Uninstall reverses recorded edits and removes the local credential. It preserves unrelated configuration changes and user-added plugin files. Provider credential revocation is separate. Partial installations return an error and remain recorded so they can be removed. OpenClaw JSON5 configuration requires manual editing; it is reported as incomplete. Pi registration failures are also reported as incomplete.

## Use as a Go library

Import `github.com/agentapprovalprotocol/agentapprovalprotocol/adapters`:

```go
adapter, err := adapters.Lookup("claude-code")
if err != nil {
    return err
}
result, err := adapter.Install(instanceToken, aapBaseURL,
    adapters.WithToolGlob("create_*"))
```

`Install` has two required arguments and optional settings. `All`, `Manager.Detect`, `Adapter.Status` and `Adapter.Uninstall` provide the lifecycle operations. Installation results report completion, changed files and follow-up notes. An explicit `Environment` supports isolated tests and embedding with custom machine locations.

Installed hooks invoke the importing executable. Its `hook <adapter>` command must delegate to `adapters.RunHook`, or it can use the dispatcher in the public `cli` package. `cli.Main` handles process signals and returns an exit code; `cli.Run` accepts an existing context. All provider provisioning and UI stay with the importing application.
