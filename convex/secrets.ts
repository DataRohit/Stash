const MIN_SECRET_LENGTH = 32;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
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
