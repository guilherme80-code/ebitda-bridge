import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.npm_execpath || !process.env.npm_config_user_agent?.startsWith("pnpm/")) {
  console.error("Run these checks with pnpm test.");
  process.exit(1);
}

// Unit tests import the DB module, but must never use developer credentials
// or opt into the destructive seed integration suite. Do not load .env here.
const result = spawnSync(process.execPath, [
  process.env.npm_execpath, "-r", "--if-present", "run", "test",
], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
    RUN_DB_INT_TESTS: "0",
    DATABASE_URL: "postgresql://127.0.0.1:1/ebitda_unit_tests",
  },
});

if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
