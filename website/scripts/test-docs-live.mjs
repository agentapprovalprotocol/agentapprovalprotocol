import { spawnSync } from "node:child_process";

// Fail instead of reporting skipped tests when the target was not configured.
const target = process.env.AAP_TEST_BASE_URL;
if (!target) throw new Error("Set AAP_TEST_BASE_URL to the public docs origin.");
const url = new URL(target);
if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
  throw new Error("The docs test target must be an HTTP(S) URL without credentials.");
}
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "tests/markdown-http.test.ts"], {
  stdio: "inherit",
  timeout: 5 * 60_000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
