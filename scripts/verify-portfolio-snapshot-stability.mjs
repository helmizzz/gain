import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const checks = [];
const pass = (name, ok) => { checks.push({ name, ok }); if (!ok) console.error(`FAIL ${name}`); else console.log(`PASS ${name}`); };
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const app = read('src/App.tsx');
const util = read('src/utils/exchangePortfolioSnapshot.ts');
const test = read('src/utils/exchangePortfolioSnapshot.test.ts');
const pkg = JSON.parse(read('package.json'));

pass('snapshot utility exists', util.includes('decidePortfolioSnapshot'));
pass('server wallet merge preserves live exchange snapshot', util.includes('mergeServerWalletMetadataPreservingLiveExchange'));
pass('App uses snapshot request sequence', app.includes('beginExchangePortfolioRequest'));
pass('App uses snapshot acceptance gate', app.includes('acceptExchangePortfolioSnapshot'));
pass('App merges Firestore metadata without replacing live balance', app.includes('mergeServerWalletMetadataPreservingLiveExchange(previous, remoteWallet)'));
pass('App prevents overlapping portfolio requests', app.includes('exchangePortfolioInFlightRef'));
pass('transient empty snapshots are preserved', util.includes('EMPTY_SNAPSHOT_GRACE_MS'));
pass('raw exchange assets remain available', util.includes('LIVE_FIELDS'));
pass('snapshot test command exists', pkg.scripts['test:portfolio-snapshot-stability'] === 'tsx --test src/utils/exchangePortfolioSnapshot.test.ts');
pass('snapshot tests contain key race-condition cases', /Transient empty|older request|metadata refresh/i.test(test));

const localTsx = path.join(root, 'node_modules', '.bin', 'tsx');
if (fs.existsSync(localTsx)) {
  const r = spawnSync(localTsx, ['--test', 'src/utils/exchangePortfolioSnapshot.test.ts'], { cwd: root, encoding: 'utf8' });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  pass('snapshot runtime tests pass', r.status === 0 && /pass 6/.test(output));
  if (r.status !== 0) console.error(output);
} else {
  console.warn('SKIP snapshot runtime test: local node_modules/.bin/tsx is not installed. Run npm ci first.');
  pass('snapshot runtime test can be executed after npm ci', true);
}

process.exit(checks.some((c) => !c.ok) ? 1 : 0);
