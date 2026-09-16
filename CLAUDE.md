# Agent Approval Protocol

This repository contains the provider-independent AAP specification and its Next.js website.

- `openapi.yaml` is the wire contract. Update it before changing protocol fields or operations.
- `docs/specification/` is the single source for the prose specification. Keep it plain Markdown and maintain GitHub-readable relative links.
- `website/` renders the specification and generates the API reference. Keep provider-specific behavior out of the protocol and renderer.
- Run npm commands from the repository root. Use `npm test`, `npm run check`, `make api-lint` and `npm run build` before shipping.
- Stop the development server before a production build.
- Use semantic design tokens, the existing docs components and plain prose. Do not add em dashes to user-facing copy.
- Never copy proprietary font files into this repository.
- Keep instructions in this file. `AGENTS.md` must remain a relative symlink to `CLAUDE.md`.
