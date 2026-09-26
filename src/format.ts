// Human formatting is CLI-only; runtime records and MCP responses stay unchanged.
type RecordView = {
  mcp?: string[];
  mcp_warnings?: string[];
  permissions?: string;
  sandbox?: string;
  model?: string | null;
  model_source?: "request" | "config" | null;
  idle_timeout?: number | null;
  ttl?: number | null;
  identity?: string;
  kind?: string;
  runtime?: string;
  state?: string;
  id?: string;
  thread_id?: string;
  session_id?: string;
  server_url?: string;
  canonical_id?: string;
  cwd?: string;
  host?: string;
  terminal_opened?: boolean;
  terminal?: string;
  attach_hint?: string | null;
  exit_code?: number | null;
  signal?: string | null;
  error?: string;
  stopped?: boolean;
};
function clean(value: unknown): string {
  return String(value ?? "-").replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (c) =>
      c === "\n"
        ? "\\n"
        : c === "\r"
          ? "\\r"
          : c === "\t"
            ? "\\t"
            : "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
function argument(value: string): string {
  return /^[a-zA-Z0-9_.:-]+$/.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\\''") + "'";
}
export function humanColorEnabled(
  isTTY: boolean | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  return isTTY === true && env.NO_COLOR === undefined && env.TERM !== "dumb";
}
/** Rendered from seconds rather than rounded to minutes: parseDuration accepts
 *  45s, and "1m" for a 45s limit misreports it. */
function duration(seconds: number): string {
  return seconds % 3600 === 0
    ? `${seconds / 3600}h`
    : seconds % 60 === 0
      ? `${seconds / 60}m`
      : `${seconds}s`;
}
function recordHuman(record: RecordView, color: boolean): string {
  const paint = (value: string, code: number) =>
    color ? `\u001b[${code}m${value}\u001b[0m` : value;
  const field = (label: string, value: string) =>
    `  ${paint(label + ":", 90)} ${value}`;
  const badExit =
    typeof record.exit_code === "number" && record.exit_code !== 0;
  const stateColor =
    record.state === "failed" || record.state === "unknown" || badExit
      ? 31
      : ["idle", "running"].includes(record.state ?? "")
        ? 32
        : ["busy", "starting"].includes(record.state ?? "")
          ? 33
          : 90;
  const id = record.id ?? record.thread_id ?? record.session_id;
  if (record.stopped === true) return `${paint("Stopped", 90)} ${clean(id)}.`;
  const lines = [
    `${clean(record.runtime)} · ${clean(record.kind)} · ${paint(clean(record.state), stateColor)}`,
    field("ID", clean(id)),
  ];
  if (record.canonical_id)
    lines.push(field("Address", clean(record.canonical_id)));
  if (record.runtime === "opencode" && record.server_url)
    lines.push(field("Control URL", clean(record.server_url)));
  lines.push(field("Directory", clean(record.cwd)));
  if (record.identity) lines.push(field("Identity", clean(record.identity)));
  if (record.permissions)
    lines.push(field("Permissions", clean(record.permissions)));
  if (record.sandbox) lines.push(field("Sandbox", clean(record.sandbox)));
  // Only when known: a null means the child chose its own model, and "-" in a
  // human listing would read as a value rather than an absence. The source is
  // shown because "pinned by the caller" and "fell back to the configured
  // default" are the distinction the field exists to make.
  if (record.model)
    lines.push(
      field(
        "Model",
        `${clean(record.model)}${
          record.model_source === "request"
            ? " (requested)"
            : record.model_source === "config"
              ? " (configured default)"
              : ""
        }`,
      ),
    );
  if (record.idle_timeout)
    lines.push(field("Idle timeout", duration(record.idle_timeout)));
  if (record.ttl) lines.push(field("TTL", duration(record.ttl)));
  if (record.mcp)
    lines.push(
      field(
        "MCP",
        record.mcp.length ? record.mcp.map(clean).join(", ") : "none",
      ),
    );
  for (const warning of record.mcp_warnings ?? [])
    lines.push(field("MCP warning", clean(warning)));
  if (record.host)
    lines.push(
      field(
        "Host",
        `${clean(record.host)}${record.host === "pty" ? " (not watchable or attachable)" : ""}`,
      ),
    );
  if (record.terminal_opened)
    lines.push(
      field(
        "Terminal",
        `${record.terminal === "ghostty" ? "Ghostty" : record.terminal === "iterm2" ? "iTerm2" : "Terminal.app"} (opened at launch)`,
      ),
    );
  if (record.exit_code !== undefined)
    lines.push(
      field(
        "Exit code",
        badExit ? paint(clean(record.exit_code), 31) : clean(record.exit_code),
      ),
    );
  if (record.signal) lines.push(field("Signal", clean(record.signal)));
  if (record.error) lines.push(field("Error", paint(clean(record.error), 31)));
  const live = ["starting", "running", "idle", "busy"].includes(
    record.state ?? "",
  );
  if (live && record.attach_hint)
    lines.push(field("Attach", paint(clean(record.attach_hint), 36)));
  if (record.kind === "task" && id)
    lines.push(
      field("Output", paint(`muster output ${argument(clean(id))}`, 36)),
    );
  if (live && id)
    lines.push(field("Stop", paint(`muster stop ${argument(clean(id))}`, 36)));
  return lines.join("\n");
}
/** Structural, like RecordView: formatting stays free of runtime imports. */
type DoctorView = {
  kind: "doctor";
  plugins: {
    name: string;
    path: string;
    package: string | null;
    status: string;
    published_version?: string;
    published_at?: string;
  }[];
  stale: number;
};
function doctorHuman(report: DoctorView, color: boolean): string {
  const paint = (value: string, code: number) =>
    color ? `\u001b[${code}m${value}\u001b[0m` : value;
  const field = (label: string, value: string) =>
    `  ${paint(label + ":", 90)} ${value}`;
  if (!report.plugins.length) return "No path-configured plugins to check.\n";
  const lines: string[] = [];
  for (const plugin of report.plugins) {
    const released = plugin.published_version ?? "?";
    const when = (plugin.published_at ?? "").slice(0, 10);
    const detail: Record<string, string> = {
      stale: `copy predates ${released}, published ${when}`,
      current: `copy is newer than ${released}`,
      unpublished: "no such package on the registry",
      unchecked: 'no package known; add published = "@scope/name"',
      unreachable: "registry lookup failed; nothing proven either way",
      missing: "no file at that path",
    };
    const code =
      plugin.status === "stale" ? 31 : plugin.status === "current" ? 32 : 33;
    lines.push(
      `${paint(clean(plugin.name), 1)} ${clean(plugin.package ?? "-")}`,
      field(
        "Status",
        `${paint(plugin.status, code)} \u2014 ${detail[plugin.status] ?? ""}`,
      ),
      field("Path", clean(plugin.path)),
    );
  }
  const stale = report.plugins.filter((p) => p.status === "stale");
  lines.push(
    "",
    stale.length
      ? `${stale.length} stale plugin${stale.length > 1 ? "s" : ""}. Replace path with npm = "${stale[0]!.package}" in [plugins.${stale[0]!.name}], or re-copy the file.`
      : "No stale plugins.",
  );
  return lines.join("\n") + "\n";
}
export function formatHuman(
  value: RecordView | RecordView[] | DoctorView,
  color = false,
): string {
  if (!Array.isArray(value) && value.kind === "doctor")
    return doctorHuman(value as DoctorView, color);
  if (Array.isArray(value))
    return value.length
      ? value.map((record) => recordHuman(record, color)).join("\n\n") + "\n"
      : "No Muster runs.\n";
  return recordHuman(value, color) + "\n";
}
/**
 * What a human sees when they type `muster` with no arguments at a terminal.
 *
 * With no arguments Muster starts the MCP server, which from a terminal looks
 * exactly like a hang — the process is waiting for JSON-RPC on stdin and has
 * nothing to say. The server path is reached by a pipe, never a TTY, so a
 * terminal can be answered without changing what any MCP client gets.
 *
 * The session count is what the registry recorded, not what is running: it is
 * read without the refresh `list` performs, because that refresh also reaps a
 * terminal entry's identity copy and reaches an OpenCode session over HTTP.
 * Neither belongs in the output of typing a bare command, so the wording says
 * "recorded" and points at `list` for the authoritative answer.
 */
export function statusText(
  identities: { name: string; agent: string; auth: { state: string } }[],
  sessions: number,
): string {
  const lines: string[] = [];
  if (!identities.length)
    lines.push(
      "No identities yet — add one with:",
      "    muster setup-identity --identity NAME --agent <codex|claude|opencode> --interactive",
    );
  else
    lines.push(
      `${identities.length} ${identities.length === 1 ? "identity" : "identities"} — ` +
        identities.map((i) => `${i.name} ${i.auth.state}`).join(", "),
    );
  lines.push(
    sessions === 0
      ? "No recorded sessions."
      : `${sessions} recorded session${sessions === 1 ? "" : "s"} (muster list refreshes)`,
    "",
    "Starting the MCP server? Use `muster mcp`.",
  );
  return lines.join("\n") + "\n";
}
