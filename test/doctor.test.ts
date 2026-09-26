import { test, expect } from "vitest";
import { mkdtemp, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/config.js";
import { checkPlugins } from "../src/doctor.js";
import { formatHuman } from "../src/format.js";

const PUBLISHED_AT = "2026-09-21T19:47:37.049Z";

/** A plugin file on disk whose mtime we control, since mtime is the signal. */
async function pluginFile(mtime: string) {
  const dir = await mkdtemp(join(tmpdir(), "doctor-"));
  const file = join(dir, "tincan.ts");
  await writeFile(file, "export const TinCan = async () => ({});\n");
  await utimes(file, new Date(mtime), new Date(mtime));
  return file;
}

const registry = (result: unknown) => async () => {
  if (result instanceof Error) throw result;
  return result as never;
};

test("a copy older than the latest release is stale", async () => {
  const path = await pluginFile("2026-09-20T17:15:20.000Z");
  const report = await checkPlugins(
    configSchema.parse({ plugins: { tincan: { path } } }),
    registry({ version: "0.7.2", published: PUBLISHED_AT }),
  );
  expect(report.plugins).toHaveLength(1);
  expect(report.plugins[0]).toMatchObject({
    name: "tincan",
    package: "@brutalsystems/tincan-opencode",
    status: "stale",
    published_version: "0.7.2",
  });
  expect(report.stale).toBe(1);
});

test("a copy newer than the latest release is current", async () => {
  const path = await pluginFile("2026-09-22T09:00:00.000Z");
  const report = await checkPlugins(
    configSchema.parse({ plugins: { tincan: { path } } }),
    registry({ version: "0.7.2", published: PUBLISHED_AT }),
  );
  expect(report.plugins[0]!.status).toBe("current");
  expect(report.stale).toBe(0);
});

test("an npm-configured plugin has no local copy and is skipped", async () => {
  const report = await checkPlugins(
    configSchema.parse({
      plugins: { tincan: { npm: "@brutalsystems/tincan-opencode" } },
    }),
    registry({ version: "0.7.2", published: PUBLISHED_AT }),
  );
  expect(report.plugins).toEqual([]);
});

test("a path plugin muster cannot map to a package is unchecked", async () => {
  const path = await pluginFile("2020-01-01T00:00:00.000Z");
  const report = await checkPlugins(
    configSchema.parse({ plugins: { somethingelse: { path } } }),
    registry({ version: "9.9.9", published: PUBLISHED_AT }),
  );
  expect(report.plugins[0]).toMatchObject({
    status: "unchecked",
    package: null,
  });
  expect(report.stale).toBe(0);
});

test("the published key maps a plugin muster does not know", async () => {
  const path = await pluginFile("2020-01-01T00:00:00.000Z");
  const report = await checkPlugins(
    configSchema.parse({
      plugins: { mine: { path, published: "@acme/mine-opencode" } },
    }),
    registry({ version: "1.0.0", published: PUBLISHED_AT }),
  );
  expect(report.plugins[0]).toMatchObject({
    package: "@acme/mine-opencode",
    status: "stale",
  });
});

test("the published key overrides the built-in map", async () => {
  const path = await pluginFile("2020-01-01T00:00:00.000Z");
  const report = await checkPlugins(
    configSchema.parse({
      plugins: { tincan: { path, published: "@fork/tincan-opencode" } },
    }),
    registry({ version: "1.0.0", published: PUBLISHED_AT }),
  );
  expect(report.plugins[0]!.package).toBe("@fork/tincan-opencode");
});

test("a package that is not published is reported, not treated as stale", async () => {
  const path = await pluginFile("2020-01-01T00:00:00.000Z");
  const report = await checkPlugins(
    configSchema.parse({ plugins: { tincan: { path } } }),
    registry(null),
  );
  expect(report.plugins[0]!.status).toBe("unpublished");
  expect(report.stale).toBe(0);
});

test("an unreachable registry is reported, not treated as stale", async () => {
  const path = await pluginFile("2020-01-01T00:00:00.000Z");
  const report = await checkPlugins(
    configSchema.parse({ plugins: { tincan: { path } } }),
    registry(new Error("getaddrinfo ENOTFOUND registry.npmjs.org")),
  );
  expect(report.plugins[0]!.status).toBe("unreachable");
  expect(report.stale).toBe(0);
});

test("a missing plugin file is reported rather than throwing", async () => {
  const report = await checkPlugins(
    configSchema.parse({ plugins: { tincan: { path: "/nope/tincan.ts" } } }),
    registry({ version: "0.7.2", published: PUBLISHED_AT }),
  );
  expect(report.plugins[0]!.status).toBe("missing");
  expect(report.stale).toBe(0);
});

test("the human report names the package and what to do about it", async () => {
  const path = await pluginFile("2026-09-20T17:15:20.000Z");
  const report = await checkPlugins(
    configSchema.parse({ plugins: { tincan: { path } } }),
    registry({ version: "0.7.2", published: PUBLISHED_AT }),
  );
  const out = formatHuman(report);
  expect(out).toContain("tincan");
  expect(out).toContain("@brutalsystems/tincan-opencode");
  expect(out).toContain("stale");
  expect(out).toContain("0.7.2");
  // A report that does not say how to clear it is just another thing to ignore.
  expect(out).toMatch(/npm =|reinstall|update/i);
});

test("the human report is explicit when nothing is stale", async () => {
  const path = await pluginFile("2026-09-22T09:00:00.000Z");
  const report = await checkPlugins(
    configSchema.parse({ plugins: { tincan: { path } } }),
    registry({ version: "0.7.2", published: PUBLISHED_AT }),
  );
  expect(formatHuman(report)).toMatch(/no stale plugins/i);
});
