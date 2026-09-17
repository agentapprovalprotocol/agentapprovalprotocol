# Agent Approval Protocol

This repository contains the provider-independent AAP specification, Go adapter library and CLI, and Next.js website.

- `openapi.yaml` is the wire contract. Update it before changing protocol fields or operations.
- `docs/specification/` is the single source for the prose specification. Keep it plain Markdown and maintain GitHub-readable relative links.
- `website/` renders the specification and generates the API reference. Keep provider-specific behavior out of the protocol and renderer.
- Every published page needs a `lastModified` date in `YYYY-MM-DD` format. Store it in Markdown YAML frontmatter, or in `website/api-page-metadata.json` for generated API pages. Only change the date when the page's content meaningfully changes, such as changes to explanations, examples, requirements or API behavior. Small typo fixes, punctuation, formatting, styling, refactoring and rebuilds do not warrant a new date. Update only affected pages, including generated pages whose content changes through shared schemas or other OpenAPI dependencies. Never automatically advance dates during builds.
- Run npm commands from the repository root. Use `npm test`, `npm run check`, `make api-lint` and `npm run build` before shipping.
- Adapter code targets Go 1.25 or later on macOS and Linux. Run `make adapters-test` and `make adapters-build` after Go or native plugin changes. Keep the library independent of provider enrollment and product code.
- Stop the development server before a production build.
- Use semantic design tokens, the existing docs components and plain prose. Do not add em dashes to user-facing copy.
- Never copy proprietary font files into this repository.
- Keep instructions in this file. `AGENTS.md` must remain a relative symlink to `CLAUDE.md`.
