import type { TerminalHost } from "./types.js";
export class MacosTerminalHost implements TerminalHost {
  readonly id = "macos-terminal" as const;
  async available() {
    return false;
  }
  capabilities() {
    return { watchable: false, attachable: false, survivesParentExit: false };
  }
  async launch(): Promise<{ hostRef: string; pid: number }> {
    throw new Error("macos-terminal is not implemented in v1");
  }
  async stop() {
    throw new Error("macos-terminal is not implemented in v1");
  }
  async list() {
    return [];
  }
  attachHint() {
    return null;
  }
}
