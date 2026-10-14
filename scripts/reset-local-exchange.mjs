import 'dotenv/config';

if (process.env.ALLOW_FULL_DATA_RESET !== 'true') {
  console.error('Refusing full exchange-data reset. Set ALLOW_FULL_DATA_RESET=true for a deliberate local reset.');
  process.exit(2);
}
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!databaseUrl) { console.error('DATABASE_URL or POSTGRES_URL is required.'); process.exit(2); }
const { Client } = await import('pg');
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`TRUNCATE TABLE order_execution_reservations, fills, orders, positions, strategy_layers, bot_strategy_configs, bots, exchange_credential_history, exchange_certification_runs, exchange_credentials, exchange_accounts RESTART IDENTITY CASCADE`);
  await client.query(`UPDATE users SET active_exchange = NULL, updated_at = now()`);
  await client.query('COMMIT');
  console.log('Local exchange/trading data reset complete. Internal wallet/account ledger rows were preserved.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { await client.end(); }
