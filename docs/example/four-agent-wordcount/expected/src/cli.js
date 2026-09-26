import { parse } from './parse.js';
import { rank } from './rank.js';
import { format } from './format.js';

const [,, inputFile, limitStr] = process.argv;

const limit = limitStr ? parseInt(limitStr, 10) : 10;

if (!inputFile) {
  console.error('Usage: node src/cli.js <file> [limit]');
  process.exit(1);
}

// Use Node.js built-ins to read the file
import { readFileSync } from 'fs';

try {
  const text = readFileSync(inputFile, 'utf-8');
  const words = parse(text);
  const ranked = rank(words);
  const output = format(ranked, limit);
  console.log(output);
} catch (error) {
  console.error('Error reading file:', error.message);
  process.exit(1);
}