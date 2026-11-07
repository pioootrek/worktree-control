/** Already byte-bounded JSON for protected administration and closed cookie requests. */
function invalid(): never { throw new Error("Invalid JSON input."); }

export function parseStrictProviderJson(text: string, ceiling: { maxDepth: number; maxFields: number }): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { invalid(); }
  const stack: Array<Set<string> | null> = [];
  let fields = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "{" || character === "[") {
      stack.push(character === "{" ? new Set() : null);
      if (stack.length > ceiling.maxDepth) invalid();
    } else if (character === "}" || character === "]") stack.pop();
    else if (character === '"') {
      const start = index++;
      while (text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
      let next = index + 1;
      while (text[next] === " " || text[next] === "\n" || text[next] === "\r" || text[next] === "\t") next++;
      if (text[next] !== ":") continue;
      // Compare decoded keys: "a" and "a" are the same field.
      const key = JSON.parse(text.slice(start, index + 1)) as string, object = stack.at(-1);
      if (!object || object.has(key) || ++fields > ceiling.maxFields) invalid();
      object.add(key);
    }
  }
  return parsed;
}
