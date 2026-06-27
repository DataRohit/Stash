import { execFile } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_ATTEMPTS = 60;
const INTERVAL_MS = 1000;

async function readDashboardUrl() {
  try {
    const { stdout } = await run("npx", ["convex", "dashboard", "--no-open"], {
      shell: true,
    });
    const url = stdout.trim();
    return url.startsWith("http") ? url : null;
  } catch {
    return null;
  }
}

async function main() {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const url = await readDashboardUrl();
    if (url) {
      process.stdout.write(`Convex dashboard ready at ${url}\n`);
      return;
    }
    await delay(INTERVAL_MS);
  }
  process.stdout.write("Convex dashboard not detected yet. Run `pnpm convex:dashboard`.\n");
}

await main();
