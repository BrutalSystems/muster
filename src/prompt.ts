import { createInterface } from "node:readline/promises";
/** Asks one question and returns what was typed. Injected so a test can script
 *  a terminal without one. */
export type LineReader = (question: string) => Promise<string>;
export const AGENTS = ["codex", "claude", "opencode"] as const;
export type Agent = (typeof AGENTS)[number];
/** The store's own rule (`identity-store.ts`), repeated here so a name this
 *  accepts cannot be rejected a moment later by the thing it is typed for. */
const NAME = /^[a-zA-Z0-9_-]+$/;
const ATTEMPTS = 3;
async function until<T>(
  ask: LineReader,
  question: string,
  parse: (answer: string) => T | undefined,
  complaint: string,
  write: (text: string) => void,
): Promise<T> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const value = parse((await ask(question)).trim());
    if (value !== undefined) return value;
    if (attempt < ATTEMPTS) write(`${complaint}\n`);
  }
  throw new Error(`${complaint} — no valid answer after three attempts.`);
}
/**
 * Fills in what `setup-identity --interactive` was not given.
 *
 * `--interactive` used to mean only that the login runs here; `--identity` and
 * `--agent` were still required, so the way a person naturally types the
 * command was answered with "setup-identity requires --identity and --agent".
 * Asking is what "interactive" already implied. Anything passed as a flag is
 * kept as-is and not asked about, so a scripted invocation is unchanged.
 */
export async function promptForMissing(opts: {
  identity?: string;
  agent?: string;
  ask: LineReader;
  write?: (text: string) => void;
}): Promise<{ identity: string; agent: Agent }> {
  const write = opts.write ?? ((text: string) => process.stderr.write(text));
  const identity =
    opts.identity ??
    (await until(
      opts.ask,
      "Identity name: ",
      (answer) => (NAME.test(answer) ? answer : undefined),
      "An identity name is letters, digits, dash or underscore",
      write,
    ));
  const agent =
    (opts.agent as Agent | undefined) ??
    (await until(
      opts.ask,
      `Agent [${AGENTS.join("/")}]: `,
      (answer) =>
        (AGENTS as readonly string[]).includes(answer)
          ? (answer as Agent)
          : undefined,
      `An agent is one of ${AGENTS.join(", ")}`,
      write,
    ));
  return { identity, agent };
}
/** The real terminal. Kept apart from the logic above so the logic needs none. */
export function terminalReader(): LineReader {
  return async (question: string) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}
