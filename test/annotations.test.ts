import { expect, test } from "vitest";
import { LEVELS, paramsFingerprint, runSchema } from "../src/guard.js";

const request = (options: string[] = []) =>
  runSchema.parse({ runtime: "codex", prompt: "review", options });
const fingerprint = (options: string[] = []) =>
  paramsFingerprint(request(options), LEVELS.read, [], []);
const root =
  'provenance={"namespace":"workflow","session":"run-002","launcher":"controller","parent":null}';

test("structured launch options coexist with named options", () => {
  const options = [
    'metadata={"workflow.role":"reviewer"}',
    root,
    "auto-approve-path",
  ];
  expect(request(options).options).toEqual(options);
});

test("annotations participate structurally in request-key fingerprints", () => {
  const a = ['metadata={"role":"reviewer","versions":"rules@4"}', root];
  const b = [
    'provenance={ "parent":null,"launcher":"controller","session":"run-002","namespace":"workflow" }',
    'metadata={ "versions":"rules@4", "role":"reviewer" }',
  ];
  expect(fingerprint(a)).toBe(fingerprint(b));
  expect(fingerprint(a)).not.toBe(fingerprint());
  expect(fingerprint(a)).not.toBe(
    fingerprint([a[0]!.replace("reviewer", "builder"), root]),
  );
  for (const changed of [
    root.replace("run-002", "run-003"),
    root.replace("controller", "another"),
    root.replace("workflow", "other"),
    root.replace("null", '"run-001"'),
  ])
    expect(fingerprint(a)).not.toBe(fingerprint([a[0]!, changed]));
  expect(fingerprint(["metadata={}"])).not.toBe(fingerprint());
});

test.each([
  "metadata={",
  "metadata=[]",
  "metadata=null",
  'metadata={"role":2}',
  'metadata={"role":{}}',
  'metadata={"role":["reviewer"]}',
  'metadata={"role":"a","role":"b"}',
  'metadata={"role":"a","r\\u006fle":"a"}',
  'metadata={"":"a"}',
  'provenance={"namespace":"workflow","session":"run-002","launcher":"controller"}',
  root.replace('"parent":null', '"parent":""'),
  root.replace('"parent":null', '"parent":42'),
  root.replace('"parent":null', '"parent":null,"extra":"value"'),
  root.replace('"parent":null', '"parent":null,"parent":null'),
  root.replace('"run-002"', '"has space"'),
  root.replace('"controller"', '"bad\\nlauncher"'),
  root.replace('"workflow"', '"' + "n".repeat(129) + '"'),
  "unknown-option",
])("rejects invalid annotation input: %s", (option) => {
  expect(() => request([option])).toThrow();
});

test("repeated structured options are refused even when identical", () => {
  expect(() => request([root, root])).toThrow();
  expect(() => request(["metadata={}", "metadata={}"])).toThrow();
});

test("metadata bounds count UTF-8 bytes and entries", () => {
  const option = (value: object) => "metadata=" + JSON.stringify(value);
  expect(() =>
    request([option({ ["é".repeat(32)]: "é".repeat(512) })]),
  ).not.toThrow();
  expect(() => request([option({ ["é".repeat(33)]: "v" })])).toThrow();
  expect(() => request([option({ key: "é".repeat(513) })])).toThrow();
  expect(() =>
    request([
      option(
        Object.fromEntries(
          Array.from({ length: 32 }, (_, i) => [String(i), "v"]),
        ),
      ),
    ]),
  ).not.toThrow();
  expect(() =>
    request([
      option(
        Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [String(i), "v"]),
        ),
      ),
    ]),
  ).toThrow();
  expect(() =>
    request([
      option(
        Object.fromEntries(
          Array.from({ length: 16 }, (_, i) => [String(i), "v".repeat(1024)]),
        ),
      ),
    ]),
  ).toThrow();
});

test("string contents are not mistaken for duplicate object keys", () => {
  expect(() =>
    request(['metadata={"a":"\\\"a\\\": colon, comma, brace }","b":"a=b"}']),
  ).not.toThrow();
  expect(() =>
    request(['metadata={"__proto__":"safe","constructor":"safe"}']),
  ).not.toThrow();
});

test("requests without annotations retain the released fingerprint", () => {
  // Captured from the 3.4.0 implementation, before annotation support.
  expect(
    paramsFingerprint(
      runSchema.parse({
        runtime: "codex",
        prompt: "legacy request",
        cwd: "/work/project",
      }),
      LEVELS.read,
      [],
      [],
    ),
  ).toBe("49f4741e1ece2dbee8602c3a1164ae6b0c56aedb583cedaa698ff98e888b0114");
});

test("input byte limits and valid boundary identifiers are enforced", () => {
  expect(() => request(["metadata=" + " ".repeat(128 * 1024) + "{}"])).toThrow(
    /128 KiB/,
  );
  expect(() =>
    request([root.replace("run-002", "x".repeat(128))]),
  ).not.toThrow();
  expect(() => request([root.replace("run-002", "x".repeat(129))])).toThrow();
  expect(() =>
    request([root.replace("null", '"parent.with:valid_chars-9"')]),
  ).not.toThrow();
});
