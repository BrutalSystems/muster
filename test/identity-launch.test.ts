import {
  writeFile,
  readFile,
  realpath,
  mkdir,
  symlink,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { expect, test } from "vitest";
import { Muster } from "../src/run.js";
import { IdentityError, identityPath } from "../src/identity-store.js";
import { setupIdentity } from "../src/identity-cli.js";
import { fixture, lines } from "./helpers.js";

async function withIdentity(agent: "codex" | "claude", tokenEnv?: string) {
  const f = await fixture();
  await writeFile(join(f.home, "config.toml"), "launch_timeout_sec = 10\n");
  await setupIdentity({
    home: f.home,
    name: "id1",
    agent,
    ...(tokenEnv ? { tokenEnv } : {}),
  });
  const dir = identityPath(f.home, "id1");
  await writeFile(join(dir, "auth.json"), "{}");
  await writeFile(join(dir, "config.toml"), "# codex\n");
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ projects: {} }));
  return { f, dir, m: await Muster.create({ home: f.home, env: f.env }) };
}

test("a launch under an identity gets that agent's config variable", async () => {
  const { f, m } = await withIdentity("codex");
  try {
    await m.run({
      runtime: "codex",
      prompt: "hi",
      cwd: f.root,
      identity: "id1",
    });
    const [start] = await lines(join(f.root, "starts.jsonl"));
    const [entry] = await m.registry.all();
    // The copy is named after the launch id, not the agent's own session id: a
    // session record carries thread_id/session_id and no `id` field at all.
    expect(start.env.CODEX_HOME).toBe(
      join(f.home, "identities-live", entry!.launchId),
    );
    expect(entry!.identityPath).toBe(start.env.CODEX_HOME);
  } finally {
    await m.close();
  }
});

test("the resolved identity name is recorded on the entry and in the intent log", async () => {
  // The feature's stated purpose is that a launch STATES which account it ran
  // as. identityPath is keyed by launch id and its directory is removed at
  // cleanup, and it never named the account; without this nothing afterwards
  // says which one it was — least of all for a remote requester that took a
  // profile's single-identity default without naming one.
  const { f, m } = await withIdentity("codex");
  try {
    await m.run({
      runtime: "codex",
      prompt: "hi",
      cwd: f.root,
      identity: "id1",
    });
    const [entry] = await m.registry.all();
    expect(entry!.identity).toBe("id1");
    const intent = (await lines(join(f.home, "launches.jsonl"))).find(
      (l) => l.event === "intent",
    );
    expect(intent!.identity).toBe("id1");
  } finally {
    await m.close();
  }
});

test("a launch without an identity records no identity anywhere", async () => {
  const { f, m } = await withIdentity("codex");
  try {
    await m.run({ runtime: "codex", prompt: "hi", cwd: f.root });
    const [entry] = await m.registry.all();
    expect(entry!.identity).toBeUndefined();
    const intent = (await lines(join(f.home, "launches.jsonl"))).find(
      (l) => l.event === "intent",
    );
    expect("identity" in intent!).toBe(false);
  } finally {
    await m.close();
  }
});

test("a launch without an identity sets no config variable and no copy", async () => {
  const { f, m } = await withIdentity("codex");
  try {
    await m.run({ runtime: "codex", prompt: "hi", cwd: f.root });
    const [start] = await lines(join(f.root, "starts.jsonl"));
    expect(start.env.CODEX_HOME).toBe(f.env.CODEX_HOME);
    const [entry] = await m.registry.all();
    expect(entry!.identityPath).toBeUndefined();
  } finally {
    await m.close();
  }
});

test("an unknown identity reserves nothing", async () => {
  const { f, m } = await withIdentity("codex");
  try {
    await expect(
      m.run({ runtime: "codex", prompt: "hi", cwd: f.root, identity: "nope" }),
    ).rejects.toThrow(IdentityError);
    expect(await m.registry.all()).toHaveLength(0);
  } finally {
    await m.close();
  }
});

test("an identity whose agent does not match the runtime is refused", async () => {
  const { f, m } = await withIdentity("codex");
  try {
    await expect(
      m.run({ runtime: "claude", prompt: "hi", cwd: f.root, identity: "id1" }),
    ).rejects.toThrow(/codex/);
    expect(await m.registry.all()).toHaveLength(0);
  } finally {
    await m.close();
  }
});

test("a claude identity with no token_env is refused, reserving nothing", async () => {
  // The route the docs used to teach first: log in interactively and the
  // keychain holds a credential for the TEMPLATE's path. A launch runs from a
  // copy, which hashes to a service name that does not exist, so that identity
  // could copy, spawn a real agent and die at the deadline while `identities`
  // called it configured. Refused before anything is reserved instead.
  //
  // With no token_env declared the identity resolves to the file route, and
  // with no stored token either, the refusal now names `setup-identity
  // --interactive` — the route this identity actually has open to it.
  const { f, m } = await withIdentity("claude");
  try {
    await expect(
      m.run({ runtime: "claude", prompt: "hi", cwd: f.root, identity: "id1" }),
    ).rejects.toThrow(/setup-identity --interactive/);
    expect(await m.registry.all()).toHaveLength(0);
  } finally {
    await m.close();
  }
});

test("the remedy path: setup-identity --token-env fixes a refused claude launch", async () => {
  // Issue #59: the error names the exact command to run, and running it used
  // to be a no-op because setup-identity only wrote metadata for a directory
  // it had just created. This is the full loop the error promises works.
  const { f, m } = await withIdentity("claude");
  await expect(
    m.run({ runtime: "claude", prompt: "hi", cwd: f.root, identity: "id1" }),
  ).rejects.toThrow(/setup-identity --interactive/);
  await setupIdentity({
    home: f.home,
    name: "id1",
    agent: "claude",
    tokenEnv: "TOKV",
  });
  const m2 = await Muster.create({
    home: f.home,
    env: { ...f.env, TOKV: "sk-test" },
  });
  await m.close();
  try {
    // The point is that the earlier refusal is gone: if it rejects for the
    // same reason, this throws and fails the test.
    await m2.run({
      runtime: "claude",
      prompt: "hi",
      cwd: f.root,
      identity: "id1",
    });
  } finally {
    await m2.close();
  }
});

test("a claude identity whose token variable is unset reserves nothing", async () => {
  const { f, m } = await withIdentity("claude", "MISSING_TOKEN_VAR");
  try {
    await expect(
      m.run({ runtime: "claude", prompt: "hi", cwd: f.root, identity: "id1" }),
    ).rejects.toThrow(/MISSING_TOKEN_VAR/);
    expect(await m.registry.all()).toHaveLength(0);
  } finally {
    await m.close();
  }
});

test("a claude launch trusts its cwd in the copy, leaving the template alone", async () => {
  const { f, dir, m } = await withIdentity("claude", "TOKV");
  const m2 = await Muster.create({
    home: f.home,
    env: { ...f.env, TOKV: "sk-test" },
  });
  await m.close();
  // A symlink to the launch directory, made by the test itself rather than
  // relied on from the OS temp directory: on macOS /tmp is already a symlink
  // (/var -> /private/var) and this precondition held by accident, but on
  // Linux /tmp is a real directory and the same assertion was vacuous. Making
  // the symlink here means the resolved-vs-as-spelled distinction genuinely
  // holds on every platform.
  const link = `${f.root}-link`;
  await symlink(f.root, link);
  try {
    await m2.run({
      runtime: "claude",
      prompt: "hi",
      cwd: link,
      identity: "id1",
    });
    const [launched] = await m2.registry.all();
    const copy = join(f.home, "identities-live", launched!.launchId);
    expect(launched!.identityPath).toBe(copy);
    const inCopy = JSON.parse(
      await readFile(join(copy, ".claude.json"), "utf8"),
    );
    // Keyed by the RESOLVED path: Claude looks this up by what its own
    // getcwd(2) returns. A key written as the caller spelled it (the symlink)
    // would never be found.
    const resolved = await realpath(link);
    expect(resolved).not.toBe(link); // the fixture genuinely exercises this
    expect(inCopy.projects[resolved].hasTrustDialogAccepted).toBe(true);
    expect(inCopy.projects[link]).toBeUndefined();
    const template = JSON.parse(
      await readFile(join(dir, ".claude.json"), "utf8"),
    );
    expect(template.projects[resolved]).toBeUndefined();
    expect(template.projects[link]).toBeUndefined();
    const [start] = await lines(join(f.root, "starts.jsonl"));
    expect(start.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-test");
  } finally {
    await m2.close();
  }
});

test("an identity launch RESOLVES — the proof that discovery follows the copy", async () => {
  // This is the assertion that would have caught the original design error.
  // The agent records its session inside the copy; if resolution still looked at
  // hostEnv's location, this launch would reserve an entry, spawn a real runtime,
  // and then fail its whole deadline. A record coming back at all is the proof.
  const { f, m } = await withIdentity("codex");
  try {
    const rec = (await m.run({
      runtime: "codex",
      prompt: "hi",
      cwd: f.root,
      identity: "id1",
    })) as { thread_id?: string; state?: string };
    // A resolved thread id is the proof: it can only come from a writer lock
    // found inside the copy.
    expect(rec.thread_id).toBeTruthy();
    const [entry] = await m.registry.all();
    expect(entry!.status).toBe("running");
    expect(entry!.identityPath).toBeTruthy();
  } finally {
    await m.close();
  }
});

test("muster's own helpers are still spawned with hostEnv, not the copy", async () => {
  // A version probe or RPC connection pointed at a per-launch copy answers the
  // wrong question. The fixture's fake runtime needs MUSTER_FAKE_ROOT to work at
  // all, and that lives in hostEnv only — so a launch succeeding proves the
  // helpers saw hostEnv.
  const { f, m } = await withIdentity("codex");
  try {
    await m.run({
      runtime: "codex",
      prompt: "hi",
      cwd: f.root,
      identity: "id1",
    });
    const [entry] = await m.registry.all();
    expect(entry!.status).toBe("running");
    expect(entry!.error).toBeUndefined();
  } finally {
    await m.close();
  }
});

test("listing re-resolves a running identity session against its own copy", async () => {
  // refreshed() runs long after the launch and has only the entry in scope, so
  // it derives the resolution environment from entry.identityPath + runtime. If
  // it used hostEnv instead, every identity session would list as unreachable
  // while being perfectly healthy.
  const { f, m } = await withIdentity("claude", "TOKV");
  const m2 = await Muster.create({
    home: f.home,
    env: { ...f.env, TOKV: "sk-test" },
  });
  await m.close();
  try {
    await m2.run({
      runtime: "claude",
      prompt: "hi",
      cwd: f.root,
      identity: "id1",
    });
    const [listed] = await m2.list("session");
    expect(listed.state).toBe("idle");
  } finally {
    await m2.close();
  }
});

test("one request key across two identities raises rather than dedupes", async () => {
  // The end-to-end half of the fingerprint fix: proof that the launch path
  // hands paramsFingerprint the identity that determined the account, not just
  // that the hash would differ if it did.
  const { f, m } = await withIdentity("codex");
  await setupIdentity({ home: f.home, name: "id2", agent: "codex" });
  const other = identityPath(f.home, "id2");
  await writeFile(join(other, "auth.json"), "{}");
  await writeFile(join(other, "config.toml"), "# codex\n");
  try {
    await m.run({
      runtime: "codex",
      prompt: "hi",
      cwd: f.root,
      identity: "id1",
      requestKey: "k",
    });
    await expect(
      m.run({
        runtime: "codex",
        prompt: "hi",
        cwd: f.root,
        identity: "id2",
        requestKey: "k",
      }),
    ).rejects.toThrow(/different parameters/i);
    // The same key with the same identity still dedupes, so the refusal above
    // is about the identity and not about keys in general.
    const again = await m.run({
      runtime: "codex",
      prompt: "hi",
      cwd: f.root,
      identity: "id1",
      requestKey: "k",
    });
    expect((again as { thread_id?: string }).thread_id).toBeTruthy();
    expect(await lines(join(f.root, "starts.jsonl"))).toHaveLength(1);
  } finally {
    await m.close();
  }
});

test("a codex identity session reads as reachable, not merely locatable", async () => {
  // The writer lock and the thread's rollout are two different places. Pointing
  // discovery at the copy while the app-server that READS the thread stays on
  // the host is the same failure one call downstream: `rejectionOf` gets "no
  // rollout found for thread id", every candidate is rejected, and the launch
  // burns its deadline. A resolved thread id plus an idle state at launch and
  // again in the listing is the proof that discovery, the readiness read and
  // refreshed() all follow the copy.
  const { f, m } = await withIdentity("codex");
  try {
    const rec = (await m.run({
      runtime: "codex",
      prompt: "hi",
      cwd: f.root,
      identity: "id1",
    })) as { thread_id?: string; state?: string };
    expect(rec.thread_id).toBeTruthy();
    expect(rec.state).toBe("idle");
    const [listed] = await m.list("session");
    expect(listed.state).toBe("idle");
  } finally {
    await m.close();
  }
});

test("resolution follows a config home delivered by a profile's env_defaults", async () => {
  // A requester profile's `env_defaults` delivers ANY key by design, so a profile
  // setting CODEX_HOME (or CLAUDE_CONFIG_DIR) hands the agent one configuration
  // home while resolution searched the host's — reserve, spawn, dead at the
  // deadline, with the launch reporting the opposite of what happened. Deriving
  // the resolution environment from `identityPath` alone could not see it,
  // because there is no identity here at all.
  const f = await fixture();
  const alt = join(f.root, "profile-codex");
  await mkdir(alt, { recursive: true });
  await writeFile(
    join(f.home, "config.toml"),
    `launch_timeout_sec = 6

[requester_profiles.research]
allowed_roots = ["/"]
env_allow = ["MUSTER_FAKE_ROOT", "MUSTER_FAKE_PYTHON", "MUSTER_TEST_HOME"]

[requester_profiles.research.env_defaults]
LANG = "en_US.UTF-8"
CODEX_HOME = ${JSON.stringify(alt)}

[[requesters]]
authority = "example.peer.v1"
subject = "abc"
profile = "research"
`,
  );
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    // A record coming back at all is the proof: the agent wrote its thread under
    // the profile's CODEX_HOME, so resolution had to look there.
    const rec = (await m.run(
      { runtime: "codex", prompt: "hi", cwd: f.root },
      { kind: "remote", authority: "example.peer.v1", subject: "abc" },
    )) as { thread_id?: string };
    expect(rec.thread_id).toBeTruthy();
    const [entry] = await m.registry.all();
    // Persisted, so `refreshed()` keeps agreeing with the launch rather than
    // re-deriving from a value that was never the agent's.
    expect(entry!.configHome).toBe(alt);
    expect(entry!.identityPath).toBeUndefined();
    const [start] = await lines(join(f.root, "starts.jsonl"));
    expect(start.env.CODEX_HOME).toBe(alt);
    // And a listing still reports it reachable, not unreachable.
    const [listed] = await m.list("session");
    expect(listed.state).toBe("idle");
  } finally {
    await m.close();
  }
});

test("a launch with neither an identity nor an override records no config home", async () => {
  const { f, m } = await withIdentity("codex");
  try {
    await m.run({ runtime: "codex", prompt: "hi", cwd: f.root });
    const [entry] = await m.registry.all();
    expect(entry!.configHome).toBeUndefined();
  } finally {
    await m.close();
  }
});

test("a Codex identity launch trusts the resolved launch directory in the copy", async () => {
  // Codex's own gate, and the reason every real Codex identity launch failed:
  // with no [projects."<dir>"] trust_level = "trusted" in the config.toml it
  // reads, the TUI sits on "Do you trust the contents of this directory?" and
  // never opens a thread, so there is no thread-writer lock to discover. The
  // fake runtime shows no such prompt, so only this assertion catches it.
  const { f, dir, m } = await withIdentity("codex");
  // Made by the test rather than relied on from the OS temp directory, for the
  // same reason the Claude case does it: on Linux /tmp is a real directory and
  // the resolved-vs-as-spelled distinction would hold by accident only on macOS.
  const link = `${f.root}-codex-link`;
  await symlink(f.root, link);
  try {
    await m.run({ runtime: "codex", prompt: "hi", cwd: link, identity: "id1" });
    const [launched] = await m.registry.all();
    const copy = join(f.home, "identities-live", launched!.launchId);
    const inCopy: any = TOML.parse(
      await readFile(join(copy, "config.toml"), "utf8"),
    );
    const resolved = await realpath(link);
    expect(resolved).not.toBe(link); // the fixture genuinely exercises this
    expect(inCopy.projects[resolved].trust_level).toBe("trusted");
    expect(inCopy.projects[link]).toBeUndefined();
    // The template is never rewritten: it is shared by every launch under this
    // identity, and one launch's directory is not another's grant.
    expect(await readFile(join(dir, "config.toml"), "utf8")).toBe("# codex\n");
  } finally {
    await m.close();
  }
});

test("a launch under a stored-token identity carries the token and copies no token file", async () => {
  const { f, m } = await withIdentity("claude");
  const { storeIdentityToken } = await import("../src/identity-cli.js");
  await storeIdentityToken({ home: f.home, name: "id1", token: "sk-stored" });
  try {
    await m.run({
      runtime: "claude",
      prompt: "hi",
      cwd: f.root,
      identity: "id1",
    });
    const [start] = await lines(join(f.root, "starts.jsonl"));
    expect(start.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-stored");
    const [entry] = await m.registry.all();
    const copy = join(f.home, "identities-live", entry!.launchId);
    // The regression test for a discarded draft of this design, which copied the
    // token into every launch. Claude reads the token from the environment and
    // never from a file, so the copy bought nothing and wrote a year-long secret
    // to disk on every launch.
    await expect(stat(join(copy, "token"))).rejects.toThrow();
  } finally {
    await m.close();
  }
});

test("a claude identity with neither route is refused before anything is reserved", async () => {
  const { f, m } = await withIdentity("claude");
  try {
    await expect(
      m.run({ runtime: "claude", prompt: "hi", cwd: f.root, identity: "id1" }),
    ).rejects.toThrow(/setup-identity --interactive/);
    expect(await m.registry.all()).toHaveLength(0);
  } finally {
    await m.close();
  }
});
