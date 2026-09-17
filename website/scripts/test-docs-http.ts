import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

async function main() {
  // Verify the built application, including Next.js's final response headers.
  // A temporary port and finally block keep local and CI runs self-contained.
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No test port available");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const server = spawn(process.execPath, [createRequire(import.meta.url).resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(address.port)], { stdio: "inherit" });
  const stopped = once(server, "exit");
  const url = `http://127.0.0.1:${address.port}`;

  try {
    let ready = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && server.exitCode === null) {
      try {
        ready = (await fetch(`${url}/llms.txt`, { signal: AbortSignal.timeout(1000) })).ok;
        if (ready) break;
      } catch { /* The server has not started listening yet. */ }
      await delay(100);
    }
    if (!ready) throw new Error("Production docs server did not become ready");
    const tests = spawn(process.execPath, ["--import", "tsx", "--test", "tests/markdown-http.test.ts"], {
      stdio: "inherit",
      env: { ...process.env, AAP_TEST_BASE_URL: url },
    });
    const [code] = await once(tests, "exit");
    if (code !== 0) throw new Error(`Docs HTTP checks failed (${code})`);
  } finally {
    server.kill("SIGTERM");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
    await stopped;
    clearTimeout(timeout);
  }

}

main().catch((error) => { console.error(error); process.exitCode = 1; });
