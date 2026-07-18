// npm test: determinism -> lagcomp -> protocol -> smoke, sequential, nonzero exit
// on any failure. The 60 s soak is separate: npm run soak.
import { spawnSync } from 'node:child_process';

const suites = [
  'test/determinism.test.js',
  'test/lagcomp.test.js',
  'test/protocol.test.js',
  'test/smoke.e2e.js',
];

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const res = spawnSync('node', [suite], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`\nFAILED: ${suite}`);
    process.exit(1);
  }
}
console.log('\nall suites green');
