import { z } from "zod";
/**
 * Opaque, and free of control characters. The key encoding must never be able
 * to confuse two identities, and a NUL or other control byte inside a field is
 * the way that happens.
 */
const opaqueField = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[ -~]+$/, "must not contain control characters");
export const authoritySchema = opaqueField(200);
export const subjectSchema = opaqueField(400);

/**
 * Who asked for a launch.
 *
 * `authority` names the identity namespace that authenticated `subject`;
 * `subject` is a stable opaque identifier within it. Muster treats both as
 * opaque and hardcodes no namespace, so the spelling an integrator adopts is
 * configuration rather than a Muster release.
 *
 * Muster does not authenticate its caller. Anything able to import Muster or
 * exec its binary already runs as the owner account. The value here is least
 * privilege and honest provenance for a trusted local invoker that has already
 * authenticated a remote peer — not a defence against a compromised same-user
 * process.
 */
export const requesterSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("local"),
      label: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remote"),
      authority: authoritySchema,
      subject: subjectSchema,
      label: z.string().min(1).max(200).optional(),
    })
    .strict(),
]);
export type RequesterId = z.infer<typeof requesterSchema>;
export const LOCAL: RequesterId = { kind: "local" };
/**
 * The policy and quota key. `label` is not a parameter, which is what keeps a
 * caller-chosen display string structurally incapable of affecting policy.
 */
export function requesterKey(r: RequesterId): string {
  return r.kind === "local"
    ? "local"
    : JSON.stringify(["remote", r.authority, r.subject]);
}
/** For humans and log lines only; never a key. */
export function requesterLabel(r: RequesterId): string {
  if (r.label) return r.label;
  return r.kind === "local" ? "local" : `${r.authority}/${r.subject}`;
}
