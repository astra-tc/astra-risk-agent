// Mutation control: plant each bug, run the tests, expect a failure, restore.
// Usage: node scripts/mutation-check.mjs  (reads scripts/mutations.json)
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const list = JSON.parse(readFileSync(new URL('./mutations.json', import.meta.url), 'utf8'));
const cmd = process.env.TEST_CMD ?? 'npm test --silent';
let killed = 0;
for (const m of list) {
  const orig = readFileSync(m.file, 'utf8');
  if (!orig.includes(m.from)) { console.error(`mutation source not found: ${m.file}: ${m.from}`); process.exit(2); }
  writeFileSync(m.file, orig.replace(m.from, m.to));
  try {
    const r = spawnSync(cmd, { shell: true, stdio: 'ignore' });
    const caught = r.status !== 0;
    if (caught) killed++;
    console.log(`${caught ? 'KILLED' : 'SURVIVED'}  ${m.id}  ${m.file}`);
  } finally {
    writeFileSync(m.file, orig);
  }
}
console.log(`${killed}/${list.length} mutations caught`);
process.exit(killed === list.length ? 0 : 1);
