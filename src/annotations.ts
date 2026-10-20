/** Informational caller assertions; never inputs to requester policy. */
export type LaunchProvenance = {
  namespace: string;
  session: string;
  launcher: string;
  parent: string | null;
};
export type LaunchAnnotations = {
  metadata?: Record<string, string>;
  provenance?: LaunchProvenance;
};

function objectJSON(raw: string, name: string): Record<string, unknown> {
  // Bound input before parsing, including whitespace and escaped spellings.
  if (Buffer.byteLength(raw, "utf8") > 128 * 1024)
    throw new Error(`${name} JSON exceeds 128 KiB`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be a JSON object`);
  // JSON.parse accepts duplicate keys. Tokenize valid JSON so punctuation in
  // string values cannot masquerade as keys; decode escapes before comparison.
  // Both supported objects are flat, so nested values are refused first.
  if (Object.values(value).some((v) => v !== null && typeof v === "object"))
    throw new Error(`${name} must be a flat JSON object`);
  const tokens = raw.match(/"(?:\\[\s\S]|[^"\\])*"|[^\s]/g) ?? [];
  const keys = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i]!.startsWith('"') && tokens[i + 1] === ":") {
      const key = JSON.parse(tokens[i]!) as string;
      if (keys.has(key)) throw new Error(`${name} contains a duplicate key`);
      keys.add(key);
    }
  }
  return value as Record<string, unknown>;
}

/** Parse only the structured options; named-option validation lives in options.ts. */
export function launchAnnotations(
  options: readonly string[],
): LaunchAnnotations {
  const result: LaunchAnnotations = {};
  for (const option of options) {
    const name = option.slice(0, option.indexOf("="));
    if (name !== "metadata" && name !== "provenance") continue;
    if (result[name] !== undefined)
      throw new Error(`${name} may be supplied only once`);
    const value = objectJSON(option.slice(name.length + 1), name);
    if (name === "metadata") {
      const entries = Object.entries(value);
      if (entries.length > 32) throw new Error("metadata exceeds 32 entries");
      for (const [key, val] of entries) {
        if (!key.length || Buffer.byteLength(key, "utf8") > 64)
          throw new Error("metadata keys must be 1 to 64 UTF-8 bytes");
        if (typeof val !== "string" || Buffer.byteLength(val, "utf8") > 1024)
          throw new Error(
            "metadata values must be strings of at most 1024 UTF-8 bytes",
          );
      }
      const metadata = Object.fromEntries(
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ) as Record<string, string>;
      if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 16384)
        throw new Error("metadata exceeds 16 KiB serialized as JSON");
      result.metadata = metadata;
    } else {
      const fields = ["namespace", "session", "launcher", "parent"];
      if (
        Object.keys(value).length !== fields.length ||
        fields.some((key) => !Object.hasOwn(value, key))
      )
        throw new Error(
          "provenance requires exactly namespace, session, launcher and parent",
        );
      for (const key of fields) {
        if (key === "parent" && value[key] === null) continue;
        if (
          typeof value[key] !== "string" ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(value[key])
        )
          throw new Error(
            `provenance ${key} must be 1 to 128 characters from A-Z, a-z, 0-9, dot, underscore, colon or hyphen`,
          );
      }
      result.provenance = {
        namespace: value.namespace as string,
        session: value.session as string,
        launcher: value.launcher as string,
        parent: value.parent as string | null,
      };
    }
  }
  return annotationView(result);
}

/** Always project from the immutable entry, not runtime-reported peer metadata. */
export function annotationView(record: LaunchAnnotations): LaunchAnnotations {
  return {
    ...(record.metadata !== undefined
      ? { metadata: structuredClone(record.metadata) }
      : {}),
    ...(record.provenance !== undefined
      ? { provenance: { ...record.provenance } }
      : {}),
  };
}
