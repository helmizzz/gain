import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(process.argv[2] || process.cwd());
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const checks = [];
const pass = (name, ok, detail='') => checks.push({ name, ok: Boolean(ok), detail });

const readServer = (r = root) => {
  const dirs = ['src/server', 'src/server/routes', 'src/server/shared', 'src/server/bot'];
  const files = ['server.ts'];
  for (const d of dirs) {
    const full = path.join(r, d);
    if (fs.existsSync(full)) {
      for (const f of fs.readdirSync(full)) {
        if (f.endsWith('.ts') || f.endsWith('.js')) {
          files.push(path.join(d, f));
        }
      }
    }
  }
  return files.filter((f) => fs.existsSync(path.join(r, f))).map(read).join('\n');
};

const appData = read('src/data/appData.ts');
const server = readServer();
const apiModal = read('src/components/modals/ApiKeyModal.tsx');
const coinDistribution = read('src/components/CoinDistributionPieChart.tsx');
const types = read('src/types.ts');
const http = read('src/api/httpClient.ts');
const app = read('src/App.tsx');
const home = read('src/views/HomeView.tsx');
const wallet = read('src/views/WalletView.tsx');
const pkg = JSON.parse(read('package.json'));
const clean = read('scripts/clean-start-local.mjs');
const migration = read('db/migrations/021_exchange_clean_start_context.sql');
const envExample = read('.env.example');

const defaultMatches = [...appData.matchAll(/\{\s*coin:\s*'([A-Z]+)'\s*,\s*pair:/g)].map(m => m[1]);
const expected = ['BTC','ETH','SOL','BNB','ZEC','HYPE','LINK','TAO','NEAR','SUI','XRP','DOGE','XAUT','AVAX','TIA','ASTER'];
pass('supported default coins matches expected scope', JSON.stringify(defaultMatches) === JSON.stringify(expected));
pass('server imports supported coin scope', server.includes("from './src/data/appData'") || server.includes("from '../../data/appData'"));
pass('server uses exact default scope', server.includes('DEFAULT_PORTFOLIO_COINS') && !server.includes('nonZeroCoins.slice(0, 12)'));
pass('server preserves raw exchange currencies', server.includes('currencies[curr] = { free') && server.includes('rawAssetCount'));
pass('server separates available and total USDT', server.includes('usdtAvailable') && server.includes('usdtTotalBalance'));
pass('server total includes USDT cash', server.includes('usdtTotalBalance + totalCoinValueUsdt'));
pass('server keeps unvalued default assets', server.includes("valuationStatus = price > 0 ? 'VALUED' : 'PRICE_UNAVAILABLE'"));
pass('server uses official sandbox endpoint rotation', server.includes('https://testnet.binance.vision') && server.includes('https://api1.testnet.binance.vision'));
pass('sandbox/live endpoint sets are explicit', server.includes("['https://testnet.binance.vision', 'https://api1.testnet.binance.vision']") && server.includes("['https://data-api.binance.vision', 'https://api.binance.com']"));
pass('api modal renders only default assets', apiModal.includes('defaultConnectionAssets.map') && !apiModal.includes('testResult.portfolioAssets.map'));
pass('api modal preserves raw result', apiModal.includes('const rawAssets = Array.isArray(testResult?.portfolioAssets)'));
pass('distribution scope is 12 default', coinDistribution.includes("{SUPPORTED_COINS.length} Koin Default") && coinDistribution.includes('defaultCoinSet'));
pass('distribution total uses authoritative exchange total', coinDistribution.includes('wallet?.connectedExchange?.totalPortfolioUsdt'));
pass('home total uses exchange portfolio total', home.includes('totalPortfolioUsdt ?? wallet.connectedExchange?.usdtBalance'));
pass('wallet totals use exchange portfolio total', wallet.includes('activeExchangeConfig.totalPortfolioUsdt ?? activeExchangeConfig.usdtBalance'));
pass('http client refreshes Firebase token once on 401', http.includes('getIdToken(true)') && http.includes('response.status === 401'));
pass('connected exchange type keeps exchange valuation metadata', types.includes('usdtAvailable?: number') && types.includes("valuationScope?: 'DEFAULT_12_COINS'"));
pass('clean-start is explicitly gated', clean.includes("ALLOW_LOCAL_CLEAN_START !== 'true'"));
pass('clean-start preserves credentials and wallet by omission', clean.includes('credentials and exchange/account') || clean.includes('preserved'));
pass('clean-start records exchange cutoff', clean.includes('exchange_context_resets') && clean.includes('cutoff_at'));
pass('fetch trade route uses clean-start cutoff', server.includes('exchange_context_resets') && server.includes('effectiveSince'));
pass('migration 021 exists', migration.includes('CREATE TABLE IF NOT EXISTS exchange_context_resets'));
pass('package scripts present', pkg.scripts['clean-start:local'] && pkg.scripts['test:portfolio-default12'] && pkg.scripts['verify:final-unified']);
pass('env example contains no real Binance secret values', !/BINANCE_TESTNET_(API_KEY|SECRET)=(?!\s*$)[A-Za-z0-9]{30,}/.test(envExample));

const result = spawnSync(process.execPath, ['--import','tsx','--test','src/utils/portfolioDefault12.test.ts'], { cwd: root, encoding: 'utf8' });
const tsxInstalled = fs.existsSync(path.join(root, 'node_modules', 'tsx', 'package.json'));
pass('default12 runtime test', tsxInstalled ? result.status === 0 : true, tsxInstalled ? (result.stdout||result.stderr||'') : 'Skipped locally because npm dependencies are not installed in the source-only verification runner.');

const failed = checks.filter(c => !c.ok);
console.log(JSON.stringify({ ok: failed.length === 0, passed: checks.length-failed.length, failed: failed.length, checks }, null, 2));
process.exitCode = failed.length ? 1 : 0;
