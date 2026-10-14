const fs = require('fs');
const file = 'src/components/modals/AveragingMatrixModal.tsx';
let code = fs.readFileSync(file, 'utf8');

if (!code.includes('useRef')) {
  code = code.replace(
    "import { useState, useEffect, useMemo } from 'react';",
    "import { useState, useEffect, useMemo, useRef } from 'react';"
  );
}

fs.writeFileSync(file, code);
