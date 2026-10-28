// PIN policy for cashiers and waiters. The verifier lives on tablets for offline
// sign-in, so a stolen tablet allows offline guessing; length and avoiding the
// obvious choices is what keeps that expensive. One implementation for server and tablet.
export const PIN_MIN = 6;
export const PIN_MAX = 8;

export type PinProblem = 'format' | 'repeated' | 'sequence' | 'pattern';

/** Returns null when the PIN is acceptable, otherwise why not. */
export function pinProblem(pin: string): PinProblem | null {
  if (!new RegExp(`^[0-9]{${PIN_MIN},${PIN_MAX}}$`).test(pin)) return 'format';
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return 'repeated'; // 111111
  const step = d[1]! - d[0]!;
  if (Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1]! === step)) return 'sequence'; // 123456, 654321
  // a short block repeated: 121212, 123123, 1212
  for (const period of [2, 3]) {
    if (d.every((x, i) => i < period || x === d[i - period])) return 'pattern';
  }
  return null;
}
