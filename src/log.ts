import { mkdir, open, rename, stat } from "node:fs/promises";
import { join } from "node:path";
/**
 * Fields a metadata-only record must not carry: the instruction itself, any
 * captured screen or output, and anything environment-derived. Enough remains
 * to diagnose a failed launch without holding what was asked.
 *
 * `args` is deliberately NOT dropped: `runtimeArgs` admits only `--model`,
 * `-m`, `--effort`, `--agent` and `--variant`, so argv cannot carry instruction
 * text or a credential, and keeping it is worth more for diagnosis than the
 * nothing it exposes.
 */
export const METADATA_DROP = ["prompt", "diagnostic", "output", "env"] as const;
/**
 * A nested launch record — a ready session's `peer`, a started task's `run` —
 * is REBUILT from this allowlist in metadata mode rather than filtered by a
 * drop list.
 *
 * `peer.name` and `peer.canonical_id` are slugs of the runtime's own session
 * title, which every runtime derives from the prompt, so `{"name":
 * "secret-instruction"}` reached a log the README calls promptless. A drop
 * list would have fixed those two and let the next field someone adds to a
 * peer through; an allowlist admits only what is named here, which is the set
 * the spec enumerates for a metadata record.
 */
export const METADATA_RECORD_KEEP = [
  "kind",
  "id",
  "runtime",
  "state",
  "cwd",
  "host",
  "pid",
  "permissions",
  "sandbox",
  "enforcement",
  "mcp",
  "mcp_warnings",
  "plugins",
] as const;
/**
 * `requester` is the one nested object passed through whole: the spec keeps the
 * tuple and its label, and a label is supplied by the receiver's own config,
 * never derived from the request.
 */
const PASS_THROUGH = ["requester"];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * One generation, 8 MiB. The file had no bound at all before this.
 *
 * Rotation is not locked. Two processes crossing the ceiling together cannot
 * lose a line — each write opens the file fresh, and a rename only clobbers
 * the destination — but three or more crossing at once can, because a second
 * clobber may take out an intermediate file that has already been closed.
 * Accepted: the registry's lock exists for launch reservations, and coupling
 * a best-effort history to it would cost more than the history is worth. If
 * that trade ever stops holding, this is the place it changes.
 */
const MAX_BYTES = 8 * 1024 * 1024;
export class LaunchLog {
  constructor(private home: string) {}
  /**
   * The caller chooses the mode; this method only obeys it. The policy that a
   * non-local requester always gets `metadata`, and that a profile may not
   * relax it, lives with the requester policy resolution, not here.
   */
  async write(
    data: Record<string, unknown>,
    mode: "full" | "metadata" = "full",
  ): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const path = join(this.home, "launches.jsonl");
    const size = await stat(path)
      .then((s) => s.size)
      .catch(() => 0);
    if (size >= MAX_BYTES)
      await rename(path, path + ".1").catch(() => undefined);
    const body =
      mode === "full"
        ? data
        : Object.fromEntries(
            Object.entries(data)
              .filter(
                ([k]) => !(METADATA_DROP as readonly string[]).includes(k),
              )
              .map(([k, v]) =>
                isRecord(v) && !PASS_THROUGH.includes(k)
                  ? [
                      k,
                      Object.fromEntries(
                        Object.entries(v).filter(([field]) =>
                          (METADATA_RECORD_KEEP as readonly string[]).includes(
                            field,
                          ),
                        ),
                      ),
                    ]
                  : [k, v],
              ),
          );
    const file = await open(path, "a", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({ at: new Date().toISOString(), ...body }) + "\n",
      );
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
