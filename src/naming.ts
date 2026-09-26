/** Vendored from Tin Can src/naming.ts at b62ca6a719131dbd1b43875fa47604c1c17cd9fb (v1.5.1, MIT).
 * Tin Can's `isSelf` resolution stage is deliberately not carried over: it
 * exists so a Tin Can host does not deliver a message to itself, and Muster
 * resolves peers it launched rather than an identity of its own. No fixture
 * case covers it, so adopting it would be unverifiable here. */
/** Peer naming per the handoff §7: slug for humans, canonical id for the log. */
import type { Runtime } from "./types.js";

export type RuntimeName = "claude-code" | "codex" | "opencode";

export function runtimeName(runtime: Runtime): RuntimeName {
  return runtime === "claude" ? "claude-code" : runtime;
}

export interface PeerBase {
  runtime: RuntimeName;
  /** Harness-supplied name; Codex threads may be unnamed. */
  rawName: string | null;
  /** Thread id (Codex) or session id (Claude Code). */
  uuid: string;
  /**
   * Which machine this peer is on, absent for this one.
   *
   * Absent rather than "localhost" so every address in use today keeps working
   * and keeps meaning the same thing. It also makes the dangerous direction
   * the explicit one: reaching another computer requires saying so.
   */
  machine?: string;
}

export interface NamedPeer extends PeerBase {
  slug: string;
  suffix: string;
  /**
   * Carries the whole durable id, not the three-hex suffix. Two peers sharing
   * a slug whose ids also shared their last three hex characters produced the
   * SAME canonical id, and resolution then refused both — telling the caller
   * to disambiguate with a string that did not disambiguate. Carrying the full
   * id makes that impossible rather than merely unlikely.
   */
  canonicalId: string;
  /** What `peers` shows and `send_peer` accepts: bare slug, suffixed only on collision. */
  display: string;
}

export type Resolution =
  | { ok: true; peer: NamedPeer }
  | { ok: false; reason: "unknown" | "ambiguous"; candidates: string[] };

export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The last three hex characters, not the first. Codex thread ids are UUIDv7:
 * their leading hex is a shared timestamp, so every live thread on a machine
 * starts with the same three characters and a leading suffix disambiguates
 * nothing. The trailing characters are random in both v4 and v7.
 */
export function suffixOf(uuid: string): string {
  return uuid
    .replace(/[^0-9a-f]/gi, "")
    .slice(-3)
    .toLowerCase();
}

/** `@machine`, or nothing at all for a peer on this machine. */
function at(machine: string | undefined): string {
  return machine === undefined || machine === "" ? "" : `@${slugify(machine)}`;
}

export function assignNames(peers: PeerBase[]): NamedPeer[] {
  const slugs = peers.map((peer) => {
    const s = peer.rawName ? slugify(peer.rawName) : "";
    return s.length > 0 ? s : "thread";
  });

  // Collisions are counted per machine. The same slug on two computers is two
  // different addresses already, so suffixing both would add noise to
  // distinguish things that were never confusable.
  const counts = new Map<string, number>();
  for (const [i, s] of slugs.entries()) {
    const key = `${s}${at(peers[i]!.machine)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return peers.map((peer, i) => {
    const slug = slugs[i]!;
    const suffix = suffixOf(peer.uuid);
    const host = at(peer.machine);
    const qualified = `${slug}.${suffix}${host}`;
    // An unnamed thread has no name to stand on, so it always carries its suffix.
    const collides =
      (counts.get(`${slug}${host}`) ?? 0) > 1 || peer.rawName === null;
    return {
      ...peer,
      slug,
      suffix,
      canonicalId: `${peer.runtime}:${slug}.${peer.uuid}${host}`,
      display: collides ? qualified : `${slug}${host}`,
    };
  });
}

export function resolvePeer(peers: NamedPeer[], input: string): Resolution {
  const q = input.trim().toLowerCase();
  const qualified = (p: NamedPeer) => `${p.slug}.${p.suffix}${at(p.machine)}`;

  // A bare address names a peer on THIS machine. Prefix matching is what makes
  // that matter: without this gate an address with no `@` could fall through
  // and resolve to a session on another computer, so a message meant for a
  // peer at this desk would leave the machine and be reported as sent. The
  // dangerous direction has to be the explicit one.
  const wantsMachine = q.includes("@");
  peers = peers.filter((p) => {
    const remote = p.machine !== undefined && p.machine !== "";
    return wantsMachine ? remote : !remote;
  });

  const exact = peers.filter(
    (p) =>
      p.display.toLowerCase() === q ||
      qualified(p) === q ||
      p.canonicalId.toLowerCase() === q,
  );
  if (exact.length === 1) return { ok: true, peer: exact[0]! };
  if (exact.length > 1)
    return { ok: false, reason: "ambiguous", candidates: exact.map(qualified) };

  const prefixed = peers.filter(
    (p) => p.slug.startsWith(q) || qualified(p).startsWith(q),
  );
  if (prefixed.length === 1) return { ok: true, peer: prefixed[0]! };
  if (prefixed.length > 1)
    return {
      ok: false,
      reason: "ambiguous",
      candidates: prefixed.map(qualified),
    };

  return {
    ok: false,
    reason: "unknown",
    candidates: peers.map((p) => p.display),
  };
}
