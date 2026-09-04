import { createInterface } from 'node:readline';

const stream = process.argv[2] ?? 'stdout';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  process.stdout.write(`${JSON.stringify({ arrivedAt: new Date().toISOString(), stream, line })}\n`);
}
