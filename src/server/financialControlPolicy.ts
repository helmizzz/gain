export type FinancialEnv = Record<string, string | undefined>;

const POSITIVE_LIMITS = [
  'WITHDRAWAL_MAX_AMOUNT_USDT',
  'WITHDRAWAL_DAILY_LIMIT_USDT',
  'WITHDRAWAL_ADDRESS_COOLDOWN_HOURS',
  'WITHDRAWAL_HOT_WALLET_DAILY_CAP_USDT',
  'WITHDRAWAL_HOT_WALLET_TARGET_USDT',
  'WITHDRAWAL_FEE_USDT',
  'WITHDRAWAL_MIN_AMOUNT_USDT',
  'P2P_TRANSFER_MAX_AMOUNT_USDT',
  'P2P_TRANSFER_DAILY_LIMIT_USDT',
  'DEPOSIT_MIN_AMOUNT_USDT',
  'DEPOSIT_MAX_AMOUNT_USDT',
  'DEPOSIT_DAILY_LIMIT_USDT',
  'WITHDRAWAL_PROCESSOR_LEASE_SECONDS',
] as const;

function positive(value: string | undefined): boolean {
  const n=Number(value);
  return Number.isFinite(n)&&n>0;
}

export function getFinancialOperationsReadiness(env: FinancialEnv = process.env) {
  const missing: string[]=[];
  if(env.FINANCIAL_OPERATIONS_ENABLED!=='true') missing.push('FINANCIAL_OPERATIONS_ENABLED=true');
  if(!['LICENSED_DIRECT','LICENSED_PARTNER'].includes(String(env.FINANCIAL_OPERATING_MODE||''))) missing.push('FINANCIAL_OPERATING_MODE=LICENSED_DIRECT|LICENSED_PARTNER');
  if(!String(env.FINANCIAL_LEGAL_APPROVAL_REF||'').trim()) missing.push('FINANCIAL_LEGAL_APPROVAL_REF');
  if(!String(env.FINANCIAL_ASSET_ALLOWLIST||'').split(',').map(x=>x.trim().toUpperCase()).includes('USDT:BEP-20')) missing.push('FINANCIAL_ASSET_ALLOWLIST includes USDT:BEP-20');
  if(!String(env.FINANCIAL_CUSTODY_PROVIDER||'').trim()) missing.push('FINANCIAL_CUSTODY_PROVIDER');
  if(env.FINANCIAL_CUSTODY_ADAPTER_STATUS!=='ACTIVE') missing.push('FINANCIAL_CUSTODY_ADAPTER_STATUS=ACTIVE');
  if(!String(env.FINANCIAL_SCREENING_PROVIDER||'').trim()) missing.push('FINANCIAL_SCREENING_PROVIDER');
  if(env.FINANCIAL_SCREENING_ADAPTER_STATUS!=='ACTIVE') missing.push('FINANCIAL_SCREENING_ADAPTER_STATUS=ACTIVE');
  if(!env.DATABASE_URL) missing.push('DATABASE_URL');
  if(!env.REDIS_URL||env.REDIS_REQUIRED!=='true') missing.push('REDIS_URL and REDIS_REQUIRED=true');
  if(!env.BSC_RPC_URL) missing.push('BSC_RPC_URL');
  if(!Number.isInteger(Number(env.BSC_MIN_CONFIRMATIONS))||Number(env.BSC_MIN_CONFIRMATIONS)<1) missing.push('BSC_MIN_CONFIRMATIONS');
  if(!/^0x[a-f0-9]{40}$/i.test(String(env.BSC_TREASURY_HOT_ADDRESS||''))) missing.push('BSC_TREASURY_HOT_ADDRESS');
  if(!/^0x[a-f0-9]{40}$/i.test(String(env.BSC_COMPANY_OPERATING_ADDRESS||''))) missing.push('BSC_COMPANY_OPERATING_ADDRESS');
  if(!/^0x[a-f0-9]{40}$/i.test(String(env.BSC_COLD_RESERVE_ADDRESS||''))) missing.push('BSC_COLD_RESERVE_ADDRESS');
  const walletAddresses=[env.BSC_TREASURY_HOT_ADDRESS,env.BSC_COMPANY_OPERATING_ADDRESS,env.BSC_COLD_RESERVE_ADDRESS].map(x=>String(x||'').toLowerCase()).filter(Boolean);
  if(new Set(walletAddresses).size!==walletAddresses.length) missing.push('hot, company operating, and cold reserve addresses must be distinct');
  if(!String(env.CUSTOMER_FUNDS_BANK_ACCOUNT_REF||'').trim()) missing.push('CUSTOMER_FUNDS_BANK_ACCOUNT_REF');
  if(!String(env.COMPANY_OPERATING_BANK_ACCOUNT_REF||'').trim()) missing.push('COMPANY_OPERATING_BANK_ACCOUNT_REF');
  if(env.CUSTOMER_FUNDS_BANK_ACCOUNT_REF&&env.COMPANY_OPERATING_BANK_ACCOUNT_REF&&env.CUSTOMER_FUNDS_BANK_ACCOUNT_REF===env.COMPANY_OPERATING_BANK_ACCOUNT_REF) missing.push('customer and company bank account references must be distinct');
  if(!String(env.WITHDRAWAL_PROCESSOR_SECRET||'')||String(env.WITHDRAWAL_PROCESSOR_SECRET).length<32) missing.push('WITHDRAWAL_PROCESSOR_SECRET (minimum 32 characters)');
  if(!String(env.FINANCIAL_SCREENING_HANDOFF_SECRET||'')||String(env.FINANCIAL_SCREENING_HANDOFF_SECRET).length<32) missing.push('FINANCIAL_SCREENING_HANDOFF_SECRET (minimum 32 characters)');
  if(!String(env.FINANCIAL_CUSTODY_HANDOFF_SECRET||'')||String(env.FINANCIAL_CUSTODY_HANDOFF_SECRET).length<32) missing.push('FINANCIAL_CUSTODY_HANDOFF_SECRET (minimum 32 characters)');
  const handoffSecrets=[env.WITHDRAWAL_PROCESSOR_SECRET,env.FINANCIAL_SCREENING_HANDOFF_SECRET,env.FINANCIAL_CUSTODY_HANDOFF_SECRET].map(x=>String(x||'')).filter(Boolean);
  if(new Set(handoffSecrets).size!==handoffSecrets.length) missing.push('withdrawal, screening, and custody handoff secrets must be distinct');
  if(env.WITHDRAWAL_APPROVAL_COUNT!=='2') missing.push('WITHDRAWAL_APPROVAL_COUNT=2');
  if(!Number.isInteger(Number(env.WITHDRAWAL_MAX_PROCESSOR_ATTEMPTS))||Number(env.WITHDRAWAL_MAX_PROCESSOR_ATTEMPTS)<1) missing.push('WITHDRAWAL_MAX_PROCESSOR_ATTEMPTS');
  for(const key of POSITIVE_LIMITS) if(!positive(env[key])) missing.push(key);
  if(!Number.isInteger(Number(env.WITHDRAWAL_PROCESSOR_LEASE_SECONDS))) missing.push('WITHDRAWAL_PROCESSOR_LEASE_SECONDS must be a whole number');
  if(positive(env.WITHDRAWAL_MAX_AMOUNT_USDT)&&positive(env.WITHDRAWAL_DAILY_LIMIT_USDT)&&Number(env.WITHDRAWAL_MAX_AMOUNT_USDT)>Number(env.WITHDRAWAL_DAILY_LIMIT_USDT)) missing.push('WITHDRAWAL_MAX_AMOUNT_USDT must not exceed WITHDRAWAL_DAILY_LIMIT_USDT');
  if(positive(env.WITHDRAWAL_MAX_AMOUNT_USDT)&&positive(env.WITHDRAWAL_HOT_WALLET_DAILY_CAP_USDT)&&Number(env.WITHDRAWAL_MAX_AMOUNT_USDT)>Number(env.WITHDRAWAL_HOT_WALLET_DAILY_CAP_USDT)) missing.push('WITHDRAWAL_MAX_AMOUNT_USDT must not exceed WITHDRAWAL_HOT_WALLET_DAILY_CAP_USDT');
  if(positive(env.WITHDRAWAL_MIN_AMOUNT_USDT)&&positive(env.WITHDRAWAL_FEE_USDT)&&Number(env.WITHDRAWAL_MIN_AMOUNT_USDT)<=Number(env.WITHDRAWAL_FEE_USDT)) missing.push('WITHDRAWAL_MIN_AMOUNT_USDT must exceed WITHDRAWAL_FEE_USDT');
  if(positive(env.WITHDRAWAL_HOT_WALLET_TARGET_USDT)&&positive(env.WITHDRAWAL_HOT_WALLET_DAILY_CAP_USDT)&&Number(env.WITHDRAWAL_HOT_WALLET_TARGET_USDT)>Number(env.WITHDRAWAL_HOT_WALLET_DAILY_CAP_USDT)) missing.push('WITHDRAWAL_HOT_WALLET_TARGET_USDT must not exceed WITHDRAWAL_HOT_WALLET_DAILY_CAP_USDT');
  if(positive(env.P2P_TRANSFER_MAX_AMOUNT_USDT)&&positive(env.P2P_TRANSFER_DAILY_LIMIT_USDT)&&Number(env.P2P_TRANSFER_MAX_AMOUNT_USDT)>Number(env.P2P_TRANSFER_DAILY_LIMIT_USDT)) missing.push('P2P_TRANSFER_MAX_AMOUNT_USDT must not exceed P2P_TRANSFER_DAILY_LIMIT_USDT');
  if(positive(env.DEPOSIT_MIN_AMOUNT_USDT)&&positive(env.DEPOSIT_MAX_AMOUNT_USDT)&&Number(env.DEPOSIT_MIN_AMOUNT_USDT)>Number(env.DEPOSIT_MAX_AMOUNT_USDT)) missing.push('DEPOSIT_MIN_AMOUNT_USDT must not exceed DEPOSIT_MAX_AMOUNT_USDT');
  if(positive(env.DEPOSIT_MAX_AMOUNT_USDT)&&positive(env.DEPOSIT_DAILY_LIMIT_USDT)&&Number(env.DEPOSIT_MAX_AMOUNT_USDT)>Number(env.DEPOSIT_DAILY_LIMIT_USDT)) missing.push('DEPOSIT_MAX_AMOUNT_USDT must not exceed DEPOSIT_DAILY_LIMIT_USDT');
  return {ready:missing.length===0,missing,mode:env.FINANCIAL_OPERATING_MODE||'DISABLED'};
}

export function requireFinancialOperationsReady(env: FinancialEnv = process.env) {
  const readiness=getFinancialOperationsReadiness(env);
  if(!readiness.ready) throw Object.assign(
    new Error('Financial operations are disabled because required legal, provider, wallet-separation, screening, or risk-policy controls are not ready.'),
    {code:'FINANCIAL_OPERATIONS_NOT_READY',statusCode:503,missing:readiness.missing},
  );
  return readiness;
}

export function parseAmountUnits(value: unknown, decimals=10): bigint {
  const input=String(value??'').trim();
  const match=/^(\d+)(?:\.(\d+))?$/.exec(input);
  if(!match||(match[2]||'').length>decimals) throw new Error('INVALID_DECIMAL_AMOUNT');
  const scale=10n**BigInt(decimals);
  return BigInt(match[1])*scale+BigInt(((match[2]||'')+'0'.repeat(decimals)).slice(0,decimals)||'0');
}

export function formatAmountUnits(value: bigint, decimals=10): string {
  const negative=value<0n;
  const absolute=negative?-value:value;
  const scale=10n**BigInt(decimals);
  const whole=absolute/scale;
  const fraction=(absolute%scale).toString().padStart(decimals,'0').replace(/0+$/,'');
  return (negative?'-':'')+(fraction?String(whole)+'.'+fraction:String(whole));
}

export function assessReserveCoverage(input:{liabilities:string|number;custodyAssets:string|number;bankCustomerFunds?:string|number|null}) {
  const liabilities=parseAmountUnits(input.liabilities);
  const custody=parseAmountUnits(input.custodyAssets);
  const difference=custody-liabilities;
  const ratio=liabilities===0n?null:Number(custody)/Number(liabilities);
  const bank=input.bankCustomerFunds===undefined||input.bankCustomerFunds===null?null:parseAmountUnits(input.bankCustomerFunds);
  return {
    liability:formatAmountUnits(liabilities),
    custodyAssets:formatAmountUnits(custody),
    custodyDifference:formatAmountUnits(difference),
    coverageRatio:ratio,
    coverageStatus:difference>=0n?'COVERED':'SHORTFALL',
    bankCustomerFunds:bank===null?null:formatAmountUnits(bank),
    attestationStatus:'UNATTESTED' as const,
  };
}
