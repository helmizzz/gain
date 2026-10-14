import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const read=(f)=>fs.readFileSync(path.join(root,f),'utf8');
const checks=[];
function check(name,ok){checks.push({name,ok});}
const readServer=(r=root)=>{
  const dirs=['src/server','src/server/routes','src/server/shared','src/server/bot'];
  const files=['server.ts'];
  for(const d of dirs){
    const full=path.join(r,d);
    if(fs.existsSync(full)){
      for(const f of fs.readdirSync(full)){
        if(f.endsWith('.ts')||f.endsWith('.js'))files.push(path.join(d,f));
      }
    }
  }
  return files.filter(f=>fs.existsSync(path.join(r,f))).map(read).join('\n');
};
const trading=read('src/views/TradingPositionsView.tsx');
const app=read('src/App.tsx');
const server=readServer();
const test=read('src/utils/exchangePortfolioSnapshot.test.ts');
const mp=read('src/utils/multiPairPriceBounds.test.ts');
check('runtime bot key includes runner/pair scope', /key=\{`\$\{bot\.id \|\| bot\.botId/.test(trading) && /runner/.test(trading));
check('position keys include unique position/index scope', /key=\{`\$\{pos\.id \|\| pos\.botId/.test(trading) && /::\$\{idx\}/.test(trading));
check('secondary multi-pair bounds are derived per pair', /hasMultiplePairs/.test(app) && /derivedGridCount/.test(app));
check('server derives secondary pair grid corridor', /coinsToRegister\.length > 1 && !isPrimaryPair/.test(server) && /initialPrice \* \(1 - downsidePct/.test(server));
check('snapshot test fixture matches ConnectedExchangeConfig', /isConnected: true/.test(test) && /apiKeyMasked: 'API_CONNECTED'/.test(test) && /lastSynced: 'now'/.test(test));
check('multi-pair regression test exists', mp.includes('secondary multi-pair bounds are derived from each pair price'));
const passed=checks.filter(c=>c.ok).length;
console.log(JSON.stringify({ok:passed===checks.length,passed,failed:checks.length-passed,checks},null,2));
process.exitCode=passed===checks.length?0:1;
