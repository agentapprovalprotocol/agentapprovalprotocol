# Agent Approval Protocol

AAP is an open protocol for approving agent tool calls. An adapter intercepts a call, asks an approval provider whether it may run, and enforces the decision before execution.

This repository owns the version 1 specification, its OpenAPI contract and the Next.js documentation website.

- [Read the documentation](docs/getting-started/introduction.md)
- [Read the specification](docs/specification/1_overview.md)
- [Specification contents](docs/specification/0_structure.md)
- [OpenAPI contract](openapi.yaml)
- [Website](https://agentapprovalprotocol.io)

## Repository layout

- `docs/getting-started/` and `docs/concepts/`: introductory documentation and core concepts.
- `docs/specification/`: the canonical Markdown specification.
- `openapi.yaml`: the canonical objects, types and HTTP operations.
- `website/`: the Next.js documentation site. It reads the specification and schema directly, without maintaining a second copy.

## Development

Use Node.js 24 LTS and npm. Run commands from the repository root:

```sh
npm ci
npm run dev
```

The development server runs at <http://127.0.0.1:3018>.

```sh
npm test
npm run check
make api-lint
npm run build
```

Stop the development server before making a production build. Run `npm start` to inspect the production build locally.

## Documentation

Documentation at `/docs` introduces AAP and explains how to build with it. Specification at `/specification` contains the protocol requirements and generated API reference. Each area has its own sidebar and page sequence. The previous `/docs/specification/*` and `/docs/reference/*` URLs redirect to their new locations.

Edit the Markdown files in `docs/` and keep relative links usable on GitHub. Keep normative requirements in `docs/specification/` and practical guides in the other documentation directories. The site resolves source links to the correct area. Fenced Mermaid diagrams render on the website and remain readable in the source.

Update `openapi.yaml` first when changing the wire contract. The website generates instance, request, webhook and schema reference pages from that file, including authentication, examples, response headers and conditional fields. The complete source is rendered at `/specification/reference/openapi`, with a YAML download served at `/openapi.yaml`.

Site identity lives in `website/site.config.ts`. Navigation and source-file mappings live in `website/lib/docs.ts`. Each page has a Markdown endpoint, and `/llms.txt` lists them.

## Deployment

Create a Vercel project connected to `agentapprovalprotocol/agentapprovalprotocol`:

1. Select the Next.js framework and set the Root Directory to `website`.
2. Enable inclusion of source files outside the Root Directory. The build needs the repository's `docs/` and `openapi.yaml`.
3. Use Node.js 24 and install dependencies with npm using the root workspace lockfile.
4. Use `main` as the production branch and enable branch previews.
5. Add `agentapprovalprotocol.io` as the production domain and apply the DNS records Vercel provides.

No provider credentials or environment variables are required to build the documentation. Hosting setup is managed separately from this repository.

## Origin

The specification was extracted from the `aap/` directory in [withHuman](https://github.com/withHumanAI/withHuman), merged in PR #385 at commit `bee0e8d72a767379063342cfccdeaf88aa1e9f4b`.
The website reuses and adapts withHuman's documentation components. Inter and Roboto Mono retain their included OFL license notices. Proprietary fonts and withHuman product assets are not included.
