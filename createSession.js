/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * @deprecated Use `npm run create-session` (runs scripts/createSession.ts with shared Playwright options).
 */
const { spawnSync } = require("child_process");
const path = require("path");

const r = spawnSync(
  process.execPath,
  [path.join(__dirname, "node_modules", "tsx", "dist", "cli.mjs"), path.join(__dirname, "scripts", "createSession.ts")],
  { stdio: "inherit", cwd: __dirname, shell: false }
);
if (r.error) {
  console.error("Could not run tsx. Try: npm run create-session");
  console.error(r.error);
  process.exit(1);
}
process.exit(r.status ?? 1);
