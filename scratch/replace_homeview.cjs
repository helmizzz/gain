const fs = require('fs');
const path = require('path');

const filePath = path.join('/Users/dedimujahidin/Downloads/gain-niagakoin-v4', 'src/views/HomeView.tsx');
let content = fs.readFileSync(filePath, 'utf8');

const helpers = `
  const trendingList = ['BTC', 'ETH', 'SOL', 'BNB'].map(symbol => {
    const coinDef = SUPPORTED_COINS.find(c => c.coin === symbol);
    const ticker = coinDef ? marketData[coinDef.pair] : null;
    const price = ticker?.last || coinDef?.price || 0;
    const change = ticker?.percentage || coinDef?.change24h || 0;
    return { ...(coinDef || {}), coin: symbol, price, change };
  });

  const topGainersList = SUPPORTED_COINS.map(coinDef => {
    const ticker = marketData[coinDef.pair];
    const price = ticker?.last || coinDef.price || 0;
    const change = ticker?.percentage || coinDef.change24h || 0;
    return { ...coinDef, price, change };
  }).sort((a, b) => b.change - a.change).slice(0, 4);
`;

// Insert the helpers right before activePill
content = content.replace(
  "  // State 1: Active Pill Tab Filter",
  helpers + "\n  // State 1: Active Pill Tab Filter"
);

// We need to also import formatPercent from formatters
if (!content.includes('formatPercent')) {
  content = content.replace("import { formatUsdt } from '../utils/formatters';", "import { formatUsdt, formatPercent } from '../utils/formatters';");
}

const renderList = (listName) => `
              <div className="mt-2 space-y-2 text-xs">
                {${listName}.map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CoinLogo coin={item.coin} size="sm" />
                      <span className="font-semibold text-slate-900 dark:text-white">{item.name || item.coin}</span>
                      <span className="text-[10px] text-slate-400 font-mono">{item.coin}</span>
                    </div>
                    <div className="text-right font-mono">
                      <span className="font-bold text-slate-900 dark:text-white">${"$"}{formatUsdt(item.price, item.price < 1 ? 4 : 2)}</span>
                      <span className={\`font-bold ml-1.5 text-[11px] \${item.change >= 0 ? 'text-emerald-500' : 'text-rose-500'}\`}>
                        {formatPercent(item.change)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
`;

// Replace Card 2 inner content
const card2Regex = /<div className="mt-2 space-y-2 text-xs">[\s\S]*?(?=<\/div>\s*<\/div>\s*<\/div>\s*\{\/\* Card 3: 🚀 Top Gainers \/ Active Bots > \*\/})/g;
content = content.replace(card2Regex, renderList('trendingList') + '            ');

// Replace Card 3 inner content
const card3Regex = /<div className="mt-2 space-y-2 text-xs">[\s\S]*?(?=<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*\}\)\s*\{\/\* DUAL-VAULT ARCHITECTURE INFOGRAPHIC \*\/})/g;
content = content.replace(card3Regex, renderList('topGainersList') + '            ');

fs.writeFileSync(filePath, content);
console.log('Replaced successfully');
