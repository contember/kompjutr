// uutils `du -h`: powers of 1024, rounded up. Below ten units one decimal
// place is kept (`1.1K`); from ten units the value is a whole number (`11K`).
// The unit is the largest one the value reaches, so 1048575 bytes is `1024K`.

const UNITS = ["K", "M", "G", "T", "P", "E"];

export function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  let exponent = 0;
  let base = 1024;
  while (exponent + 1 < UNITS.length && bytes >= base * 1024) {
    exponent++;
    base *= 1024;
  }
  const unit = UNITS[exponent] ?? "";
  const tenths = Math.ceil((bytes * 10) / base);
  if (tenths < 100) return `${Math.floor(tenths / 10)}.${tenths % 10}${unit}`;
  return `${Math.ceil(bytes / base)}${unit}`;
}
