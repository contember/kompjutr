const STRING_FIXED_BYTES = 48;

export function retainedStringBytes(value: string): number {
  return STRING_FIXED_BYTES + value.length * 2;
}
