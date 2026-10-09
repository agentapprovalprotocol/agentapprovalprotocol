# Security policy

AAP decides whether an agent's tool call may run, so a flaw in it can let an unapproved action through. Please report suspected vulnerabilities privately rather than in a public issue or pull request.

## Report a vulnerability

[Open a private security advisory](https://github.com/agentapprovalprotocol/agentapprovalprotocol/security/advisories/new) on GitHub. Only the maintainers can see it.

Include as much of the following as you can:

- The affected component and version, such as `aap version` output or a specification section.
- The runtime and operating system, if an adapter is involved.
- Steps to reproduce, or a proof of concept.
- What an attacker could achieve, such as running a tool call without approval.

We will confirm that we received your report, keep you updated while we investigate and credit you in the advisory unless you prefer otherwise. Please give us a reasonable chance to release a fix before you disclose the issue publicly.

## Scope

In scope:

- The [specification](docs/specification/) and [OpenAPI contract](openapi.yaml), including requirements that would let a conforming adapter or provider accept an unapproved call.
- The Go adapter library, the `aap` CLI and the native runtime plugins in this repository.
- The installer and published release artifacts at `downloads.agentapprovalprotocol.io`.
- The documentation website.

Out of scope:

- Approval providers. Report those to the provider directly.
- Agent runtimes such as Claude Code or Codex, unless the issue is in how AAP integrates with them.
- Tool calls that never pass through an adapter. An adapter only controls the calls routed through it, as described in [adapter coverage and limits](https://agentapprovalprotocol.io/docs/concepts/adapter#where-the-adapter-runs).

## Supported versions

Security fixes are released in the latest version of the `aap` CLI. Rerun the [installer](deployment/cli/README.md) to update.
