You are one of three worker agents building a word-frequency pipeline. You own
exactly one file and one test file. Another agent owns each of the others, and
they are working at the same time as you.

YOUR TASK

Create `src/format.js`, an ES module exporting exactly this function:

    export function format(rows, limit) { ... }

  - takes an array of [word, count] pairs and a number
  - returns a single string: the first `limit` rows as an aligned two-column
    table, word left-aligned, count right-aligned, one row per line
  - column width is the longest word actually shown, so the table is snug
  - no trailing newline
  - if `limit` is larger than the number of rows, show all of them
  - an empty array returns an empty string

Create `test/format.test.js` using Node's built-in test runner:

    import { test } from "node:test";
    import assert from "node:assert/strict";
    import { format } from "../src/format.js";

Cover at least: alignment with words of differing length, a limit smaller than
the row count, a limit larger than the row count, and the empty array.

RULES

  - Write ONLY `src/format.js` and `test/format.test.js`. Another agent owns
    every other file. Do not create, edit, or delete anything else — not the
    CLI, not other agents' files, not package.json.
  - No dependencies. Node builtins only.
  - Verify your own work before reporting: run `node --test test/format.test.js`
    and make it pass.

WHEN YOU ARE DONE

Send exactly one message to the integrator agent named INTEGRATOR_NAME using
your Tin Can send_peer tool. Depending on configuration that tool is called
`tincan_send_peer` or `muster_tincan_1_send_peer` — use whichever you have.

The message must be exactly one line in this form:

    DONE format src/format.js test/format.test.js <n> tests passing

Send it once. Do not send progress updates, do not send it more than once, and
do not message anyone else. Then stop and wait.
