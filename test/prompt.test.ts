import { test, expect } from "vitest";
import { promptForMissing } from "../src/prompt.js";

/** A scripted terminal: the questions asked are the assertion, not a mock. */
const scripted = (...answers: string[]) => {
  const asked: string[] = [];
  let next = 0;
  return {
    asked,
    ask: async (question: string) => {
      asked.push(question);
      return answers[next++] ?? "";
    },
  };
};

test("it asks for both when neither was passed", async () => {
  const s = scripted("work", "claude");
  expect(await promptForMissing({ ask: s.ask })).toEqual({
    identity: "work",
    agent: "claude",
  });
  expect(s.asked).toHaveLength(2);
});

test("it asks only for the one that is missing", async () => {
  const s = scripted("codex");
  expect(await promptForMissing({ identity: "ci", ask: s.ask })).toEqual({
    identity: "ci",
    agent: "codex",
  });
  expect(s.asked).toHaveLength(1);
  expect(s.asked[0]).toMatch(/agent/i);
});

test("it asks nothing when both were passed", async () => {
  const s = scripted();
  expect(
    await promptForMissing({ identity: "ci", agent: "codex", ask: s.ask }),
  ).toEqual({ identity: "ci", agent: "codex" });
  expect(s.asked).toEqual([]);
});

test("an unknown agent is asked again rather than accepted", async () => {
  const s = scripted("clause", "claude");
  expect((await promptForMissing({ identity: "w", ask: s.ask })).agent).toBe(
    "claude",
  );
  expect(s.asked).toHaveLength(2);
});

/** The store's own rule, so a name accepted here cannot be rejected later. */
test("a name the store would reject is asked again", async () => {
  const s = scripted("not a name!", "fine-name", "codex");
  expect((await promptForMissing({ ask: s.ask })).identity).toBe("fine-name");
});

test("it gives up rather than asking forever", async () => {
  const s = scripted("a!", "b!", "c!", "d!");
  await expect(promptForMissing({ ask: s.ask })).rejects.toThrow(/three/i);
});
