const MIN_SECRET_LENGTH = 32;

function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

export function secretMatches(provided: string, expected: string | undefined): boolean {
  return Boolean(
    expected &&
      expected.length >= MIN_SECRET_LENGTH &&
      provided.length >= MIN_SECRET_LENGTH &&
      constantTimeEqual(provided, expected),
  );
}
