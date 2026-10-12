# Governance

AAP is an open protocol. Its specification, OpenAPI contract and reference adapters are developed in public in this repository, and anyone can propose changes.

## Maintainers

The maintainers review contributions, decide what is merged, publish releases and enforce the [code of conduct](CODE_OF_CONDUCT.md). The current maintainers are:

- [@Chrisbattarbee](https://github.com/Chrisbattarbee)
- [@ecekyn](https://github.com/ecekyn)

Maintainers can invite contributors who have made sustained, high-quality contributions to become maintainers. The existing maintainers must agree on each invitation. A maintainer can step down at any time.

## Decisions

Most decisions happen in pull requests. A maintainer approves a change before it is merged, and the maintainers aim for consensus when they disagree.

Changes to the protocol need more care, because adapters and providers built by others depend on it:

1. Open an issue describing the problem before changing the [specification](docs/specification/) or the [OpenAPI contract](openapi.yaml). Editorial fixes that do not change requirements can skip this step.
2. A protocol change needs approval from a maintainer who did not write it.
3. Within version 1, changes must keep existing conforming adapters and providers working. Changes that would break them wait for a new major version of the protocol.

## Provider neutrality

AAP is independent of any approval provider. The specification must not require a particular provider, and provider-specific behavior belongs in that provider's own documentation. Any provider that implements the specification can ask to be listed in the [providers overview](docs/providers/overview.md).

## Changes to this document

Changes to this governance note need approval from all maintainers.
