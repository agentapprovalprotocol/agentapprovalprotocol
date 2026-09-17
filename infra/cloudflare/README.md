# Documentation delivery at Cloudflare

`docs-delivery.json` records the rules applied to the production zone on
2026-09-17. It contains configuration only, with no credentials. The stable
`ref` values identify the rules owned by documentation delivery.

The cache rule bypasses Cloudflare caching for this host's documentation and
specification routes. The response rule adds the complete `Vary` dimensions
for HTML, Markdown and Next.js navigation while preserving existing values,
including compression headers. Duplicate `Vary` field names are harmless.
Other paths and subdomains are outside these rules.

The Next.js patch preserves headers in `next start`, but the production hosting
path can replace them when serving prerendered files. The Cloudflare rule
restores the final response headers. Response transforms run after Cloudflare
makes its cache decision, which is why the separate cache bypass is required.
Keep Markdown for Agents disabled; the application already serves authored
Markdown and handles media-type negotiation.

## Check configuration

Install the Cloudflare `cf` CLI and authenticate with Zone Read, Transform Rules
Edit and Cache Rules Edit permissions scoped to this zone. API tokens can be
provided through `CLOUDFLARE_API_TOKEN`; keep credentials outside the repository.
From the repository root, run:

```sh
node infra/cloudflare/check-docs.mjs
```

This command only reads configuration. It checks the owned rules and permits
unrelated rules in each phase. It does not require storing a Cloudflare token
in GitHub Actions.

## Change or restore rules

Read and back up each phase with `cf rulesets account-rulesets phases get` before
making changes. Update a rule with a matching `ref`, or append a missing rule
with `cf rulesets account-rulesets rules create`. Create a zone ruleset only
when that phase has no entrypoint. Preserve unrelated rules; replacing a whole
phase with this file would discard them. Apply the cache bypass before the
header rule. To roll back, restore only the changed owned rules from the backup.

Verify both configuration and public HTTP behavior after changes. A successful
Vercel production deployment triggers `.github/workflows/docs-production.yml`,
which tests the public domain through Cloudflare using the deployed commit.
The workflow can also be run manually. It retries briefly for propagation and
checks all published pages, representation switching, navigation, errors and
Markdown alternates. A local build alone cannot verify this hosting path.

References: [response transforms](https://developers.cloudflare.com/rules/transform/response-header-modification/)
and [Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/).
