function regexLiteral(character: string): string {
  return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function classLiteral(character: string): string {
  return character.replace(/[\\\]\-^]/g, "\\$&");
}

function classMatcher(pattern: string, start: number): { source: string; end: number } | null {
  let index = start;
  let inverted = false;
  if (pattern[index] === "^") {
    inverted = true;
    index++;
  }

  const singles: string[] = [];
  const ranges: string[] = [];
  let prior: string | undefined;
  if (pattern[index] === "]") {
    singles.push(classLiteral("]"));
    index++;
  }

  while (index < pattern.length && pattern[index] !== "]") {
    const character = pattern[index];
    if (character === undefined) break;
    const upper = pattern[index + 1];
    if (character === "-" && prior !== undefined && upper !== undefined && upper !== "]") {
      const lowerCodePoint = prior.codePointAt(0);
      const upperCodePoint = upper.codePointAt(0);
      if (
        lowerCodePoint !== undefined &&
        upperCodePoint !== undefined &&
        lowerCodePoint <= upperCodePoint
      ) {
        ranges.push(`${classLiteral(prior)}-${classLiteral(upper)}`);
      }
      prior = undefined;
      index += 2;
      continue;
    }
    singles.push(classLiteral(character));
    prior = character;
    index++;
  }

  if (pattern[index] !== "]") return null;
  return {
    source: `[${inverted ? "^" : ""}${singles.join("")}${ranges.join("")}]`,
    end: index,
  };
}

export function globMatcher(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") source += "[^]*";
    else if (character === "?") source += "[^]";
    else if (character === "[") {
      const matcher = classMatcher(pattern, index + 1);
      if (matcher === null) return /(?!)/u;
      source += matcher.source;
      index = matcher.end;
    } else if (character !== undefined) source += regexLiteral(character);
  }
  return new RegExp(`${source}$`, "u");
}
