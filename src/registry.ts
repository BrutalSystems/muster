import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  processRef,
  isSame,
  delay,
  groupAlive,
  type ProcessRef,
} from "./identity/processes.js";
import type { RunRequest, LaunchPermissions } from "./guard.js";
import type { Runtime } from "./types.js";
import { LOCAL, requesterKey, type RequesterId } from "./requester.js";
import type { Enforcement } from "./enforcement.js";
export type Entry = Partial<LaunchPermissions> & {
  id: string;
  launchId: string;
  requestKey?: string;
  paramsFingerprint?: string;
  runtime: Runtime;
  kind: "session" | "task";
  cwd: string;
  status: "starting" | "running" | "exited" | "failed" | "stopped" | "unknown";
  /** Set immediately before a process is started, and the only evidence that
   * one may exist when the launch owner dies before recording it. */
  spawning?: true;
  unknownSince?: string;
  createdAt: string;
  owner: ProcessRef;
  root?: ProcessRef;
  /** The process group the root leads, when it leads one. Survives reparenting,
   * which the recorded descendants do not. */
  group?: number;
  descendants?: ProcessRef[];
  host?: "tmux" | "pty" | "macos-terminal";
  hostRef?: string;
  peer?: Record<string, unknown>;
  server_url?: string;
  opencode_port?: number;
  outputPath?: string;
  exitPath?: string;
  error?: string;
  mcpConfigPath?: string;
  /** Per-launch copy of the identity's configuration. */
  identityPath?: string;
  /**
   * The resolved identity NAME this launch ran as — including one a remote
   * requester got from its profile's single-identity default without naming it.
   * `identityPath` is keyed by launch id and its directory is removed at
   * cleanup, so it cannot answer "which account was this?" afterwards; this can,
   * and that question is the whole point of the feature. Entries written before
   * this field ran on the ambient environment, which is what no value means.
   */
  identity?: string;
  /**
   * The model Muster resolved at launch — never what the child reported. A
   * child's own account of which model it ran is self-reported evidence a
   * controller auditing the run cannot trust; this is what Muster itself
   * determined and handed over.
   *
   * Absent means an entry written before this field existed. An explicit null
   * means this version resolved nothing and the child chose its own default,
   * which is a different and more useful fact than the field being missing.
   */
  model?: string | null;
  /** How `model` was determined, or null alongside a null model. */
  modelSource?: "request" | "config" | null;
  /**
   * Seconds of idleness after which this session is stopped, or null for no
   * limit. Absent on an entry written before the field, which `reap-check`
   * treats as "decide nothing" rather than as zero.
   */
  idleTimeout?: number | null;
  /** Seconds since launch after which it is stopped regardless of state. */
  ttl?: number | null;
  /**
   * The agent's configuration home for this launch, as the AGENT sees it — the
   * value of `CODEX_HOME` or `CLAUDE_CONFIG_DIR` in the environment it was
   * spawned with. Usually the identity copy, but a requester profile's
   * `env_defaults` can deliver either key by design, and then it is neither the
   * copy nor the host's. Persisted so `refreshed()` searches the same place the
   * launch did; absent means the host environment, which is what it always was.
   */
  configHome?: string;
  mcp?: string[];
  mcp_warnings?: string[];
  /**
   * Who asked for this launch. Written once at reservation and never updated —
   * provenance that changed after the fact would not be provenance. Entries
   * written before this field read as local, which is what they were.
   */
  requester?: RequesterId;
  /** How strongly the containment was imposed. See src/enforcement.ts. */
  enforcement?: Enforcement;
};
/**
 * A request key arrived again with different parameters. Distinct from a launch
 * failure: nothing was attempted, and the caller reused a key it should have
 * rotated.
 */
export class IdempotencyKeyReuse extends Error {
  constructor(
    readonly requestKey: string,
    readonly recorded: string,
    readonly offered: string,
  ) {
    super(
      `Request key ${requestKey} was recorded with different parameters ` +
        `(recorded ${recorded.slice(0, 12)}, offered ${offered.slice(0, 12)}). ` +
        `Use a new key to launch something different.`,
    );
    this.name = "IdempotencyKeyReuse";
  }
}
export class Registry {
  constructor(readonly home: string) {}
  private async transaction<T>(
    fn: (entries: Entry[]) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const lock = join(this.home, "registry.lock");
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await mkdir(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() > deadline)
          throw new Error(
            "Registry locked; verify no Muster operation is running before removing registry.lock",
          );
        await delay(20);
      }
    }
    try {
      let entries: Entry[] = [];
      try {
        const value: unknown = JSON.parse(
          await readFile(join(this.home, "registry.json"), "utf8"),
        );
        if (!Array.isArray(value)) throw new Error("Invalid registry");
        entries = value;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      for (const entry of entries) {
        if (
          entry.status === "starting" &&
          !(await isSame(entry.owner)) &&
          !entry.root
        ) {
          // The owner died between reserving and recording a process. Whether
          // one exists depends on how far it got, and the entry cannot say —
          // so only the half that provably never reached a spawn is called
          // failed. The other half is unknown, which is not the same claim:
          // failed reads as safe to retry, and retrying a launch that did
          // happen is how a second agent appears in the same directory.
          if (entry.spawning) {
            entry.status = "unknown";
            entry.unknownSince ??= new Date().toISOString();
            entry.error =
              "launch owner exited after starting a process but before recording it; " +
              "a session may be running untracked";
          } else {
            entry.status = "failed";
            entry.error = "launch owner exited before recording process";
          }
        }
        if (
          ["starting", "running"].includes(entry.status) &&
          entry.root &&
          !(await isSame(entry.root))
        ) {
          // The recorded descendants are only those seen during launch, and a
          // reparented one is not among them at all. Ask the group before
          // concluding the session ended: it is the signal that survives both.
          if (
            !(await Promise.all((entry.descendants ?? []).map(isSame))).some(
              Boolean,
            ) &&
            !(entry.group && (await groupAlive(entry.group)))
          )
            entry.status = "exited";
        }
      }
      const result = await fn(entries);
      const path = join(this.home, `registry.${randomUUID()}.tmp`);
      await writeFile(path, JSON.stringify(entries, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(path, join(this.home, "registry.json"));
      return result;
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  async all(): Promise<Entry[]> {
    return this.transaction(async (entries) => structuredClone(entries));
  }
  /**
   * The lookup runs inside the same transaction as the write, so the mkdir lock
   * that already serializes reservations serializes deduplication too.
   *
   * Order is load-bearing: a match returns before the cap is consulted, because
   * the entry it returns is already counted against the cap. Checking capacity
   * first would reject a retry of a launch that succeeded, which reads as a
   * failure and invites a third attempt.
   */
  async reserve(
    req: Pick<RunRequest, "runtime" | "kind" | "cwd"> &
      Partial<LaunchPermissions> &
      Pick<
        Entry,
        | "enforcement"
        | "model"
        | "modelSource"
        | "identity"
        | "idleTimeout"
        | "ttl"
      >,
    cap: number,
    idem?: { requestKey: string; paramsFingerprint: string },
    requester: RequesterId = LOCAL,
  ): Promise<{ entry: Entry; deduped: boolean }> {
    const owner = await processRef(process.pid);
    if (!owner) throw new Error("Cannot identify Muster owner process");
    const scope = requesterKey(requester);
    return this.transaction(async (entries) => {
      if (idem) {
        // Scoped by requester: two machines may legitimately choose the same
        // request key, and deduping one into the other would hand a caller a
        // session it never asked for.
        const prior = entries.find(
          (e) =>
            e.requestKey === idem.requestKey &&
            requesterKey(e.requester ?? LOCAL) === scope,
        );
        if (prior) {
          if (prior.paramsFingerprint !== idem.paramsFingerprint)
            throw new IdempotencyKeyReuse(
              idem.requestKey,
              prior.paramsFingerprint ?? "none",
              idem.paramsFingerprint,
            );
          return { entry: structuredClone(prior), deduped: true };
        }
      }
      // Admission seam: `scope` is the per-requester key a future per-requester
      // cap and locally-reserved portion would count against, available here
      // inside the transaction where the accounting has to happen. The cap is
      // global today.
      if (
        entries.filter((e) => e.status === "starting" || e.status === "running")
          .length >= cap
      )
        throw new Error(`Concurrency cap reached (${cap})`);
      const id = randomUUID();
      const entry: Entry = {
        ...req,
        id,
        launchId: id,
        ...(idem ?? {}),
        status: "starting",
        requester,
        createdAt: new Date().toISOString(),
        owner,
      };
      entries.push(entry);
      return { entry: { ...entry }, deduped: false };
    });
  }
  async update(id: string, patch: Partial<Entry>): Promise<Entry> {
    return this.transaction(async (entries) => {
      const byLaunch = entries.find((e) => e.launchId === id);
      const durable = entries.filter((e) => e.id === id);
      if (!byLaunch && durable.length > 1)
        throw new Error("Ambiguous durable id; update by launchId");
      const entry = byLaunch ?? durable[0];
      if (!entry) throw new Error(`Unknown launch ${id}`);
      if ("requester" in patch)
        throw new Error("requester is recorded once and cannot be updated");
      if (
        patch.id &&
        entries.some(
          (e) =>
            e !== entry && e.runtime === entry.runtime && e.id === patch.id,
        )
      )
        throw new Error("Durable identity already registered");
      Object.assign(entry, patch);
      return structuredClone(entry);
    });
  }
}
