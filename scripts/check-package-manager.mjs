// Keep installation independent of the user's shell and installed dependencies.
if (!process.env.npm_config_user_agent?.startsWith("pnpm/")) {
  console.error("Use pnpm to install this workspace (see packageManager in package.json).");
  process.exit(1);
}
