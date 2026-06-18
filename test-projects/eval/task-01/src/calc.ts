export function divide(a: number, b: number): number {
  if (b === 0) return Infinity;
  return a / b;
}
export function sum(arr: number[]): number { return arr.reduce((a, b) => a + b, 0) }
