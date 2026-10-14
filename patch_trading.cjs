const fs = require('fs');
const file = 'src/views/TradingPositionsView.tsx';
let code = fs.readFileSync(file, 'utf8');

const oldMinPlaceholder = 'placeholder="0.00000000 (Kosongkan jika tanpa batas)"\n                  value={editMinPrice}';
const newMinPlaceholder = 'placeholder={quickBoundaryEditPos?.botMode === "Grid Only" || quickBoundaryEditPos?.botMode === "Avarage+Grid" ? "0.00000000 (Wajib diisi untuk Grid)" : "0.00000000 (Kosongkan jika tanpa batas)"}\n                  value={editMinPrice}';

const oldMaxPlaceholder = 'placeholder="0.00000000 (Kosongkan jika tanpa batas)"\n                  value={editMaxPrice}';
const newMaxPlaceholder = 'placeholder={quickBoundaryEditPos?.botMode === "Grid Only" || quickBoundaryEditPos?.botMode === "Avarage+Grid" ? "0.00000000 (Wajib diisi untuk Grid)" : "0.00000000 (Kosongkan jika tanpa batas)"}\n                  value={editMaxPrice}';

code = code.replace(oldMinPlaceholder, newMinPlaceholder);
code = code.replace(oldMaxPlaceholder, newMaxPlaceholder);

fs.writeFileSync(file, code);
