import { parse } from '../src/parse.js';
import { rank } from '../src/rank.js';
import { format } from '../src/format.js';

// Create a temporary test file
const testText = 'hello world hello';
const tempFile = 'test.txt';

// Use Node.js built-ins to create and read the file
import { writeFileSync, readFileSync, unlinkSync } from 'fs';

writeFileSync(tempFile, testText);

// Run the pipeline
const words = parse(testText);
const ranked = rank(words);
const output = format(ranked, 10);

// Assert the result
const expected = 'hello 2\nworld 1';
if (output !== expected) {
  console.error('Test failed: expected\n', expected, '\nbut got\n', output);
  process.exit(1);
}

// Clean up
unlinkSync(tempFile);

console.log('Test passed');