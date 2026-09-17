---
lastModified: 2026-09-17
---

# Adapters overview

An [adapter](../concepts/adapter.md) captures a proposed tool call, asks an approval provider whether it may run and translates the outcome back into the runtime's hook or extension response.

This repository maintains a provider-independent Go library and an `aap` CLI for six runtimes. Each adapter installs itself using an existing instance token and the provider's complete AAP base URL. Creating the instance and obtaining its token are the provisioner's responsibility.

## Choose an adapter

| Adapter | Supported modes | Integration | Coverage |
| --- | --- | --- | --- |
| [Claude Code](claude-code.md) | Synchronous | `PreToolUse` command hook | Built-in tools and MCP tool calls. |
| [Codex](codex.md) | Synchronous | `PreToolUse` command hook | Built-in tools and MCP calls in builds supporting command hooks. |
| [OpenClaw](openclaw.md) | Synchronous | Native Gateway plugin | Calls passing through `before_tool_call`, including MCP tools. |
| [Pi](pi.md) | Synchronous | Native extension | Model-proposed calls passing through `tool_call`. |
| [Hermes Agent](hermes.md) | Synchronous | `pre_tool_call` shell hook | Built-in tools and MCP tool calls. |
| [DeepSeek Harness](deepseek.md) | Synchronous | Claude Code hooks bridge | Calls passing through the configured profile's bridge. |
| [MCP wrapper](mcp-wrapper.md) | Planned | Local MCP proxy | Not included in the current release. |
| [MCP gateway](mcp-gateway.md) | Synchronous | Remote HTTP MCP server | Tool calls to registered downstream MCP servers. |

The [MCP wrapper](mcp-wrapper.md) is deferred. The [MCP gateway](mcp-gateway.md) is a separate provider deployment. Neither is installed by `aap`.

The current integrations use [synchronous approval](../specification/6_sync.md): the intercepted call stays open whilst the adapter polls. An asynchronous JavaScript callback or background goroutine still follows this mode. AAP's [asynchronous mode](../specification/7_async.md), which durably suspends execution and resumes after a webhook notification, is not currently supported by these adapters.

Runtime hooks cover calls that pass through the runtime. The wrapper covers its MCP connection. The gateway can also hold downstream credentials, so access to a protected service can be controlled away from the agent's machine. See [enforcement limits](../specification/8_security.md#enforcement-limits) when choosing where to place approval.

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

With Go 1.25 or later, run from the repository root:

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

## Approval enforcement and limits

All six integrations use [synchronous approval](../specification/6_sync.md). The client validates responses against the submitted call, enforces approval expiry and records approval consumption on disk before returning permission. Duplicate retrieval cannot grant the same approval twice, including concurrent hook processes. Storage failures block execution. A crash after consumption can lose permission to execute; it cannot make the approval reusable. Consumption records remain in the configuration directory across uninstall and credential replacement.

Retries retain the same idempotency key for an execution attempt. If a runtime supplies no stable call ID, a new invocation asks for a fresh approval. On interruption or a local deadline, the adapter attempts to cancel a known pending request. A cancellation race cannot revive an abandoned call.

Hooks cover only execution paths that reach them. Runtime consent, hook order, later middleware and local configuration can affect enforcement. Pi and OpenClaw snapshot arguments; Hermes returns the reviewed arguments and must remain the last hook. The individual guides describe remaining harness limitations. See the [adapter requirements](../specification/8_security.md#adapter-requirements) for the full contract.
