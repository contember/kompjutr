// Jaro similarity as `strsim::jaro` computes it, over Unicode scalar values.
// clap ranks its "a similar argument exists" tip with it, so the arithmetic
// has to match to print the same suggestion.

export function jaro(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const searchRange = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const low = i > searchRange ? i - searchRange : 0;
    const high = Math.min(b.length, i + searchRange + 1);
    for (let j = low; j < high; j++) {
      if (bMatched[j] === true || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    if (aMatched[i] !== true) continue;
    while (bMatched[j] !== true) j++;
    if (a[i] !== b[j]) transpositions++;
    j++;
  }
  const halfTranspositions = Math.floor(transpositions / 2);
  return (matches / a.length + matches / b.length + (matches - halfTranspositions) / matches) / 3;
}
