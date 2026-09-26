import type { Config, RequesterProfile } from "./config.js";
import type { Enforcement } from "./enforcement.js";
import type { Level } from "./guard.js";
import { LOCAL, requesterKey, type RequesterId } from "./requester.js";
import type { Runtime } from "./types.js";
/** A remote tuple with no enrolment. Absence of a grant is a denial. */
export class RequesterNotEnrolled extends Error {
  constructor(
    readonly authority: string,
    readonly subjectPrefix: string,
  ) {
    super(
      `No enrolment for requester ${authority}/${subjectPrefix} — add a [[requesters]] entry to config.toml`,
    );
    this.name = "RequesterNotEnrolled";
  }
}
/**
 * Enrolled, but the request exceeds the profile. `ceiling` is what a transport
 * maps to a stable code, so nothing downstream matches on message text.
 */
export class RequesterPolicyRefusal extends Error {
  constructor(
    readonly ceiling:
      | "roots"
      | "level"
      | "enforcement"
      | "not-expressible-remotely"
      | "not-owner"
      | "identity",
    message: string,
  ) {
    super(message);
    this.name = "RequesterPolicyRefusal";
  }
}
/** The receiver is misconfigured. Not the requester's fault, so not a refusal. */
export class RequesterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequesterConfigError";
  }
}
export type ResolvedRequesterPolicy = {
  /** Absent for a local requester, which has no profile and no ceiling. */
  profile: RequesterProfile | undefined;
  level: Level | undefined;
  minEnforcement: "kernel" | "tool-policy" | undefined;
  logMode: "full" | "metadata";
  /** Absent for a local requester, which has no profile and no ceiling. */
  identities: string[] | undefined;
};
/** Ordered weakest to strongest, so a ceiling is one index comparison. */
const LEVEL_ORDER: Level[] = ["read", "work", "open"];
const GRADE_ORDER: Enforcement[] = ["none", "tool-policy", "kernel"];
export function resolveRequesterPolicy(
  requester: RequesterId,
  config: Config,
): ResolvedRequesterPolicy {
  if (requester.kind === "local")
    return {
      profile: undefined,
      level: undefined,
      minEnforcement: undefined,
      logMode: "full",
      identities: undefined,
    };
  const enrolment = config.requesters.find(
    (e) =>
      e.authority === requester.authority && e.subject === requester.subject,
  );
  if (!enrolment)
    throw new RequesterNotEnrolled(
      requester.authority,
      requester.subject.slice(0, 4),
    );
  const profile = config.requester_profiles[enrolment.profile];
  if (!profile)
    throw new RequesterConfigError(
      `Enrolment ${enrolment.authority}/${enrolment.subject} names unknown profile ${enrolment.profile}`,
    );
  return {
    profile,
    level: profile.level,
    minEnforcement: profile.min_enforcement,
    // Not a profile setting: the exposure is the receiver's to carry and the
    // requester's to avoid, so a profile may not opt into full logging.
    logMode: "metadata",
    identities: profile.identities,
  };
}
export function assertLevelWithinCeiling(
  requested: Level,
  policy: ResolvedRequesterPolicy,
): void {
  if (!policy.level) return;
  if (LEVEL_ORDER.indexOf(requested) > LEVEL_ORDER.indexOf(policy.level))
    throw new RequesterPolicyRefusal(
      "level",
      `Level ${requested} exceeds this requester's ceiling of ${policy.level}`,
    );
}
/**
 * May this requester act on this entry?
 *
 * Asymmetric on purpose. A local requester is the operator and may stop or read
 * anything on the machine. A remote requester may act only on launches it asked
 * for — an entry with no recorded requester predates the field and reads as
 * local, so it is protected rather than open.
 */
export function assertMayAct(
  entry: { requester?: RequesterId },
  requester: RequesterId,
): void {
  if (requester.kind === "local") return;
  if (requesterKey(entry.requester ?? LOCAL) !== requesterKey(requester))
    throw new RequesterPolicyRefusal(
      "not-owner",
      "this launch belongs to a different requester",
    );
}
export function assertEnforcementMeetsMinimum(
  runtime: Runtime,
  grade: Enforcement,
  policy: ResolvedRequesterPolicy,
): void {
  if (!policy.minEnforcement) return;
  if (GRADE_ORDER.indexOf(grade) < GRADE_ORDER.indexOf(policy.minEnforcement))
    throw new RequesterPolicyRefusal(
      "enforcement",
      `Runtime ${runtime} offers ${grade} enforcement and this requester requires ${policy.minEnforcement}`,
    );
}

/**
 * Bound, do not pin — the same shape as allowed_roots, level and
 * min_enforcement. A local requester is the operator and may name anything.
 */
export function resolveIdentityForRequest(
  requested: string | undefined,
  policy: ResolvedRequesterPolicy,
): string | undefined {
  if (!policy.identities) return requested;
  const granted = policy.identities;
  if (requested) {
    if (!granted.includes(requested))
      throw new RequesterPolicyRefusal(
        "identity",
        granted.length
          ? `identity ${requested} is not granted to this requester (granted: ${granted.join(", ")})`
          : `this requester is granted no identity, so it may not name one`,
      );
    return requested;
  }
  if (granted.length === 1) return granted[0];
  if (granted.length > 1)
    throw new RequesterPolicyRefusal(
      "identity",
      `this requester must name one of: ${granted.join(", ")}`,
    );
  return undefined;
}
