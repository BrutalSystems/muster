import { z } from "zod";
import type { Config } from "./config.js";

export const providerName = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const environmentName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
const modelId = z.string().min(1);

/**
 * Deliberately thin. OpenCode's provider schema is far larger; Muster carries
 * only what a launch needs to stand on its own, so the operator does not have
 * to keep a matching definition in ~/.config/opencode. Per-model options are
 * passed through verbatim because model capability flags (tool_call, limit)
 * decide whether an agent can use tools at all.
 */
export const providerSchema = z
  .object({
    npm: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    base_url: z.string().url().optional(),
    api_key: z.string().min(1).optional(),
    api_key_env_var: environmentName.optional(),
    models: z
      .union([
        z.array(modelId),
        z.record(modelId, z.record(z.string(), z.unknown())),
      ])
      .default({}),
  })
  .strict()
  .refine(
    (p) => !(p.api_key !== undefined && p.api_key_env_var !== undefined),
    "api_key and api_key_env_var cannot be combined",
  );
export type ProviderDefinition = z.infer<typeof providerSchema>;

export const openCodeSectionSchema = z
  .object({
    model: z.string().min(1).optional(),
    provider: z.record(providerName, providerSchema).default({}),
  })
  .strict()
  .default({});

function models(definition: ProviderDefinition) {
  return Array.isArray(definition.models)
    ? Object.fromEntries(definition.models.map((id) => [id, {}]))
    : definition.models;
}

function apiKey(
  name: string,
  definition: ProviderDefinition,
  source: NodeJS.ProcessEnv,
): string | undefined {
  if (definition.api_key !== undefined) return definition.api_key;
  if (definition.api_key_env_var === undefined) return undefined;
  const value = source[definition.api_key_env_var];
  // Failing here beats launching a session whose every turn dies on a 401.
  if (value === undefined || value === "")
    throw new Error(
      `Provider ${name} needs ${definition.api_key_env_var} in the environment`,
    );
  return value;
}

/**
 * The provider/model half of the OpenCode overlay. Providers merge with any
 * the child resolves for itself, so these definitions add to the operator's
 * own configuration rather than replacing it.
 */
export function openCodeProviders(
  config: Config,
  source: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const entries = Object.entries(config.opencode.provider);
  if (entries.length === 0) return {};
  return Object.fromEntries(
    entries.map(([name, definition]) => {
      const key = apiKey(name, definition, source);
      const options: Record<string, unknown> = {};
      if (definition.base_url !== undefined)
        options.baseURL = definition.base_url;
      if (key !== undefined) options.apiKey = key;
      return [
        name,
        {
          ...(definition.npm !== undefined && { npm: definition.npm }),
          ...(definition.name !== undefined && { name: definition.name }),
          ...(Object.keys(options).length > 0 && { options }),
          models: models(definition),
        },
      ];
    }),
  );
}
