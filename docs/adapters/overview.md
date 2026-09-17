---
lastModified: 2026-09-17
---

# Adapters overview

An [adapter](../concepts/adapter.md) connects an agent runtime to an approval provider. It captures a proposed tool call, asks whether it may run and translates the outcome back into the runtime's own hook, extension or tool response.

The adapters below are open-source AAP adapters maintained by AAP itself. These guides describe their current implementations in withHuman and use withHuman as the example provider. Installation currently uses the withHuman CLI or gateway; standalone adapter packages are still to come.

## Choose an adapter

| Adapter | Integration | Coverage |
| --- | --- | --- |
| [Claude Code](claude-code.md) | `PreToolUse` command hook | Built-in tools and MCP tool calls. |
| [Codex](codex.md) | Command hooks | Built-in tools and MCP tool calls; guided setup installs `PreToolUse`. |
| [OpenClaw](openclaw.md) | Native Gateway plugin | Calls passing through `before_tool_call`, including MCP tools. |
| [Pi](pi.md) | Native extension | Model-proposed calls passing through `tool_call`. |
| [Hermes Agent](hermes.md) | `pre_tool_call` shell hook | Built-in tools and MCP tool calls. |
| [DeepSeek Harness](deepseek.md) | Claude Code hooks bridge | Calls passing through the selected profile's tool execution hooks. |
| [MCP wrapper](mcp-wrapper.md) | Local stdio proxy | Tool calls to one wrapped stdio or remote HTTP MCP server. |
| [MCP gateway](mcp-gateway.md) | Remote HTTP MCP server | Tool calls to registered downstream MCP servers. |

The current integrations use [synchronous approval](../specification/6_sync.md): the intercepted call stays open whilst the adapter polls. An asynchronous JavaScript callback or background goroutine still follows this mode. None of these guides sets up AAP's durable webhook-based suspension and resumption.

Runtime hooks cover calls that pass through the runtime. The wrapper covers its MCP connection. The gateway can also hold downstream credentials, so access to a protected service can be controlled away from the agent's machine. See [enforcement limits](../specification/8_security.md#enforcement-limits) when choosing where to place approval.

## Install the CLI

For the six runtime adapters and the MCP wrapper, install the `withhuman` CLI on the machine that runs the agent. The standard distribution provides macOS and Linux binaries for Intel/AMD and Arm machines:

```sh
curl -fsSL https://downloads.withhuman.ai/install.sh | sh
withhuman version
```

Use the installation command shown by your withHuman deployment if it supplies its own download location. The agent CLI and the withHuman server are separate binaries that can both be named `withhuman`; these examples use the CLI.

## Set up with withHuman

The runtime guides use the same guided setup, followed by steps specific to each runtime.

1. Sign in to your withHuman deployment with permission to connect agents, configure their approval pipelines and review the test request. Open `/welcome`, or follow the guided setup link from **Connect an agent**.
2. Copy the setup command and run it from the project where you use the agent. This lets discovery see project-specific MCP configuration where supported.
3. In **Choose agents**, select the runtime. In **Choose tools**, select the calls that should wait for a person. Setup creates the credentials, approval pipeline and local integration.
4. Complete any manual steps printed by the CLI, then restart the runtime as directed by its guide.
5. Run a harmless test call and approve it in withHuman. The guided flow also lets you configure notifications and test delivery to your reviewer.

The setup command has this shape. Replace the example origin and `SETUP_CODE` with the values from your own page:

```sh
withhuman setup --url "https://withhuman.example.com" --code "SETUP_CODE"
```

Keep the CLI running whilst making the browser selections. A setup code is single use and expires after ten minutes; start a fresh setup if it has expired.

The CLI hooks and wrapper submit each intercepted tool call. withHuman's approval pipeline can approve routine calls immediately and hold selected calls for review. The gateway additionally classifies calls against its configured gates before requesting approval.

## Credentials and maintenance

Setup saves a separate instance credential for each selected runtime. The files live under `credentials/<runtime>.json` in the operating system's user configuration directory for `withhuman`. `WITHHUMAN_CONFIG_DIR` can override that directory. Installed hooks name their credential explicitly with `--agent`.

Use `withhuman status --agent <runtime>` to inspect an installation. `withhuman eject --agent <runtime>` removes the recorded local integration and, by default, its local credential file. Credential revocation on the provider is a separate action. The individual guides include commands with the correct runtime key.

`withhuman init --agent <name> --url <origin>` enrolls an instance and stores its credential. It does not install a runtime hook. The [MCP wrapper](mcp-wrapper.md) uses this enrollment path because it is configured directly in an MCP client.

## Current implementation limits

These implementations are prototypes being extracted from withHuman. Their shared clients use withHuman's `/api/aap/v1` endpoints and provider-specific enrollment and configuration. The standalone release will need to separate those provider details from the adapter's AAP exchange.

The current clients do not yet enforce the specification's `decision.expires_at` check or track approval consumption to prevent every execution replay. Some integrations also rely on the runtime to keep approved arguments unchanged. Their pages describe the implemented behavior and specific limitations; the [adapter requirements](../specification/8_security.md#adapter-requirements) define the requirements for AAP conformance.
