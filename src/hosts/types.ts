export type HostCapabilities = {
  watchable: boolean;
  attachable: boolean;
  survivesParentExit: boolean;
};
export type TerminalApp = "terminal" | "iterm2" | "ghostty";
export type HostId = "tmux" | "pty" | "macos-terminal";
export type LaunchOptions = {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  label: string;
  /**
   * The terminal title, for a host that owns a window to put it on. `fromAgent`
   * shows the agent's own title instead, keeping `text` for `setTitle`.
   */
  title?: { text: string; fromAgent: boolean };
  /** Optional absolute readiness deadline; hosts must bound launch work. */
  deadline?: number;
};
export interface TerminalHost {
  readonly id: HostId;
  available(): Promise<boolean>;
  capabilities(): HostCapabilities;
  launch(opts: LaunchOptions): Promise<{ hostRef: string; pid: number }>;
  stop(hostRef: string): Promise<void>;
  list(): Promise<Array<{ hostRef: string; pid: number; label: string }>>;
  openAvailable?(terminal?: TerminalApp): Promise<boolean>;
  open?(
    hostRef: string,
    deadline: number,
    terminal?: TerminalApp,
  ): Promise<void>;
  /**
   * Schedule a delayed background command. Optional: only a host whose sessions
   * outlive their parent needs one, so pty and macos-terminal opt out of
   * lifecycle management by not implementing it.
   */
  schedule?(seconds: number, argv: string[]): Promise<void>;
  /** Retitle a live window. Optional: only a host that owns one can. */
  setTitle?(hostRef: string, text: string): Promise<void>;
  /** The host's own addressing handle, for a command that must name it. */
  socketName?(): string;
  attachHint(hostRef: string): string | null;
}
