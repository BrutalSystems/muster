import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Muster's own suite is TypeScript under test/. Without this, Vitest's
    // default glob walks the whole repository and picks up sample code shipped
    // in docs/ — those files are `node:test` suites meant to be run by
    // `node --test`, so Vitest loads them, finds no tests, and fails the run.
    include: ["test/**/*.test.ts"],
    // The suite launches real agents through a real terminal host. Without a
    // server and a workspace root of its own it lands on `-L muster` beside a
    // developer's sessions and leaves them there, because a tmux launch is
    // meant to outlive its parent. globalSetup names both before any worker
    // exists and reaps them once every file has finished (#57).
    globalSetup: ["test/global-setup.ts"],
    // Vitest defaults to 5s, which is a budget written for unit tests. This
    // suite spawns real processes through a real terminal host, so a file that
    // sets no explicit timeout was running a multi-second launch inside a 5s
    // cap — fine on an idle machine, and the reason two identity tests failed
    // once while 58 files ran at once. Individual tests still set their own
    // where they mean something tighter.
    testTimeout: 20000,
  },
});
