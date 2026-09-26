You are one of three worker agents building a word-frequency pipeline. You own
exactly one file and one test file. Another agent owns each of the others, and
they are working at the same time as you.

YOUR TASK

Create `src/parse.js`, an ES module exporting exactly this function:

    export function parse(text) { ... }

  - takes a string
  - returns an array of lowercased words with punctuation stripped
  - splits on any run of non-letter characters
  - drops empty strings
  - apostrophes inside a word are kept: "don't" stays one word "don't"

Create `test/parse.test.js` using Node's built-in test runner:

    import { test } from "node:test";
    import assert from "node:assert/strict";
    import { parse } from "../src/parse.js";

Cover at least: ordinary prose, mixed case, punctuation between words,
an apostrophe inside a word, and the empty string.

RULES

  - Write ONLY `src/parse.js` and `test/parse.test.js`. Another agent owns
    every other file. Do not create, edit, or delete anything else — not the
    CLI, not other agents' files, not package.json.
  - No dependencies. Node builtins only.
  - Verify your own work before reporting: run `node --test test/parse.test.js`
    and make it pass.

WHEN YOU ARE DONE

Send exactly one message to the integrator agent named INTEGRATOR_NAME using
your Tin Can send_peer tool. Depending on configuration that tool is called
`tincan_send_peer` or `muster_tincan_1_send_peer` — use whichever you have.

The message must be exactly one line in this form:

    DONE parse src/parse.js test/parse.test.js <n> tests passing

Send it once. Do not send progress updates, do not send it more than once, and
do not message anyone else. Then stop and wait.
