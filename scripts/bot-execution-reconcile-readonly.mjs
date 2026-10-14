import 'dotenv/config';
import crypto from 'node:crypto';
import ccxt from 'ccxt';
import pg from 'pg';
const { Client } = pg;
const EPS = 1e-10;
const failures = [];

function decryptCredential(record) {
  const key = Buffer.from(process.env.ENCRYPTION_MASTER_KEY || '', 'utf8');
  if (key.length !== 32) throw new Error('ENCRYPTION_MASTER_KEY is not a 32-byte key');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.auth_tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const parsed = JSON.parse(plaintext);
  if (!parsed?.apiKey || !parsed?.secret) throw new Error('Stored exchange credential is incomplete');
  return parsed;
}

function err(message, code = 'READONLY_AUDIT_FAILED') {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function loadRunnerRows(client) {
  const result = await client.query(`
    SELECT b.id::text AS "botId", b.external_bot_id AS "runnerId", u.firebase_uid AS uid,
           b.exchange, b.symbol AS pair, b.mode, ea.sandbox, b.status
      FROM bots b
      JOIN users u ON u.id=b.user_id
      LEFT JOIN exchange_accounts ea ON ea.id=b.exchange_account_id
     LIMIT 200
  `);
  return result.rows.map((r) => ({
    runnerId: r.runnerId,
    uid: r.uid,
    botId: r.botId,
    exchange: String(r.exchange || '').toLowerCase(),
    pair: String(r.pair || '').toUpperCase(),
    mode: String(r.mode || '').toLowerCase(),
    isSandbox: r.sandbox === true,
    status: r.status,
    positionQty: 0,
    avgEntryPrice: 0,
    pending: null,
  })).filter((r) => r.uid && r.botId && r.exchange && r.pair);
}

async function loadDbContext(client, runner) {
  const normalizedPairId = runner.pair.replace(/[^a-z0-9]+/gi, '').toLowerCase();
  const candidateBotIds = Array.from(new Set([
    runner.botId,
    `${runner.botId}_${normalizedPairId}`,
  ].filter(Boolean)));

  const botResult = await client.query(
    `SELECT b.id::text AS bot_id,b.external_bot_id,b.user_id::text AS user_id,b.symbol,
            ea.id::text AS exchange_account_id,ea.exchange,ea.sandbox,ea.status AS exchange_account_status
       FROM bots b
       JOIN users u ON u.id=b.user_id
       LEFT JOIN exchange_accounts ea ON ea.id=b.exchange_account_id
      WHERE u.firebase_uid=$1
        AND upper(b.symbol)=upper($3)
        AND lower(COALESCE(ea.exchange,''))=lower($4)
        AND COALESCE(ea.sandbox,false)=$5
        AND (b.external_bot_id = ANY($2::text[])
             OR LEFT(b.external_bot_id, length($6) + 1) = $6 || '_')
      ORDER BY CASE WHEN b.external_bot_id = $6 THEN 0 ELSE 1 END, b.updated_at DESC
      LIMIT 1`,
    [runner.uid, candidateBotIds, runner.pair, runner.exchange, runner.isSandbox, runner.botId],
  );
  const bot = botResult.rows[0] || null;
  if (!bot) return { bot: null };

  const positionResult = await client.query(
    `SELECT quantity,reserved_quantity,average_entry,realized_pnl,total_fees
       FROM positions WHERE bot_id=$1 AND upper(symbol)=upper($2)`,
    [bot.bot_id, runner.pair],
  );
  const position = positionResult.rows[0] || null;

  let order = null;
  let fills = { quantity: 0, quote: 0, fee: 0 };
  if (runner.pending?.clientOrderId) {
    const orderResult = await client.query(
      `SELECT id::text AS id,client_order_id,exchange_order_id,status,side,requested_qty,requested_price,exchange,symbol
         FROM orders
        WHERE user_id=$1 AND client_order_id=$2 AND lower(exchange)=lower($3) AND upper(symbol)=upper($4)
        LIMIT 1`,
      [bot.user_id, runner.pending.clientOrderId, runner.exchange, runner.pair],
    );
    order = orderResult.rows[0] || null;
    if (order) {
      const fillResult = await client.query(
        `SELECT COALESCE(SUM(quantity),0) AS quantity,
                COALESCE(SUM(quote_amount),0) AS quote,
                COALESCE(SUM(COALESCE(fee_amount,0)),0) AS fee
           FROM fills WHERE order_id=$1`,
        [order.id],
      );
      fills = {
        quantity: Number(fillResult.rows[0]?.quantity || 0),
        quote: Number(fillResult.rows[0]?.quote || 0),
        fee: Number(fillResult.rows[0]?.fee || 0),
      };
    }
  }
  return { bot, position, order, fills };
}

async function exchangeSnapshot(runner, credentialRow, pendingOrder) {
  const credential = decryptCredential(credentialRow);
  if (Boolean(credentialRow.sandbox) !== runner.isSandbox) {
    throw err(`Stored credential sandbox mismatch for ${runner.exchange}`, 'EXCHANGE_SANDBOX_SCOPE_MISMATCH');
  }
  const exchange = new ccxt[runner.exchange]({
    apiKey: credential.apiKey,
    secret: credential.secret,
    password: credential.password,
    enableRateLimit: true,
    timeout: Number(process.env.BINANCE_TESTNET_TIMEOUT_MS || 15000),
    options: { defaultType: 'spot', adjustForTimeDifference: true },
  });
  if (runner.isSandbox && typeof exchange.setSandboxMode === 'function') exchange.setSandboxMode(true);
  try {
    await exchange.loadMarkets();
    const [balance, openOrders] = await Promise.all([
      exchange.fetchBalance(),
      exchange.fetchOpenOrders(runner.pair),
    ]);
    let resolvedOrder = null;
    if (pendingOrder?.orderId) {
      try { resolvedOrder = await exchange.fetchOrder(String(pendingOrder.orderId), runner.pair); } catch {}
    }
    if (!resolvedOrder && pendingOrder?.clientOrderId) {
      const open = Array.isArray(openOrders) ? openOrders : [];
      resolvedOrder = open.find((o) => String(o.clientOrderId || o.info?.clientOrderId || o.info?.origClientOrderId || '') === String(pendingOrder.clientOrderId)) || null;
    }
    const base = runner.pair.split('/')[0];
    return {
      balanceQty: Number(balance?.total?.[base] ?? balance?.free?.[base] ?? 0),
      openOrders: (Array.isArray(openOrders) ? openOrders : []).map((o) => ({ id: String(o.id || ''), clientOrderId: o.clientOrderId || o.info?.clientOrderId || o.info?.origClientOrderId || null, status: o.status || null })),
      pendingOrder: resolvedOrder ? {
        id: String(resolvedOrder.id || ''),
        status: String(resolvedOrder.status || '').toLowerCase(),
        filledQty: Number(resolvedOrder.filled || 0),
        average: Number(resolvedOrder.average || resolvedOrder.price || 0),
        clientOrderId: resolvedOrder.clientOrderId || resolvedOrder.info?.clientOrderId || resolvedOrder.info?.origClientOrderId || null,
      } : null,
    };
  } finally {
    try { exchange.close(); } catch {}
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw err('DATABASE_URL is required', 'DATABASE_NOT_CONFIGURED');
  if (!process.env.ENCRYPTION_MASTER_KEY) throw err('ENCRYPTION_MASTER_KEY is required', 'ENCRYPTION_MASTER_KEY_REQUIRED');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const runners = await loadRunnerRows(client);
    const results = [];
    const [credentialRows] = await Promise.all([
      client.query(`SELECT u.firebase_uid,ec.exchange,ec.sandbox,ec.status,ec.ciphertext,ec.iv,ec.auth_tag\n                       FROM exchange_credentials ec JOIN users u ON u.id=ec.user_id\n                      WHERE ec.status='ACTIVE'`),
    ]);
    const credentials = credentialRows.rows;

    for (const runner of runners) {
      const base = {
        runnerId: runner.runnerId,
        botId: runner.botId,
        exchange: runner.exchange,
        sandbox: runner.isSandbox,
        pair: runner.pair,
        firestoreStatus: runner.status,
        firestorePositionQty: runner.positionQty,
      };
      try {
        const db = await loadDbContext(client, runner);
        if (!db.bot) throw err('No exchange-scoped durable bot row found', 'BOT_SCOPE_NOT_FOUND');
        const credential = credentials.find((r) => r.firebase_uid === runner.uid && String(r.exchange).toLowerCase() === runner.exchange && Boolean(r.sandbox) === runner.isSandbox);
        if (!credential) throw err('No active exchange credential matches runner exchange/sandbox', 'EXCHANGE_CREDENTIAL_SCOPE_NOT_FOUND');

        const ex = await exchangeSnapshot(runner, credential, runner.pending);
        const durableQty = Number(db.position?.quantity || 0);
        const settledQty = Number(db.fills?.quantity || 0);
        const exchangeFilled = Number(ex.pendingOrder?.filledQty || 0);
        const delta = Math.max(0, exchangeFilled - settledQty);
        const scopedOrderOk = !db.order || (String(db.order.exchange).toLowerCase() === runner.exchange && String(db.order.symbol).toUpperCase() === runner.pair);
        const positionDeltaConsistent = runner.pending?.side?.toLowerCase() !== 'sell' || delta <= EPS || durableQty + EPS >= delta;
        const mismatch = runner.pending
          ? (!db.order || !scopedOrderOk || !positionDeltaConsistent || (exchangeFilled > 0 && String(ex.pendingOrder?.id || '') !== String(runner.pending.orderId || ex.pendingOrder?.id || '')))
          : false;

        results.push({
          ...base,
          durablePositionQty: durableQty,
          reservedQuantity: Number(db.position?.reserved_quantity || 0),
          durableBotId: db.bot.external_bot_id || null,
          durableExchange: String(db.bot.exchange || ''),
          pendingFinancialOrderId: db.order?.id || null,
          pendingFinancialStatus: db.order?.status || null,
          settledFillQty: settledQty,
          exchangeBalanceQty: ex.balanceQty,
          exchangePendingOrder: ex.pendingOrder,
          exchangeOpenOrders: ex.openOrders.length,
          pendingDeltaQty: delta,
          status: mismatch ? 'MISMATCH' : 'HEALTHY',
          checks: {
            exchangeScoped: scopedOrderOk && String(db.bot.exchange).toLowerCase() === runner.exchange && Boolean(db.bot.sandbox) === runner.isSandbox,
            durableVsPendingDelta: positionDeltaConsistent,
            noUntrackedOpenOrders: ex.openOrders.length === 0 || Boolean(runner.pending),
          },
        });
      } catch (error) {
        failures.push({ ...base, error: String(error?.message || error), code: error?.code || 'AUDIT_FAILED' });
        results.push({ ...base, status: 'FAIL', error: String(error?.message || error), code: error?.code || 'AUDIT_FAILED' });
      }
    }

    const summary = {
      readOnly: true,
      exchangeWrites: 0,
      runnerCount: runners.length,
      healthy: results.filter((r) => r.status === 'HEALTHY').length,
      mismatches: results.filter((r) => r.status === 'MISMATCH').length,
      failures: failures.length,
      verdict: failures.length ? 'FAIL' : results.some((r) => r.status === 'MISMATCH') ? 'MISMATCH' : 'PASS',
      results,
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = failures.length ? 1 : results.some((r) => r.status === 'MISMATCH') ? 2 : 0;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error?.code || 'READONLY_AUDIT_FAILED', message: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
