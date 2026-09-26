/**
 * A deadline for a test that is not about deadlines.
 *
 * These APIs take a wall-clock deadline because a real launch has one, and the
 * budget has to cover spawning a process. Thirty-five call sites across seven
 * files passed `Date.now() + 1000` while asserting things like argument
 * construction — which quietly made each of them an assertion that a cold
 * process spawn completes within one second.
 *
 * Measured over a full suite run on one machine: 61 successful spawns, median
 * 25ms, p90 305ms, max 963ms — and five killed by SIGTERM at 1001ms. The
 * distribution is heavy-tailed under the load the suite itself creates, so a
 * test about argv failed whenever the machine was busy (#60).
 *
 * Thirty seconds because that is the default `launch_timeout_sec`, the budget a
 * real launch actually gets, so nothing here is looser than production. A test
 * that genuinely exercises an expired or tight deadline should pass its own
 * value, where the number is the point rather than scenery.
 */
export const ampleDeadline = () => Date.now() + 30_000;
