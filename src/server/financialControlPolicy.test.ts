import test from 'node:test';
import assert from 'node:assert/strict';
import { assessReserveCoverage, getFinancialOperationsReadiness, parseAmountUnits, formatAmountUnits } from './financialControlPolicy';

const readyEnv={
  FINANCIAL_OPERATIONS_ENABLED:'true',FINANCIAL_OPERATING_MODE:'LICENSED_PARTNER',FINANCIAL_LEGAL_APPROVAL_REF:'board-resolution-2026-01',
  FINANCIAL_ASSET_ALLOWLIST:'USDT:BEP-20',FINANCIAL_CUSTODY_PROVIDER:'custodian-x',FINANCIAL_CUSTODY_ADAPTER_STATUS:'ACTIVE',
  FINANCIAL_SCREENING_PROVIDER:'screening-y',FINANCIAL_SCREENING_ADAPTER_STATUS:'ACTIVE',DATABASE_URL:'postgres://configured',
  REDIS_URL:'redis://configured',REDIS_REQUIRED:'true',BSC_RPC_URL:'https://rpc.invalid',BSC_MIN_CONFIRMATIONS:'12',
  BSC_TREASURY_HOT_ADDRESS:'0x1111111111111111111111111111111111111111',
  BSC_COMPANY_OPERATING_ADDRESS:'0x2222222222222222222222222222222222222222',
  BSC_COLD_RESERVE_ADDRESS:'0x3333333333333333333333333333333333333333',
  CUSTOMER_FUNDS_BANK_ACCOUNT_REF:'customer-segregated',COMPANY_OPERATING_BANK_ACCOUNT_REF:'company-operating',
  WITHDRAWAL_PROCESSOR_SECRET:'x'.repeat(40),FINANCIAL_SCREENING_HANDOFF_SECRET:'y'.repeat(40),FINANCIAL_CUSTODY_HANDOFF_SECRET:'z'.repeat(40),
  WITHDRAWAL_APPROVAL_COUNT:'2',WITHDRAWAL_MAX_AMOUNT_USDT:'1000',
  WITHDRAWAL_DAILY_LIMIT_USDT:'2000',WITHDRAWAL_ADDRESS_COOLDOWN_HOURS:'24',
  WITHDRAWAL_HOT_WALLET_DAILY_CAP_USDT:'5000',WITHDRAWAL_HOT_WALLET_TARGET_USDT:'1000',WITHDRAWAL_MIN_AMOUNT_USDT:'10',
  WITHDRAWAL_FEE_USDT:'2',P2P_TRANSFER_MAX_AMOUNT_USDT:'1000',P2P_TRANSFER_DAILY_LIMIT_USDT:'2000',
  DEPOSIT_MIN_AMOUNT_USDT:'10',DEPOSIT_MAX_AMOUNT_USDT:'10000',DEPOSIT_DAILY_LIMIT_USDT:'20000',
  WITHDRAWAL_PROCESSOR_LEASE_SECONDS:'90',WITHDRAWAL_MAX_PROCESSOR_ATTEMPTS:'3',
};

test('financial operations remain disabled until all readiness evidence/config is supplied',()=>{
  assert.equal(getFinancialOperationsReadiness({}).ready,false);
  assert.equal(getFinancialOperationsReadiness(readyEnv).ready,true);
});

test('wallet separation and dual approval configuration are required',()=>{
  const sameWallet={...readyEnv,BSC_COLD_RESERVE_ADDRESS:readyEnv.BSC_TREASURY_HOT_ADDRESS,WITHDRAWAL_APPROVAL_COUNT:'1'};
  const readiness=getFinancialOperationsReadiness(sameWallet);
  assert.equal(readiness.ready,false);
  assert.ok(readiness.missing.some(x=>x.includes('must be distinct')));
  assert.ok(readiness.missing.includes('WITHDRAWAL_APPROVAL_COUNT=2'));
});

test('internal service handoff secrets must be separate',()=>{
  const readiness=getFinancialOperationsReadiness({...readyEnv,FINANCIAL_CUSTODY_HANDOFF_SECRET:readyEnv.WITHDRAWAL_PROCESSOR_SECRET});
  assert.equal(readiness.ready,false);
  assert.ok(readiness.missing.some(x=>x.includes('secrets must be distinct')));
});

test('decimal units preserve exact ten-place financial amounts',()=>{
  assert.equal(formatAmountUnits(parseAmountUnits('123.0045000100')),'123.00450001');
  assert.throws(()=>parseAmountUnits('1.00000000001'));
});

test('reserve coverage reports shortfall and never self-claims attestation',()=>{
  const report=assessReserveCoverage({liabilities:'100.01',custodyAssets:'99.99',bankCustomerFunds:'110.00'});
  assert.equal(report.coverageStatus,'SHORTFALL');
  assert.equal(report.custodyDifference,'-0.02');
  assert.equal(report.attestationStatus,'UNATTESTED');
});
