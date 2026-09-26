import { stat } from "node:fs/promises";
import type { Config } from "./config.js";
import { pluginPath, publishedPackage } from "./plugins.js";

/**
 * A path-configured plugin is a copied file: the package it came from keeps
 * moving and the copy does not, and nothing at launch can tell the difference.
 * The copy carries no version — the real ones are a bare `.ts` with no
 * package.json — so staleness is read from the file's mtime against the
 * registry's publish time for the current release. That under-reports (a
 * re-copied old file looks current) and never over-reports, which is the safe
 * direction for a warning.
 */
export type PluginStatus =
  "stale" | "current" | "unpublished" | "unchecked" | "unreachable" | "missing";

export type PluginHealth = {
  name: string;
  path: string;
  package: string | null;
  status: PluginStatus;
  local_mtime?: string;
  published_version?: string;
  published_at?: string;
};

export type DoctorReport = {
  kind: "doctor";
  plugins: PluginHealth[];
  stale: number;
};

/** Resolves a package to its current release, or null when unpublished. */
export type RegistryLookup = (
  pkg: string,
) => Promise<{ version: string; published: string } | null>;

export async function checkPlugins(
  config: Config,
  lookup: RegistryLookup,
): Promise<DoctorReport> {
  const plugins: PluginHealth[] = [];
  for (const [name, definition] of Object.entries(config.plugins)) {
    // An npm-configured plugin has no copy of its own to go stale; OpenCode's
    // package cache is the thing that pins it, and clearing that is a
    // different remedy. README covers it.
    if ("npm" in definition) continue;
    const path = pluginPath(definition.path);
    const health: PluginHealth = {
      name,
      path,
      package: publishedPackage(name, definition),
      status: "unchecked",
    };
    let mtime: Date;
    try {
      mtime = (await stat(path)).mtime;
    } catch {
      plugins.push({ ...health, status: "missing" });
      continue;
    }
    health.local_mtime = mtime.toISOString();
    if (!health.package) {
      plugins.push(health);
      continue;
    }
    let latest: Awaited<ReturnType<RegistryLookup>>;
    try {
      latest = await lookup(health.package);
    } catch {
      // An unreachable registry proves nothing about the copy. Reporting it as
      // stale would cry wolf on a plane; reporting it as current would hide a
      // real one.
      plugins.push({ ...health, status: "unreachable" });
      continue;
    }
    if (!latest) {
      plugins.push({ ...health, status: "unpublished" });
      continue;
    }
    plugins.push({
      ...health,
      published_version: latest.version,
      published_at: latest.published,
      status: mtime < new Date(latest.published) ? "stale" : "current",
    });
  }
  return {
    kind: "doctor",
    plugins,
    stale: plugins.filter((p) => p.status === "stale").length,
  };
}

/**
 * The full packument rather than the abbreviated one: `time` carries the
 * publish dates and the abbreviated form omits it.
 */
export function npmRegistry(timeoutMs = 3000): RegistryLookup {
  return async (pkg) => {
    const response = await fetch(
      "https://registry.npmjs.org/" + pkg.replace("/", "%2F"),
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`registry returned ${response.status} for ${pkg}`);
    const body = (await response.json()) as {
      "dist-tags"?: { latest?: string };
      time?: Record<string, string>;
    };
    const version = body["dist-tags"]?.latest;
    const published = version ? body.time?.[version] : undefined;
    if (!version || !published)
      throw new Error(`registry gave no current release for ${pkg}`);
    return { version, published };
  };
}
