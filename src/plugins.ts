import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Config } from "./config.js";
import type { RunRequest } from "./guard.js";

export const pluginName = z.string().regex(/^[a-zA-Z0-9_-]+$/);

/**
 * A plugin is named either by a path on disk or by an npm specifier, never
 * both. OpenCode accepts either in its `plugin` array; a path has to become a
 * file URL, while a specifier must be passed through untouched so OpenCode can
 * resolve and install it.
 *
 * Neither form escapes staleness. A copied file goes stale on disk; a specifier
 * goes stale in OpenCode's package cache, which resolves the range once and
 * keeps serving that copy. A version can be pinned in the specifier where the
 * staleness should be deliberate, since it is passed through untouched. Either
 * way, an outdated plugin is indistinguishable from no plugin at all.
 */
export const pluginSchema = z.union(
  [
    z
      .object({
        path: z.string().min(1),
        // Names the published package a copied file came from, so `muster doctor`
        // can check it. Meaningless alongside `npm`, which strict() rejects.
        published: z.string().min(1).optional(),
      })
      .strict(),
    z.object({ npm: z.string().min(1) }).strict(),
  ],
  // The union rejects a plugin carrying neither key before a refinement could
  // run, so the message belongs here: attached to the union it never fired,
  // and the operator saw "Invalid input" instead.
  { errorMap: () => ({ message: "a plugin needs either path or npm" }) },
);
export type PluginDefinition = z.infer<typeof pluginSchema>;
export type SelectedPlugin = { name: string; url: string };

/**
 * Operator definitions are written as ordinary paths, so `~` and relative
 * paths resolve here rather than in the launch path, where a wrong answer
 * would be harder to see.
 */
export function pluginPath(path: string): string {
  const expanded = path.startsWith("~/")
    ? join(homedir(), path.slice(2))
    : path;
  return resolve(expanded);
}
function pluginUrl(path: string): string {
  return pathToFileURL(pluginPath(path)).href;
}

/**
 * Packages Muster already knows are published, so a path-configured copy can be
 * checked without the operator naming it. Keyed by the plugin's config name; a
 * section named anything else needs an explicit `published`.
 */
const publishedPlugins: Record<string, string> = {
  tincan: "@brutalsystems/tincan-opencode",
  birddog: "@brutalsystems/birddog-opencode",
};

/** The package a path-configured plugin came from, or null if unknowable. */
export function publishedPackage(
  name: string,
  plugin: PluginDefinition,
): string | null {
  if ("npm" in plugin) return null;
  return plugin.published ?? publishedPlugins[name] ?? null;
}

export function selectPlugins(
  req: RunRequest,
  config: Config,
): SelectedPlugin[] {
  // Personal defaults apply to sessions, not unattended one-shot tasks —
  // the same rule selectMcp uses.
  const names =
    req.plugin ?? (req.kind === "session" ? config.default_plugins : []);
  return [...new Set(names)].map((name) => {
    const plugin = Object.hasOwn(config.plugins, name)
      ? config.plugins[name]
      : undefined;
    if (!plugin) throw new Error(`Unknown plugin: ${name}`);
    // A specifier goes through verbatim: resolving it is OpenCode's job.
    return {
      name,
      url: "npm" in plugin ? plugin.npm : pluginUrl(plugin.path),
    };
  });
}
