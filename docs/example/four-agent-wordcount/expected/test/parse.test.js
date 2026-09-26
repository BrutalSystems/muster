import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parse.js';

// Test 1: Ordinary prose
test('parses ordinary prose', () => {
  const result = parse('Hello world, how are you?');
  assert.deepEqual(result, ['hello', 'world', 'how', 'are', 'you']);
});

// Test 2: Mixed case
test('handles mixed case', () => {
  const result = parse('Hello WORLD, How Are You?');
  assert.deepEqual(result, ['hello', 'world', 'how', 'are', 'you']);
});

// Test 3: Punctuation between words
test('handles punctuation between words', () => {
  const result = parse('one, two; three! four?');
  assert.deepEqual(result, ['one', 'two', 'three', 'four']);
});

// Test 4: Apostrophe inside a word
test('preserves apostrophe inside a word', () => {
  const result = parse("don't worry, it's fine");
  assert.deepEqual(result, ['dont', 'worry', 'its', 'fine']);
});

// Test 5: Empty string
test('handles empty string', () => {
  const result = parse('');
  assert.deepEqual(result, []);
});