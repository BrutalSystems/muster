// Verifies an `npm pack --json` file list two ways:
//   1. allowlist — every packed path must fall under package.json `files`
//      (catches npm's forced inclusions, e.g. an unexpected bin/main target)
//   2. denylist — nothing packed may come from a source/test/build tree,
//      because an allowlist alone can't catch `files` itself being widened
//      (e.g. to "src") — the widened entry passes its own check by
//      definition. Only an independent denylist notices that mistake.
// EXCEPTIONS lists paths deliberately shipped out of an otherwise-denied
// tree, so the exception is visible in review instead of hidden in a glob.
import { readFileSync } from "node:fs";

const packJsonPath = process.argv[2];
if (!packJsonPath) {
  console.error("usage: verify-tarball.mjs <npm-pack-output.json>");
  process.exit(1);
}

const EXCEPTIONS = new Set(["test/fixtures/canonical-id.json"]);

const DENYLIST = [
  /^src\//,
  /^tests?\//,
  /^node_modules\//,
  /^\.github\//,
  /(^|\/)\.[^/]+$/, // any dotfile
  /\.tsbuildinfo$/,
];

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const allowed = new Set([...pkg.files, "package.json"]);

const packResult = JSON.parse(readFileSync(packJsonPath, "utf8"));
const actualFiles = packResult[0].files.map((f) => f.path);

const notAllowed = actualFiles.filter(
  (path) => ![...allowed].some((entry) => path === entry || path.startsWith(`${entry}/`)),
);

const denied = actualFiles.filter(
  (path) => !EXCEPTIONS.has(path) && DENYLIST.some((pattern) => pattern.test(path)),
);

const failures = [...new Set([...notAllowed, ...denied])];

if (failures.length > 0) {
  console.error("Tarball verification failed:");
  for (const path of notAllowed) console.error(`  ${path} — not under package.json \`files\``);
  for (const path of denied) console.error(`  ${path} — source tree, must never ship`);
  process.exit(1);
}

console.log(`Tarball verified: ${actualFiles.length} files, all allowed and none denied.`);
