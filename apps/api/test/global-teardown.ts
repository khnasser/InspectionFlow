import { execSync } from 'child_process';
import { readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export default async function globalTeardown() {
  const state = JSON.parse(readFileSync(join(tmpdir(), 'inspectionflow-test-db.json'), 'utf8'));
  if (!state.dataDir) return;
  const bin = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
  const cmd = `${bin}/pg_ctl -D ${state.dataDir}/data -m fast stop >/dev/null`;
  execSync(process.getuid && process.getuid() === 0 ? `su postgres -c "${cmd}"` : cmd);
  rmSync(state.dataDir, { recursive: true, force: true });
}
