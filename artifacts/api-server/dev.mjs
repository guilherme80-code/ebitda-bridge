import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "development";

// Use the same Node executable on Windows and Unix, without a shell.
const build = spawnSync(process.execPath, [fileURLToPath(new URL("./build.mjs", import.meta.url))], {
  cwd: fileURLToPath(new URL(".", import.meta.url)),
  stdio: "inherit",
  env: process.env,
});

if (build.error) {
  console.error(build.error);
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

await import("./dist/index.mjs");
