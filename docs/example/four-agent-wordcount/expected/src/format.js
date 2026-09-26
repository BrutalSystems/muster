export function format(rows, limit) {
  if (rows.length === 0) return '';

  const widths = rows.map(([word]) => word.length);
  const maxWidth = Math.max(...widths);

  const result = rows
    .slice(0, limit)
    .map(([word, count]) => `${word.padEnd(maxWidth)} ${count}`)
    .join('\n');

  return result;

  return result;
}