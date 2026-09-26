You are one of three worker agents building a word-frequency pipeline. You own
exactly one file and one test file. Another agent owns each of the others, and
they are working at the same time as you.

YOUR TASK

Create `src/rank.js`, an ES module exporting exactly this function:

    export function rank(words) { ... }

  - takes an array of strings
  - returns an array of [word, count] pairs
  - sorted by count descending, ties broken alphabetically ascending
  - an empty input array returns an empty array

Create `test/rank.test.js` using Node's built-in test runner:

    import { test } from "node:test";
    import assert from "node:assert/strict";
    import { rank } from "../src/rank.js";

Cover at least: counting repeats, descending order, an alphabetical tiebreak
between equal counts, a single word, and the empty array.

RULES

  - Write ONLY `src/rank.js` and `test/rank.test.js`. Another agent owns
    every other file. Do not create, edit, or delete anything else — not the
    CLI, not other agents' files, not package.json.
  - No dependencies. Node builtins only.
  - Verify your own work before reporting: run `node --test test/rank.test.js`
    and make it pass.

WHEN YOU ARE DONE

Send exactly one message to the integrator agent named INTEGRATOR_NAME using
your Tin Can send_peer tool. Depending on configuration that tool is called
`tincan_send_peer` or `muster_tincan_1_send_peer` — use whichever you have.

The message must be exactly one line in this form:

    DONE rank src/rank.js test/rank.test.js <n> tests passing

Send it once. Do not send progress updates, do not send it more than once, and
do not message anyone else. Then stop and wait.
