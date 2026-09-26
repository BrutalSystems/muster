export function parse(text) {
  if (typeof text !== 'string') {
    throw new Error('Input must be a string');
  }
  return text
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter(word => word.length > 0)
    .map(word => word.replace(/'/g, ''));
}