---
lastModified: 2026-09-17
---

# Pi

The Pi adapter uses a native extension registered on `tool_call` to request approval before a tool call executes. It connects to any provider implementing the current AAP contract.

## Install

Build and place the [AAP CLI](overview.md#install-the-cli) at a stable location. Obtain an instance token and complete AAP base URL from your provider, then run:

```sh
aap install pi --instance-token "$INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
aap status pi
```

Installation configures AAP's `plugins/pi` directory, registered with `pi install`. Start a fresh Pi session after installation. `pi` must be available on `PATH` for registration and removal.

Every intercepted tool is covered by default. Add `--tool-glob 'create_*'` to limit coverage to matching normalized AAP tool names. See [filter behavior](overview.md#optional-tool-filter) before narrowing coverage.

## How it works

The extension snapshots tool arguments and calls the installing executable. After provider approval it verifies that the original arguments have not changed and freezes their contents. The AAP configuration root and executable path live in the extension's `aap.json`; the token stays in the separate restricted credential file.

The shared client handles immediate decisions and polling, validates approval expiry and records consumption before returning permission. Denial, expiry, cancellation and invalid provider exchanges keep covered calls blocked. Nonmatching calls continue through the runtime's ordinary permissions without an AAP request.

## Verify and remove

Make a harmless tool call in a fresh runtime session. Confirm that it appears at your provider, approve it and verify execution. Repeat with a denial and confirm that the call stays blocked. Local status reports registration, not end-to-end connectivity.

```sh
aap uninstall pi
```

Uninstall removes recorded local integration and credentials while preserving unrelated user changes. Revoke the token separately at the provider if needed.

## Limits and troubleshooting

The default wait is one hour, with timeout margins. A failed registration returns an incomplete installation. Missing call or session identifiers, missing adapter processes and malformed decisions block calls. Calls outside the glob continue normally. Later handlers must not replace the entire argument object; freezing protects mutations of the reviewed object, not every possible harness rewrite.

The [shared enforcement limits](overview.md#approval-enforcement-and-limits) and [adapter requirements](../specification/8_security.md#adapter-requirements) also apply.
