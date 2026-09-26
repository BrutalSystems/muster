#!/usr/bin/env node
// The tarball check, in one place, so the local gate and CI cannot disagree
// about what "verified" means. `npm test` alone does not catch tarball drift:
// the suite imports source, and nothing it runs packs anything. CI gates on
// this in a separate job, so without it a change can be green locally and red
// on push.
//
// Not used by publish.yml, which packs the tarball it is about to publish into
// a staging directory and verifies that exact file. This one packs to a temp
// directory and throws the result away.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const staging = mkdtempSync(join(tmpdir(), "muster-pack-"));
try {
  const raw = join(staging, "pack-raw.json");
  const normalized = join(staging, "pack.json");
  writeFileSync(
    raw,
    execFileSync(
      "npm",
      ["pack", "--pack-destination", staging, "--json"],
      // npm writes its notices to stderr; only stdout is the JSON.
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  const run = (script, args) =>
    execFileSync("node", [join("scripts", script), ...args], {
      stdio: "inherit",
    });
  run("normalize-pack-json.mjs", [raw, normalized]);
  run("verify-tarball.mjs", [normalized]);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
