export function matchesGoldenPreparation(actual, expected) {
  return (
    actual !== null &&
    typeof actual === 'object' &&
    Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}
