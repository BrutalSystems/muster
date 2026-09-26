import { identityAuthState, type AuthState } from "./identity-auth.js";
import {
  IdentityError,
  identityDirExists,
  identityMetaSchema,
  identityNameSchema,
  identityPath,
  listIdentities,
  readIdentity,
  writeIdentity,
  type IdentityMeta,
} from "./identity-store.js";
import {
  readStoredToken,
  removeStoredToken,
  writeStoredToken,
} from "./identity-token.js";
import {
  captureClaudeToken,
  redactToken,
  type CaptureInput,
  resolveOnPath,
} from "./identity-login.js";
/**
 * The one-time login for each agent. Muster never performs it: each is an
 * interactive OAuth flow, and a command that appeared to do it for you would be
 * hiding a credential prompt.
 */
function loginCommand(agent: IdentityMeta["agent"], dir: string): string {
  if (agent === "claude")
    // setup-token first, and not as an alternative: a launch runs from a COPY of
    // this directory, and the keychain credential an interactive /login writes is
    // keyed to THIS path, so it cannot be reached from a copy. Only a token can.
    return `CLAUDE_CONFIG_DIR=${dir} claude setup-token    # then export the token and pass --token-env`;
  if (agent === "codex") return `CODEX_HOME=${dir} codex login`;
  return `OPENCODE_CONFIG_DIR=${dir} opencode auth login`;
}
export async function setupIdentity(opts: {
  home: string;
  name: string;
  agent: IdentityMeta["agent"];
  tokenEnv?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  created: boolean;
  path: string;
  login: string;
  auth: { state: AuthState; detail: string };
  clearedRoute?: string;
}> {
  const name = identityNameSchema.parse(opts.name);
  // token_env is consumed ONLY by `resolveCredential`, which both
  // `identityAuthState` and the launch path reach exclusively from their Claude
  // branch — and the launch path refuses when the named variable is unset. So on
  // a codex or opencode identity, where the credential is an auth file the
  // agent's own login writes into the template, it has exactly one effect: a new
  // way to fail. Refused where the operator types it.
  // Checked against undefined, not truthiness: `--token-env ""` is falsy, so a
  // truthiness test let an empty name past every guard and then dropped it,
  // leaving the identity on neither credential route without saying so (#69).
  if (opts.tokenEnv !== undefined && opts.tokenEnv.trim() === "")
    throw new IdentityError(
      opts.name,
      "--token-env takes the name of an environment variable holding the token, not the token and not an empty value",
    );
  if (opts.tokenEnv !== undefined && opts.agent !== "claude")
    throw new IdentityError(
      name,
      `--token-env applies only to a claude identity; ${opts.agent} authenticates from an auth file in the template, and a token variable here would only add a way for the launch to fail`,
    );
  // Distinguish "no such identity" from "an identity that is there but unusable".
  // Overwriting the second would silently repurpose a directory that still holds
  // another agent's credential.
  const present = await identityDirExists(opts.home, name);
  let created = true;
  let existing: IdentityMeta | undefined;
  if (present) {
    created = false;
    existing = await readIdentity(opts.home, name); // throws if unusable
    if (existing.agent !== opts.agent)
      throw new IdentityError(
        name,
        `already exists for agent ${existing.agent}; refusing to repurpose it for ${opts.agent}`,
      );
  }
  // An operator who passes --token-env means it to take effect, even on an
  // identity that already has one recorded — that's the whole point of this
  // command's remedy path (see issue #59). Omitting the flag on a re-run must
  // leave whatever is recorded alone, which is why this only fires when a
  // value was actually supplied and it differs from what's already there.
  const tokenEnvChanged =
    opts.tokenEnv !== undefined && opts.tokenEnv !== existing?.token_env;
  const meta = identityMetaSchema.parse({
    agent: opts.agent,
    // Preserve the original creation timestamp for an existing identity;
    // only a brand-new directory gets a fresh one.
    created: existing?.created ?? new Date().toISOString(),
    ...(opts.tokenEnv !== undefined
      ? { token_env: opts.tokenEnv }
      : existing?.token_env
        ? { token_env: existing.token_env }
        : {}),
  });
  // One route per identity. An operator naming a variable has chosen the env
  // route, so a stored token is now dead weight. Order matters: remove the
  // stale token BEFORE recording the env route. If removal fails, the identity
  // holds neither route and reports not-configured — the operator re-runs and
  // succeeds. Writing first fails worse: both routes coexist on the failure
  // path, with a secret at rest that nothing reads.
  let clearedRoute: string | undefined;
  if (opts.tokenEnv !== undefined && (await removeStoredToken(opts.home, name)))
    clearedRoute = `removed this identity's stored token; ${opts.tokenEnv} is now its credential`;
  if (created || tokenEnvChanged) await writeIdentity(opts.home, name, meta);
  const current = await readIdentity(opts.home, name);
  const dir = identityPath(opts.home, name);
  return {
    created,
    path: dir,
    login: loginCommand(current.agent, dir),
    auth: await identityAuthState(
      opts.home,
      name,
      current,
      opts.env ?? process.env,
    ),
    ...(clearedRoute ? { clearedRoute } : {}),
  };
}
/**
 * Store a token as this identity's credential, and clear the other route.
 *
 * Clearing is not tidiness. An identity left with both a stored token and a
 * declared `token_env` has an account that depends on whether a variable
 * happens to be exported — exactly the defect storing the token exists to
 * remove.
 */
export async function storeIdentityToken(opts: {
  home: string;
  name: string;
  token: string;
}): Promise<{ clearedRoute?: string }> {
  const name = identityNameSchema.parse(opts.name);
  const meta = await readIdentity(opts.home, name); // throws if unusable
  if (meta.agent !== "claude")
    throw new IdentityError(
      name,
      `a token applies only to a claude identity; ${meta.agent} authenticates from an auth file its own login writes into the template`,
    );
  // Order matters, and not for tidiness. If the token were written first and
  // clearing token_env then failed, the identity would hold BOTH routes — and
  // `resolveCredential` prefers the env route, so the token just stored would be
  // silently ignored while the command reported success. Clearing first fails
  // the other way: an identity with neither route, which reports
  // `not-configured` and tells the operator exactly what to do.
  let clearedRoute: string | undefined;
  if (meta.token_env) {
    const { token_env: cleared, ...rest } = meta;
    await writeIdentity(opts.home, name, identityMetaSchema.parse(rest));
    clearedRoute = `cleared token_env ${cleared}; this identity now uses its stored token`;
  }
  await writeStoredToken(opts.home, name, opts.token);
  return clearedRoute ? { clearedRoute } : {};
}

export async function describeIdentities(
  home: string,
  env: NodeJS.ProcessEnv,
  /** Profile grants, so stale ones surface without a launch having to fail. */
  grants: Record<string, string[]> = {},
): Promise<{
  identities: {
    name: string;
    agent: IdentityMeta["agent"];
    auth: { state: AuthState; detail: string };
  }[];
  staleGrants: { profile: string; identity: string }[];
}> {
  const found = await listIdentities(home);
  const identities = [];
  for (const { name, meta } of found)
    identities.push({
      name,
      agent: meta.agent,
      auth: await identityAuthState(home, name, meta, env),
    });
  // A profile granting an identity that does not exist is a misconfiguration.
  // It is deliberately NOT checked in loadConfig: Muster reads its config for
  // every command, so failing there would stop `list` and `stop` working and
  // turn a stale grant into a total outage.
  const names = new Set(found.map((i) => i.name));
  const staleGrants = [];
  for (const [profile, granted] of Object.entries(grants))
    for (const identity of granted)
      if (!names.has(identity)) staleGrants.push({ profile, identity });
  return { identities, staleGrants };
}

/**
 * The guided path: create the identity, run its login, store what comes back.
 *
 * `isTTY`, `write`, `env` and `stdin` are parameters rather than direct reads of
 * `process` so the whole shipped path — refusal, capture, storage and note — is
 * testable without a terminal, with a fake `claude` on `env.PATH`.
 */
export async function interactiveSetup(opts: {
  home: string;
  name: string;
  agent: IdentityMeta["agent"];
  isTTY: boolean;
  write?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  stdin: CaptureInput;
}): Promise<{ path: string; stored: boolean; note: string }> {
  const write = opts.write ?? ((t: string) => process.stdout.write(t));
  if (!opts.isTTY)
    throw new IdentityError(
      opts.name,
      "interactive setup needs a terminal; run it yourself, or use --token-env for an unattended machine",
    );
  const created = await setupIdentity({
    home: opts.home,
    name: opts.name,
    agent: opts.agent,
  });
  if (opts.agent !== "claude")
    return {
      path: created.path,
      stored: false,
      note: `Run this once, then check with \`muster identities\`:\n\n    ${created.login}\n`,
    };
  // Asked before anything is spawned, so "could not be started" is a fact about
  // the filesystem rather than an inference from what the child printed. That
  // inference was platform-dependent: a missing executable emits nothing under
  // macOS and an error into the pty under Linux (#69).
  if (!(await resolveOnPath("claude", opts.env ?? process.env)))
    throw new IdentityError(
      opts.name,
      "`claude` is not on PATH, so the login could not be started; nothing was changed",
    );
  write(`Running: claude setup-token\n${"─".repeat(50)}\n`);
  const result = await captureClaudeToken({
    dir: created.path,
    env: opts.env ?? process.env,
    onData: write,
    stdin: opts.stdin,
  });
  write(`${"─".repeat(50)}\n`);
  // Checked BEFORE the token branch, deliberately: a login that failed writes
  // no credential even if something token-shaped went past on the way down.
  //
  // Two different events land here and they need different explanations. node-pty
  // does not throw for a missing executable — it exits 1 having emitted zero
  // bytes — which is exactly the exit shape of a login that failed on its own or
  // that the operator interrupted. The exit code cannot tell them apart; whether
  // anything was ever printed can (#69).
  if (result.exitCode !== 0)
    throw new IdentityError(
      opts.name,
      `\`claude setup-token\` ended without storing a credential (exit ${result.exitCode}); its own output above is the error. If you interrupted it, nothing was stored and nothing was changed.`,
    );
  if (result.token) {
    const { clearedRoute } = await storeIdentityToken({
      home: opts.home,
      name: opts.name,
      token: result.token,
    });
    return {
      path: created.path,
      stored: true,
      note:
        `Token captured and stored (${redactToken(result.token)}). It was not printed here.` +
        (clearedRoute ? `\n${clearedRoute}` : ""),
    };
  }
  // Exit 0 and no match: the login worked and its output format changed. Fails
  // open, so the token is above in clear and the operator has it.
  //
  // The one thing this must NOT say is "run --interactive again": a second run
  // performs a second `claude setup-token` and mints a DIFFERENT token, so it
  // can never store the one already in the scrollback. `--token-env` is the
  // only route that can record it.
  return {
    path: created.path,
    stored: false,
    note: `Muster could not recognise a token in that output, so nothing was stored — but the login itself succeeded, and the token is above in clear. Record it by naming the variable that holds it:\n\n    export CLAUDE_TOKEN=<the token above>\n    muster setup-identity --identity ${opts.name} --agent claude --token-env CLAUDE_TOKEN\n`,
  };
}
