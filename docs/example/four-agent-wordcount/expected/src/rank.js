export function rank(words) {
  const counts = new Map();
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts].sort(([a, aCount], [b, bCount]) =>
    bCount - aCount || (a < b ? -1 : a > b ? 1 : 0)
  );
}
