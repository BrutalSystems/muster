import { test } from "node:test";
import assert from "node:assert/strict";
import { rank } from "../src/rank.js";

test("counts repeated words", () => {
  assert.deepEqual(rank(["apple", "apple", "pear", "apple", "pear"]), [
    ["apple", 3],
    ["pear", 2],
  ]);
});

test("sorts by descending count", () => {
  assert.deepEqual(rank(["apple", "pear", "plum", "pear", "plum", "plum"]), [
    ["plum", 3],
    ["pear", 2],
    ["apple", 1],
  ]);
});

test("breaks equal-count ties alphabetically", () => {
  assert.deepEqual(rank(["pear", "plum", "apple", "plum", "apple", "pear"]), [
    ["apple", 2],
    ["pear", 2],
    ["plum", 2],
  ]);
});

test("handles a single word", () => {
  assert.deepEqual(rank(["apple"]), [["apple", 1]]);
});

test("handles an empty array", () => {
  assert.deepEqual(rank([]), []);
});
