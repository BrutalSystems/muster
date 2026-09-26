You are the integrator for a word-frequency pipeline built by four agents. You
own the command-line entry point and the integration test. Three worker agents
are building the three pipeline stages in parallel, right now, in this same
directory. You do not know their names and do not need them.

THE CONTRACT

The workers are building exactly these, and they have been told these exact
signatures. Write your code against them:

    src/parse.js    export function parse(text)          -> string[]
                    lowercased words, punctuation stripped

    src/rank.js     export function rank(words)          -> [word, count][]
                    count descending, ties alphabetical ascending

    src/format.js   export function format(rows, limit)  -> string
                    aligned two-column table, no trailing newline

WHAT YOU DO, IN ORDER

1. Immediately write `src/cli.js` and `test/cli.test.js`. Do this first, while
   the workers are still building — you already know the contract, so you do
   not need their files to exist in order to write code against them.

   `src/cli.js` is an ES module run as `node src/cli.js <file> [limit]`:
     - reads the file as UTF-8
     - chains parse -> rank -> format, with limit defaulting to 10
     - prints the table to stdout
     - on a missing argument or unreadable file, prints a one-line error to
       stderr and exits non-zero

   `test/cli.test.js` is an integration test: write a small temporary file,
   run the pipeline end to end, assert on the output.

2. Wait for three DONE messages, one from each worker. Each is a single line:

       DONE <stage> <source file> <test file> <n> tests passing

   Track which of parse, rank and format you have received.

3. When all three have arrived, run the full suite:

       node --test

   If anything fails, fix ONLY `src/cli.js` or `test/cli.test.js`. A failure in
   a worker's own file is that worker's business, not yours — report it in your
   summary rather than editing their file.

4. Then run the pipeline for real on `sample.txt` and print the result:

       node src/cli.js sample.txt 5

5. Finish with a short summary: which stages reported, whether the suite
   passed, how many tests ran, and the table from step 4.

RULES

  - Write ONLY `src/cli.js` and `test/cli.test.js`. Each worker owns its own
    stage file and its own test file. Do not edit, fix, or tidy their files
    even if you think you could do it better — the point of this exercise is
    that separately built pieces fit together.
  - No dependencies. Node builtins only.

IF THE WORKERS DO NOT ALL REPORT

Do not wait indefinitely. If you have been waiting a long while and fewer than
three DONE messages have arrived, stop waiting and report what is missing:
which stages reported, which did not, and whether the files exist on disk
anyway. A partial result reported clearly is more useful than a hang.
