/**
 * Safe division: dividing by zero returns Infinity instead of throwing.
 */
export function divide(a: number, b: number): number {
  if (b === 0) return Infinity;
  return a / b;
}
