// Reject duplicate keys at every depth; JSON.parse alone silently discards them.
export function strictJSON(raw: string): unknown {
  const tokens = raw.match(/"(?:\\[\s\S]|[^"\\])*"|[^\s]/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "{") stack.push(new Set());
    else if (t === "[") stack.push(null);
    else if (t === "}" || t === "]") stack.pop();
    else if (t.startsWith('"') && tokens[i + 1] === ":") {
      const keys = stack.at(-1);
      const key = JSON.parse(t) as string;
      if (keys?.has(key)) throw new Error();
      keys?.add(key);
    }
  }
  return JSON.parse(raw);
}
