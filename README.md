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

With that production server running, use `AAP_TEST_BASE_URL=http://127.0.0.1:3018 npm test` to also run the Markdown content negotiation HTTP checks.

The install step applies `patches/next+16.3.5.patch` to preserve custom `Vary` fields in HTML responses. This works around [Next.js issue #85999](https://github.com/vercel/next.js/issues/85999). When upgrading Next.js, rerun the production HTTP checks and remove the patch once the framework preserves these fields itself.

## Documentation

Documentation at `/docs` introduces AAP and explains how to build with it. Specification at `/specification` contains the protocol requirements and generated API reference. Each area has its own sidebar and page sequence. The previous `/docs/specification/*` and `/docs/reference/*` URLs redirect to their new locations.

Edit the Markdown files in `docs/` and keep relative links usable on GitHub. Keep normative requirements in `docs/specification/` and practical guides in the other documentation directories. The site resolves source links to the correct area. Fenced Mermaid diagrams render on the website and remain readable in the source.

Update `openapi.yaml` first when changing the wire contract. The website generates instance, request, webhook and schema reference pages from that file, including authentication, examples, response headers and conditional fields. The complete source is rendered at `/specification/reference/openapi`, with a YAML download served at `/openapi.yaml`.

Site identity lives in `website/site.config.ts`. Page metadata and source-file mappings live in `website/lib/doc-pages.ts`, and `website/lib/docs.ts` assembles the navigation and content. Each page has a Markdown endpoint, and `/llms.txt` lists them.

Agents can request the same Markdown directly from documentation, specification and API reference page URLs using `Accept: text/markdown`:

```sh
curl -H 'Accept: text/markdown' https://agentapprovalprotocol.io/specification/overview
```

For `GET` and `HEAD`, the site serves the existing `/index.md` representation with `Content-Type: text/markdown; charset=utf-8` without redirecting the request. Negotiation follows the [Accept Markdown guidance](https://acceptmarkdown.com/guides/accept-parsing): the most specific matching media range determines each format's quality, and the format with the higher quality wins. Explicit Markdown wins equal-weight ties with HTML, as this site's chosen default. Missing `Accept` and unrestricted wildcards default to HTML; a wildcard can select Markdown if HTML is rejected or less preferred. UTF-8 media parameters are supported.

When neither format is acceptable, the site returns `406 Not Acceptable`, lists the available formats and sets `Cache-Control: no-store`. An empty `Accept` list, unsupported types such as `application/pdf`, or rejection of both formats produce `406`. A lone `text/markdown;q=0` also produces `406` because it accepts no other representation; add `text/html` or `*/*` to allow HTML. This follows the guide's negotiation algorithm and [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.1).

Responses include `Vary: Accept` alongside other variation headers so caches distinguish the formats. HTML pages advertise their Markdown alternate with `<link rel="alternate" type="text/markdown">`. Direct `/index.md` URLs remain available regardless of the `Accept` header. Negotiation applies to published document URLs; missing pages retain their `404`, and Next.js navigation requests keep their framework response format.

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
