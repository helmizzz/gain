import 'dotenv/config';
import { Client } from 'pg';

if (process.env.ALLOW_LOCAL_CLEAN_START !== 'true') {
  console.error('REFUSED: set ALLOW_LOCAL_CLEAN_START=true to erase LOCAL trading/runtime state.');
  process.exit(2);
}
if (process.env.LIVE_TRADING_ENABLED === 'true' && process.env.NODE_ENV === 'production') {
  console.error('REFUSED: clean-start cannot run against production live-trading runtime.');
  process.exit(3);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(4);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

const summary = { postgres: {}, cutoffs: 0 };


try {
  await client.connect();
  await client.query('BEGIN');
  // Child facts first; immutable wallet ledger and audit events are intentionally untouched.
  const tables = [
    'fills',
    'order_execution_reservations',
    'positions',
    'strategy_layers',
    'bot_strategy_configs',
    'bot_runtime_snapshots',
    'risk_events',
    'orders',
    'bots',
  ];
  for (const table of tables) {
    const result = await client.query(`DELETE FROM ${table}`);
    summary.postgres[table] = result.rowCount ?? 0;
  }

  const accounts = await client.query(`SELECT user_id, exchange, sandbox FROM exchange_accounts WHERE status = 'ACTIVE' OR status IS NULL`);
  const cutoff = new Date();
  for (const row of accounts.rows) {
    await client.query(
      `INSERT INTO exchange_context_resets (user_id, exchange, sandbox, cutoff_at, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, exchange, sandbox)
       DO UPDATE SET cutoff_at = EXCLUDED.cutoff_at, updated_at = now()`,
      [row.user_id, row.exchange, row.sandbox === true, cutoff],
    );
    summary.cutoffs += 1;
  }
  await client.query('COMMIT');


  console.log(JSON.stringify({ ok: true, message: 'LOCAL clean-start complete. Exchange credentials/accounts and internal wallet/audit data preserved.', summary }, null, 2));
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
