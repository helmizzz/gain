import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
  return pairs;
}, []));
const businessDate = args.date || process.env.FINANCIAL_RECONCILIATION_DATE;
const custodyPath = args.custody || process.env.FINANCIAL_CUSTODY_SNAPSHOT_FILE;
const bankPath = args.bank || process.env.FINANCIAL_BANK_SNAPSHOT_FILE;
const operator = String(process.env.FINANCIAL_RECONCILIATION_OPERATOR || '').trim();

function fail(code, message) {
  console.error(JSON.stringify({ ok: false, code, message }));
  process.exit(2);
}
function isDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function toUnits(value) {
  const m = /^(\d+)(?:\.(\d{1,10}))?$/.exec(String(value ?? '').trim());
  if (!m) throw new Error('INVALID_DECIMAL');
  return BigInt(m[1]) * 10000000000n + BigInt(((m[2] || '') + '0000000000').slice(0, 10));
}
function fromUnits(value) {
  const negative = value < 0n;
  const n = negative ? -value : value;
  const whole = n / 10000000000n;
  const fraction = (n % 10000000000n).toString().padStart(10, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + String(whole) + (fraction ? '.' + fraction : '');
}
function sourceRef(snapshot) {
  const ref = String(snapshot?.sourceReference || '');
  if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(ref)) throw new Error('INVALID_SOURCE_REFERENCE');
  return ref;
}
async function readJson(file, label) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { fail(label + '_SNAPSHOT_INVALID', 'Snapshot file is missing or invalid JSON.'); }
}

if (!process.env.DATABASE_URL) fail('DATABASE_NOT_CONFIGURED', 'DATABASE_URL is required.');
if (!isDate(businessDate)) fail('BUSINESS_DATE_REQUIRED', 'Pass --date YYYY-MM-DD or set FINANCIAL_RECONCILIATION_DATE.');
if (!custodyPath || !bankPath) fail('SNAPSHOT_FILES_REQUIRED', 'Pass --custody and --bank JSON snapshot files.');
if (!operator) fail('RECONCILIATION_OPERATOR_REQUIRED', 'FINANCIAL_RECONCILIATION_OPERATOR is required.');

const custody = await readJson(custodyPath, 'CUSTODY');
const bank = await readJson(bankPath, 'BANK');
if (custody.businessDate !== businessDate || custody.asset !== 'USDT' || custody.network !== 'BEP-20') fail('CUSTODY_SNAPSHOT_SCOPE_INVALID', 'Custody snapshot must be for this date, USDT, and BEP-20.');
if (bank.businessDate !== businessDate || !/^[A-Z]{3}$/.test(String(bank.currency || ''))) fail('BANK_SNAPSHOT_SCOPE_INVALID', 'Bank snapshot must be for this date and a three-letter currency.');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : undefined,
});

try {
  const ledger = await pool.query(
    "WITH latest_ledger AS (SELECT DISTINCT ON (account_id) account_id,balance_after FROM wallet_ledger WHERE entry_type <> 'MANAGEMENT_PROFIT_SHARE' ORDER BY account_id,created_at DESC,id DESC), active_withdrawals AS (SELECT user_id,currency,COALESCE(SUM(amount),0) AS locked FROM withdrawals WHERE status IN ('REVIEW','PROCESSING','SENT') GROUP BY user_id,currency) SELECT COALESCE(SUM(w.available_balance+w.locked_balance+w.gas_reserve),0)::text AS liability,COUNT(*) FILTER (WHERE w.available_balance<>COALESCE(ll.balance_after,0))::int AS available_mismatch,COUNT(*) FILTER (WHERE w.locked_balance<>COALESCE(aw.locked,0))::int AS locked_mismatch FROM wallet_accounts w LEFT JOIN latest_ledger ll ON ll.account_id=w.id LEFT JOIN active_withdrawals aw ON aw.user_id=w.user_id AND aw.currency=w.currency WHERE w.currency='USDT'",
  );
  const ledgerLiability = String(ledger.rows[0].liability);
  const walletIntegrity = {
    availableBalanceMismatches:Number(ledger.rows[0].available_mismatch||0),
    lockedBalanceMismatches:Number(ledger.rows[0].locked_mismatch||0),
  };
  walletIntegrity.ok=walletIntegrity.availableBalanceMismatches===0&&walletIntegrity.lockedBalanceMismatches===0;
  const custodyAvailable = custody.status === 'AVAILABLE' ? toUnits(custody.assets) : null;
  const bankBalance = bank.status === 'AVAILABLE' ? toUnits(bank.customerFundsBalance) : null;
  const bankLiability = bank.status === 'AVAILABLE' ? toUnits(bank.customerLiability) : null;
  const custodyCoverage = custodyAvailable === null ? null : custodyAvailable - toUnits(ledgerLiability);
  const bankCoverage = bankBalance === null || bankLiability === null ? null : bankBalance - bankLiability;
  const custodyStatus = custodyCoverage === null || !walletIntegrity.ok ? 'INCOMPLETE' : custodyCoverage === 0n ? 'MATCHED' : 'DISCREPANCY';
  const bankStatus = bankCoverage === null ? 'INCOMPLETE' : bankCoverage === 0n ? 'MATCHED' : 'DISCREPANCY';
  const custodySource = sourceRef(custody);
  const bankSource = sourceRef(bank);
  const client = await pool.connect();
  let runIds = [];
  try {
    await client.query('BEGIN');
    const custodyRun = await client.query(
      "INSERT INTO financial_reconciliation_runs(business_date,asset,network,ledger_liability,custody_assets,status,source_refs,difference,created_by) VALUES($1,'USDT','BEP-20',$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(business_date,asset,network) DO UPDATE SET ledger_liability=EXCLUDED.ledger_liability,custody_assets=EXCLUDED.custody_assets,status=EXCLUDED.status,source_refs=EXCLUDED.source_refs,difference=EXCLUDED.difference,created_by=EXCLUDED.created_by,created_at=now() RETURNING id",
      [businessDate, ledgerLiability, custodyAvailable === null ? null : fromUnits(custodyAvailable), custodyStatus, JSON.stringify({ custody: custodySource, inputFile: path.basename(custodyPath) }), custodyCoverage === null ? null : fromUnits(custodyCoverage), operator],
    );
    const bankRun = await client.query(
      "INSERT INTO financial_reconciliation_runs(business_date,asset,network,ledger_liability,bank_assets,status,source_refs,difference,created_by) VALUES($1,$2,'BANK',$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(business_date,asset,network) DO UPDATE SET ledger_liability=EXCLUDED.ledger_liability,bank_assets=EXCLUDED.bank_assets,status=EXCLUDED.status,source_refs=EXCLUDED.source_refs,difference=EXCLUDED.difference,created_by=EXCLUDED.created_by,created_at=now() RETURNING id",
      [businessDate, bank.currency, bankLiability === null ? '0' : fromUnits(bankLiability), bankBalance === null ? null : fromUnits(bankBalance), bankStatus, JSON.stringify({ bank: bankSource, inputFile: path.basename(bankPath) }), bankCoverage === null ? null : fromUnits(bankCoverage), operator],
    );
    runIds = [custodyRun.rows[0].id, bankRun.rows[0].id];
    for (const runId of runIds) await client.query('DELETE FROM financial_reconciliation_items WHERE run_id=$1', [runId]);
    if (!walletIntegrity.ok) await client.query(
      "INSERT INTO financial_reconciliation_items(run_id,item_type,reference_id,ledger_amount,details) VALUES($1,'MISSING_SOURCE',$2,$3,$4::jsonb)",
      [custodyRun.rows[0].id, businessDate + ':USDT:INTERNAL_LEDGER', ledgerLiability, JSON.stringify(walletIntegrity)],
    );
    if (custodyStatus !== 'MATCHED') await client.query(
      "INSERT INTO financial_reconciliation_items(run_id,item_type,reference_id,ledger_amount,custody_amount,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
      [custodyRun.rows[0].id, custodyStatus === 'INCOMPLETE' ? 'MISSING_SOURCE' : 'AMOUNT_MISMATCH', businessDate + ':USDT:BEP-20', ledgerLiability, custodyAvailable === null ? null : fromUnits(custodyAvailable), JSON.stringify({ sourceReference: custodySource, sourceStatus: custody.status || 'UNKNOWN' })],
    );
    if (bankStatus !== 'MATCHED') await client.query(
      "INSERT INTO financial_reconciliation_items(run_id,item_type,reference_id,ledger_amount,bank_amount,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
      [bankRun.rows[0].id, bankStatus === 'INCOMPLETE' ? 'MISSING_SOURCE' : 'AMOUNT_MISMATCH', businessDate + ':' + bank.currency + ':BANK', bankLiability === null ? null : fromUnits(bankLiability), bankBalance === null ? null : fromUnits(bankBalance), JSON.stringify({ sourceReference: bankSource, sourceStatus: bank.status || 'UNKNOWN' })],
    );
    const reserveRatio = custodyAvailable === null || toUnits(ledgerLiability) === 0n ? null : Number(custodyAvailable) / Number(toUnits(ledgerLiability));
    await client.query(
      "INSERT INTO reserve_snapshots(business_date,asset,network,customer_liabilities,custody_assets,bank_assets,coverage_ratio,attestation_status,source_refs,created_by) VALUES($1,'USDT','BEP-20',$2,$3,NULL,$4,'UNATTESTED',$5::jsonb,$6) ON CONFLICT(business_date,asset,network) DO UPDATE SET customer_liabilities=EXCLUDED.customer_liabilities,custody_assets=EXCLUDED.custody_assets,coverage_ratio=EXCLUDED.coverage_ratio,attestation_status='UNATTESTED',source_refs=EXCLUDED.source_refs,created_by=EXCLUDED.created_by,created_at=now()",
      [businessDate, ledgerLiability, custodyAvailable === null ? null : fromUnits(custodyAvailable), reserveRatio, JSON.stringify({ custody: custodySource, independentAttestation: null }), operator],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  const report = {
    ok: custodyStatus === 'MATCHED' && bankStatus === 'MATCHED',
    businessDate,
    operator,
    walletIntegrity,
    customerCrypto: { asset: 'USDT', network: 'BEP-20', liability: ledgerLiability, custodyAssets: custodyAvailable === null ? null : fromUnits(custodyAvailable), difference: custodyCoverage === null ? null : fromUnits(custodyCoverage), status: custodyStatus },
    segregatedBankFunds: { currency: bank.currency, customerLiability: bankLiability === null ? null : fromUnits(bankLiability), bankBalance: bankBalance === null ? null : fromUnits(bankBalance), difference: bankCoverage === null ? null : fromUnits(bankCoverage), status: bankStatus },
    reserveAttestation: 'UNATTESTED',
    runIds,
    correctivePosting: 'NONE_AUTOMATIC',
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 3;
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: String(error?.code || error?.message || 'RECONCILIATION_FAILED').slice(0, 120) }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
