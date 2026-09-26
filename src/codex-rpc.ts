import { codexPolicyArgs } from "./codex-policy.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
/** JSONL protocol mechanics independently adapted from Tin Can src/codex/cli.ts
 * at fbaaea5842fd4a5c86849d7f51c8e16b8683b058 (MIT). */
export class CodexRpc {
  private child?: ChildProcessWithoutNullStreams;
  private serial = 0;
  private buffer = "";
  private initialized = false;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    private env: NodeJS.ProcessEnv,
    private cwd = process.cwd(),
    private policy?: string[],
  ) {}
  private async start(deadline: number) {
    if (this.child) return;
    const policy =
      this.policy ?? (await codexPolicyArgs(this.env, this.cwd, deadline));
    const child = spawn(
      "codex",
      [...policy, "app-server", "--listen", "stdio://"],
      {
        env: this.env,
        cwd: this.cwd,
        stdio: "pipe",
      },
    );
    this.child = child;
    child.stderr.resume();
    const fail = (e: Error) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.pending.clear();
    };
    child.on("error", fail);
    child.on("exit", () => fail(new Error("Codex app-server exited")));
    child.stdin.on("error", fail);
    child.stdout.on("data", (data) => {
      this.buffer += data;
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const p = this.pending.get(m.id);
        if (!p) continue;
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message ?? "Codex RPC error"));
        else if (!m.result || typeof m.result !== "object")
          p.reject(new Error("Invalid Codex RPC result"));
        else p.resolve(m.result);
      }
    });
  }
  private send(
    method: string,
    params: unknown,
    deadline: number,
  ): Promise<any> {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return Promise.reject(new Error(`Timed out calling ${method}`));
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`Timed out calling ${method}`));
        },
        Math.min(remaining, 2000),
      );
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async call(method: string, params: unknown, deadline: number): Promise<any> {
    await this.start(deadline);
    if (!this.initialized) {
      await this.send(
        "initialize",
        {
          clientInfo: { name: "muster", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
        deadline,
      );
      this.initialized = true;
    }
    return this.send(method, params, deadline);
  }
  async close() {
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Codex RPC closed"));
    }
    this.pending.clear();
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
