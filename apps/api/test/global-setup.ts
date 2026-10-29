/**
 * Integration tests run against a real PostgreSQL so row-level security is
 * exercised for real. Uses TEST_DATABASE_ADMIN_URL when given (CI service
 * container); otherwise starts a throwaway local cluster with the PostgreSQL
 * binaries (PG_BIN, default /usr/lib/postgresql/16/bin).
 */
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrate } from '../scripts/migrate';
import { seed } from '../scripts/seed';

const STATE = join(tmpdir(), 'inspectionflow-test-db.json');

export default async function globalSetup() {
  let adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  let dataDir: string | null = null;
  const port = 55432;
  if (!adminUrl) {
    const bin = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
    dataDir = mkdtempSync(join(tmpdir(), 'ifpg-'));
    chmodSync(dataDir, 0o777);
    const asPg = (cmd: string) =>
      process.getuid && process.getuid() === 0 ? `su postgres -c "${cmd.replace(/"/g, '\\"')}"` : cmd;
    execSync(asPg(`${bin}/initdb -D ${dataDir}/data -A trust -U postgres >/dev/null`), { stdio: 'inherit' });
    execSync(asPg(`${bin}/pg_ctl -D ${dataDir}/data -o '-p ${port} -k ${dataDir}' -l ${dataDir}/log -w start >/dev/null`), { stdio: 'inherit' });
    execSync(asPg(`${bin}/createdb -h localhost -p ${port} -U postgres inspectionflow`), { stdio: 'inherit' });
    adminUrl = `postgres://postgres@localhost:${port}/inspectionflow`;
  }
  await migrate(adminUrl);
  const a = await seed(adminUrl, 'DEMO-AUTH');
  const b = await seed(adminUrl, 'OTHER-AUTH', { tenantName: 'Other Authority' });
  const host = new URL(adminUrl);
  const appUrl = `postgres://inspectionflow_api:inspectionflow_api@${host.host}${host.pathname}`;
  writeFileSync(STATE, JSON.stringify({ adminUrl, appUrl, dataDir, port, tenantA: a.tenantId, tenantB: b.tenantId }));
}
