---
lastModified: 2026-09-17
---

# AAP CLI

Use the `aap` CLI to connect your agents to an approval provider and manage their [adapters](overview.md).

## Install the CLI

Download the standalone `aap` binary for macOS or Linux, on amd64 or arm64:

```sh
curl -fsSL https://downloads.agentapprovalprotocol.io/install.sh | sh
```

If prompted, reopen your terminal so the `aap` command is available. Then [install an adapter](#install-an-adapter) for your agent.

### Installer options

To choose a different directory or pin a version, pass options to the installer:

```sh
curl -fsSL https://downloads.agentapprovalprotocol.io/install.sh | env AAP_INSTALL_DIR="$HOME/.local/bin" AAP_CLI_VERSION=0.1.0 sh
```

For automated setups where you manage `PATH` yourself, set `AAP_NO_MODIFY_PATH=1` to skip changes to your shell configuration.

To update the CLI, run the installer again and restart your agent. For OpenClaw, restart the Gateway. Your saved token and adapter settings are kept.

### Direct downloads

You can also download the latest release directly:

| Platform | Binary |
| --- | --- |
| macOS, Apple silicon | [aap-darwin-arm64](https://downloads.agentapprovalprotocol.io/cli/latest/aap-darwin-arm64) |
| macOS, Intel | [aap-darwin-amd64](https://downloads.agentapprovalprotocol.io/cli/latest/aap-darwin-amd64) |
| Linux, arm64 | [aap-linux-arm64](https://downloads.agentapprovalprotocol.io/cli/latest/aap-linux-arm64) |
| Linux, amd64 | [aap-linux-amd64](https://downloads.agentapprovalprotocol.io/cli/latest/aap-linux-amd64) |

Verify direct downloads against [SHA256SUMS](https://downloads.agentapprovalprotocol.io/cli/latest/SHA256SUMS), make the binary executable and name it `aap` in your chosen installation directory.

### Build from source

With Go 1.25 or later, run from the [repository](https://github.com/agentapprovalprotocol/agentapprovalprotocol) root:

```sh
mkdir -p "$HOME/.local/bin"
go build -o "$HOME/.local/bin/aap" ./cmd/aap
"$HOME/.local/bin/aap" version
```

For source builds, add `~/.local/bin` to your `PATH` if it is not already there.

## Install an adapter

Find supported agents on this machine:

```sh
aap agent discover
```

Then choose your agent and follow its adapter setup guide:

- [Claude Code](claude-code.md)
- [Codex](codex.md)
- [OpenClaw](openclaw.md)
- [Pi](pi.md)
- [Hermes Agent](hermes.md)
- [DeepSeek Harness](deepseek.md)

## Credentials and maintenance

Your token is saved on this machine, so you only need to enter it during setup. To change your token or provider URL, repeat your adapter's installation steps with the new values, then restart your agent.

Check the setup for supported agents found on this machine:

```sh
aap agent discover
```

Each result shows whether its adapter is installed, incomplete or not installed. If an adapter is incomplete, repeat its installation steps and follow the printed notes. For JSON output, use `aap agent discover --json`.

To remove an adapter, use its name. For example:

```sh
aap agent eject claude-code
```

Enter `y` or `yes` to confirm removal. For scripts, add `--yes` to skip the prompt:

```sh
aap agent eject claude-code --yes
```

Removing an adapter also removes its saved token from this machine. Revoke the token with your provider too if you no longer need it.

## Use as a Go library

The CLI is built as a Go library. For custom setups, import the adapters package to build your own installer:

```go
import "github.com/agentapprovalprotocol/agentapprovalprotocol/adapters"

func installAdapter(instanceToken, aapBaseURL string) (adapters.InstallResult, error) {
    adapter, err := adapters.Lookup("claude-code")
    if err != nil {
        return adapters.InstallResult{}, err
    }
    return adapter.Install(instanceToken, aapBaseURL)
}
```
