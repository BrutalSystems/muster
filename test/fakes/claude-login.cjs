#!/usr/bin/env node
// Stands in for `claude setup-token`. MUSTER_FAKE_LOGIN selects the transcript.
const mode = process.env.MUSTER_FAKE_LOGIN || "ok";
process.stdout.write(
  "This will guide you through long-lived auth token setup.\r\n",
);
process.stdout.write("Opening browser...\r\n");
if (mode === "changed") {
  // The same secret, in a shape the pattern does not match.
  process.stdout.write("token: OAT!p41NahlJ8bCAJSEdz\r\n");
} else if (mode === "ok") {
  process.stdout.write("Your OAuth token (valid for 1 year):\r\n");
  process.stdout.write(
    "sk-ant-oat01-p41NahlJ8bCAJSEdzNOUhzVv24PC31Z-H-wdnlcsZQyWQ1XQvE-w28zZc6ao56HKjEep_dmNKjBHh\r\n",
  );
} else if (mode === "ok-fail") {
  // A token printed by a login that then fails. Nothing may be stored: the
  // spec's table says a non-zero exit writes no credential.
  process.stdout.write("Your OAuth token (valid for 1 year):\r\n");
  process.stdout.write(
    "sk-ant-oat01-p41NahlJ8bCAJSEdzNOUhzVv24PC31Z-H-wdnlcsZQyWQ1XQvE-w28zZc6ao56HKjEep_dmNKjBHh\r\n",
  );
  process.stdout.write("...but then something went wrong.\r\n");
  process.exit(3);
} else if (mode === "echo-env") {
  process.stdout.write(
    "CLAUDE_CONFIG_DIR=" + process.env.CLAUDE_CONFIG_DIR + "\r\n",
  );
} else if (mode === "fail") {
  process.stdout.write("Login failed.\r\n");
  process.exit(3);
}
process.exit(0);
