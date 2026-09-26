import { test } from "node:test";
import assert from "node:assert/strict";
import { format } from "../src/format.js";

// Test empty array
test('empty array returns empty string', () => {
  assert.strictEqual(format([], 5), '');
});

// Test limit larger than row count
test('limit larger than row count shows all rows', () => {
  const rows = [['hello', 5], ['world', 3]];
  assert.strictEqual(format(rows, 10), 'hello 5\nworld 3');
});

// Test limit smaller than row count
test('limit smaller than row count shows only first limit rows', () => {
  const rows = [['a', 1], ['bb', 2], ['ccc', 3]];
  assert.strictEqual(format(rows, 2), 'a   1\nbb  2');
});

// Test alignment with varying word lengths
test('alignment with words of differing length', () => {
  const rows = [['short', 1], ['verylongword', 2]];
  assert.strictEqual(format(rows, 2), 'short        1\nverylongword 2');
});