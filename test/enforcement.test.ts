import { expect, test } from "vitest";
import { LEVELS } from "../src/guard.js";
import { enforcementGrade } from "../src/enforcement.js";
import type { Runtime } from "../src/types.js";

const sandboxed: Runtime[] = ["codex", "claude"];

test("an OS-sandboxed runtime is kernel-enforced at read and work", () => {
  for (const runtime of sandboxed)
    for (const level of ["read", "work"] as const)
      expect(enforcementGrade(runtime, LEVELS[level])).toBe("kernel");
});

test("OpenCode is tool policy wherever a sandbox is claimed", () => {
  for (const level of ["read", "work"] as const)
    expect(enforcementGrade("opencode", LEVELS[level])).toBe("tool-policy");
});

test("open disables the sandbox, so no runtime is enforced there", () => {
  for (const runtime of [...sandboxed, "opencode"] as Runtime[])
    expect(enforcementGrade(runtime, LEVELS.open)).toBe("none");
});

test("the grade follows the sandbox, not the level's name", () => {
  expect(
    enforcementGrade("claude", {
      permissions: "deny",
      sandbox: "full-access",
    }),
  ).toBe("none");
  expect(
    enforcementGrade("claude", {
      permissions: "deny",
      sandbox: "workspace-write",
    }),
  ).toBe("kernel");
});
