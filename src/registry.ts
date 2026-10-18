import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  /**
   * The `--on-exit` command and the directory it was asked from. Recorded so
   * the detached watcher that runs it learns everything from the registry, and
   * so a second `--on-exit` for the same launch (a request key sent twice) is
   * refused rather than silently replacing the first.
   */
  onExit?: { command: string; cwd: string };
  /**
   * When `stop` was asked for a launch that had not yet ended. A process found
   * gone after this was stopped, not exited. Never set on a launch that had
   * already ended: see `requestStop`.
   */
  stopRequestedAt?: string;
  /** When the `--on-exit` command was claimed. Set once; see `claimOnExit`. */
  onExitFiredAt?: string;
  /**
   * What became of the claimed `--on-exit` command: its status, or why it could
   * not run. Absent beside `onExitFiredAt` means the watcher died between the
   * claim and the end of the command, which is itself the evidence.
   */
  onExitResult?: OnExitResult;
};
/**
 * Whether a vanished launch was ended by its stop: a stop was asked, and no
 * task exit file was written before it. The file is the worker's, published
 * by rename, so its mtime is when the exit was recorded.
 */
async function stoppedBeforeExit(entry: Entry): Promise<boolean> {
  if (!entry.stopRequestedAt) return false;
  if (entry.kind !== "task" || !entry.exitPath) return true;
  const written = await stat(entry.exitPath).then(
    (s) => s.mtimeMs,
    () => undefined,
  );
  return written === undefined || written >= Date.parse(entry.stopRequestedAt);
}
export type OnExitResult = {
  finished_at: string;
  exit_code: number | null;
  signal: string | null;
  /** Why the command could not start, or could not be waited on. */
  error?: string;
  /** Fallbacks taken to run it at all: a removed cwd, an unwritable log. */
  warnings?: string[];
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
/**
 * A lock directory with no owner file is presumed live for this long. Long
 * enough that no transaction comes near it, and the holder writes its owner
 * file immediately after taking the lock, so in practice only a lock left by a
 * version that wrote none (an empty directory) ever reaches it.
 */
const UNOWNED_LOCK_MS = 60_000;
let self: ProcessRef | undefined;
/** Statuses whose process is over: such an entry no longer holds its id. */
const FINISHED: readonly Entry["status"][] = ["exited", "failed", "stopped"];
/**
 * The entry a durable id names. One id can have several since `--resume`: the
 * launches that ran a session before, now finished, and the one running it
 * now. The live one is meant, else the newest; two live ones cannot arise,
 * because `update` refuses a second live holder of an id.
 */
export function currentEntry(entries: Entry[]): Entry | undefined {
  const live = entries.filter((e) => !FINISHED.includes(e.status));
  if (live.length > 1)
    throw new Error("Ambiguous durable id; update by launchId");
  return (
    live[0] ??
    [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  );
}
export class Registry {
  /** `lockWait` is how long to wait for a live holder; tests shorten it. */
  constructor(
    readonly home: string,
    private readonly lockWait = 5000,
  ) {}
  private async transaction<T>(
    fn: (entries: Entry[]) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const lock = join(this.home, "registry.lock");
    const deadline = Date.now() + this.lockWait;
    while (true) {
      try {
        await mkdir(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (await this.breakStale(lock)) continue;
        if (Date.now() > deadline) {
          const owner = await lockOwner(lock);
          throw new Error(
            owner
              ? `Registry locked, held by pid ${owner.pid}; verify no Muster operation is running before removing registry.lock`
              : "Registry locked; verify no Muster operation is running before removing registry.lock",
          );
        }
        await delay(20);
      }
    }
    try {
      // The lock is released only by this process's `finally`, which does not
      // run if the process dies first: an unhandled EPIPE, or a SIGKILL from a
      // client stopping its MCP server. The owner file is what lets the next
      // process see that and take the lock over instead of waiting forever.
      // Cached only once known: a `ps` that failed once must not leave every
      // later transaction of a long-lived server unowned.
      const ref = (self ??= await lockRef(process.pid));
      if (ref) await writeFile(join(lock, "owner.json"), JSON.stringify(ref));
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
            entry.status = (await stoppedBeforeExit(entry))
              ? "stopped"
              : "exited";
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
  /**
   * Removes the lock if its holder is provably gone: its recorded process is
   * not running, or it recorded none and is older than any transaction.
   *
   * Breaking is serialized by a second directory and the verdict re-checked
   * inside it. Without that, two waiters could both judge the same dead lock,
   * one break it and take a new lock, and the other then remove that live one.
   */
  private async breakStale(lock: string): Promise<boolean> {
    const breaker = `${lock}.break`;
    try {
      await mkdir(breaker);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A breaker holds this for milliseconds; one this old died holding it.
      const age = await ageMs(breaker);
      if (age !== undefined && age > UNOWNED_LOCK_MS)
        await rm(breaker, { recursive: true, force: true });
      return false;
    }
    try {
      const owner = await lockOwner(lock);
      const stale = owner
        ? await holderGone(owner)
        : ((await ageMs(lock)) ?? 0) > UNOWNED_LOCK_MS;
      if (!stale) return false;
      await rm(lock, { recursive: true, force: true });
      return true;
    } finally {
      await rm(breaker, { recursive: true, force: true });
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
  /**
   * One entry, read without the lock. Safe because every write lands by rename,
   * so a reader sees the old file or the new one and never half of either. For
   * polling only: it does not run the liveness sweep, so a status read here may
   * be stale until the next transaction.
   */
  async peek(launchId: string): Promise<Entry | undefined> {
    try {
      const entries = JSON.parse(
        await readFile(join(this.home, "registry.json"), "utf8"),
      ) as Entry[];
      return entries.find((e) => e.launchId === launchId);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  /**
   * True at most once per launch. The check and the write share a transaction,
   * so two watchers racing over the same exit cannot both run the command.
   * At most, not exactly: a watcher that dies after claiming runs nothing.
   */
  async claimOnExit(launchId: string): Promise<Entry | undefined> {
    return this.transaction(async (entries) => {
      const entry = entries.find((e) => e.launchId === launchId);
      if (!entry?.onExit || entry.onExitFiredAt) return undefined;
      entry.onExitFiredAt = new Date().toISOString();
      return { ...entry };
    });
  }
  /**
   * Records that `stop` was asked, unless the launch has already ended, in
   * which case nothing changes and undefined is returned: stopping a finished
   * launch must not rewrite how it finished. `ended` is asked inside the
   * transaction, after its sweep, so a process that vanished is already
   * `exited` by the time it looks.
   */
  async requestStop(
    launchId: string,
    ended: (entry: Entry) => Promise<boolean>,
  ): Promise<Entry | undefined> {
    return this.transaction(async (entries) => {
      const entry = entries.find((e) => e.launchId === launchId);
      if (!entry) throw new Error(`Unknown launch ${launchId}`);
      if (await ended(entry)) return undefined;
      entry.stopRequestedAt ??= new Date().toISOString();
      return { ...entry };
    });
  }
  /**
   * Records the `--on-exit` command, refusing one already recorded. The check
   * and the write share a transaction: two callers handed the same launch (a
   * request key sent twice) would otherwise both see none and both succeed,
   * with the second command silently replacing the first.
   */
  async armOnExit(
    launchId: string,
    onExit: NonNullable<Entry["onExit"]>,
  ): Promise<void> {
    return this.transaction(async (entries) => {
      const entry = entries.find((e) => e.launchId === launchId);
      if (!entry) throw new Error(`Unknown launch ${launchId}`);
      if (entry.onExit)
        throw new Error(
          `launch ${entry.id} already has an --on-exit command; it is claimed at most once, so a second is refused rather than dropped`,
        );
      entry.onExit = onExit;
    });
  }
  async update(id: string, patch: Partial<Entry>): Promise<Entry> {
    return this.transaction(async (entries) => {
      const byLaunch = entries.find((e) => e.launchId === id);
      const entry =
        byLaunch ?? currentEntry(entries.filter((e) => e.id === id));
      if (!entry) throw new Error(`Unknown launch ${id}`);
      if ("requester" in patch)
        throw new Error("requester is recorded once and cannot be updated");
      if (
        patch.id &&
        entries.some(
          (e) =>
            e !== entry &&
            e.runtime === entry.runtime &&
            e.id === patch.id &&
            !FINISHED.includes(e.status),
        )
      )
        throw new Error("Durable identity already registered");
      Object.assign(entry, patch);
      return structuredClone(entry);
    });
  }
}
async function lockOwner(lock: string): Promise<ProcessRef | undefined> {
  try {
    const value = JSON.parse(
      await readFile(join(lock, "owner.json"), "utf8"),
    ) as Partial<ProcessRef>;
    return typeof value.pid === "number" && typeof value.start === "string"
      ? { pid: value.pid, start: value.start }
      : undefined;
  } catch {
    return undefined;
  }
}
/**
 * The holder's identity as written into the lock. `ps` prints the start time in
 * the caller's timezone and language, and the holder and a waiter need not
 * share either (an MCP client's environment, a terminal's). Fixing both here
 * makes the two readings comparable; `processRef`, whose strings are already
 * stored in registry.json, is left as it is.
 */
async function lockRef(pid: number): Promise<ProcessRef | undefined> {
  try {
    const { stdout } = await promisify(execFile)(
      "ps",
      ["-p", String(pid), "-o", "lstart=,stat="],
      { timeout: 1000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" } },
    );
    const out = stdout.trim();
    if (!out || /\bZ\S*$/.test(out)) return;
    return { pid, start: out.slice(0, 24) };
  } catch {
    return;
  }
}
/**
 * Gone only on positive evidence. `processRef` answers undefined for any `ps`
 * failure, a timeout under load included, and breaking a live lock on that
 * would let two transactions interleave their writes.
 */
async function holderGone(owner: ProcessRef): Promise<boolean> {
  try {
    process.kill(owner.pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
  // The pid is in use; it is the holder unless it started at another time.
  const now = await lockRef(owner.pid);
  return now !== undefined && now.start !== owner.start;
}
async function ageMs(path: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}
