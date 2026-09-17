import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

// Read-only drift check. Credentials are supplied to cf by its normal auth flow.
const config = JSON.parse(fs.readFileSync(new URL("./docs-delivery.json", import.meta.url), "utf8"));
for (const [phase, rules] of Object.entries(config.phases)) {
  const result = spawnSync("cf", ["rulesets", "account-rulesets", "phases", "get", phase, "--zone", config.zoneId], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cannot read ${phase}: ${result.stderr}`);
  const live = JSON.parse(result.stdout);
  for (const expected of rules) {
    const matches = (live.rules ?? []).filter((rule) => rule.ref === expected.ref);
    assert.equal(matches.length, 1, `${phase}: expected one ${expected.ref} rule`);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(matches[0][key], value, `${phase}: ${expected.ref}.${key} has drifted`);
    }
  }
  console.log(`${config.host}: ${phase} matches ${rules.length} documented rule(s).`);
}
