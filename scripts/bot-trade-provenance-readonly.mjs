import 'dotenv/config';
import crypto from 'node:crypto';
import ccxt from 'ccxt';
import pg from 'pg';
const { Client } = pg;

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

async function loadRunners(client) {
  const result = await client.query(`
    SELECT b.id::text AS "botId", b.external_bot_id AS "runnerId", u.firebase_uid AS uid,
           b.exchange, b.symbol AS pair, ea.sandbox, b.status
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
    sandbox: r.sandbox === true,
    status: r.status,
    pending: null,
  })).filter((r) => r.uid && r.botId && r.exchange && r.pair);
}

async function loadDb(client, runner) {
  const normalizedPairId = runner.pair.replace(/[^a-z0-9]+/gi, '').toLowerCase();
  const candidates = Array.from(new Set([runner.botId, `${runner.botId}_${normalizedPairId}`].filter(Boolean)));
  const bot = (await client.query(
    `SELECT b.id::text AS id,b.external_bot_id,b.symbol,ea.exchange,ea.sandbox
       FROM bots b
       JOIN users u ON u.id=b.user_id
       JOIN exchange_accounts ea ON ea.id=b.exchange_account_id
      WHERE u.firebase_uid=$1
        AND upper(b.symbol)=upper($3)
        AND lower(ea.exchange)=lower($4)
        AND ea.sandbox=$5
        AND (b.external_bot_id = ANY($2::text[]) OR LEFT(b.external_bot_id, length($6)+1) = $6 || '_')
      ORDER BY CASE WHEN b.external_bot_id=$6 THEN 0 ELSE 1 END, b.updated_at DESC
      LIMIT 1`,
    [runner.uid, candidates, runner.pair, runner.exchange, runner.sandbox, runner.botId],
  )).rows[0] || null;

  const orders = await client.query(
    `SELECT id::text AS id,client_order_id,exchange_order_id,status,side,requested_qty,requested_price,created_at,updated_at
       FROM orders
      WHERE user_id=(SELECT id FROM users WHERE firebase_uid=$1 LIMIT 1)
        AND client_order_id=$2
      LIMIT 1`,
    [runner.uid, String(runner.pending.clientOrderId || '')],
  );
  const order = orders.rows[0] || null;

  let fills = [];
  if (order) {
    fills = (await client.query(
      `SELECT f.id::text AS id,f.exchange_trade_id,f.quantity,f.price,f.quote_amount,f.fee_amount,f.fee_asset,f.filled_at,o.side
         FROM fills f
         JOIN orders o ON o.id=f.order_id
        WHERE f.order_id=$1
        ORDER BY f.filled_at ASC NULLS LAST`,
      [order.id],
    )).rows;
  }

  return { bot, order, fills };
}

async function fetchExchangeProvenance(runner, credentialRow) {
  const credential = decryptCredential(credentialRow);
  if (Boolean(credentialRow.sandbox) !== runner.sandbox) {
    throw new Error(`Credential sandbox mismatch for ${runner.exchange}`);
  }

  const Exchange = ccxt[runner.exchange];
  if (typeof Exchange !== 'function') throw new Error(`CCXT exchange is unavailable: ${runner.exchange}`);
  const exchange = new Exchange({
    apiKey: credential.apiKey,
    secret: credential.secret,
    password: credential.password,
    enableRateLimit: true,
    timeout: Number(process.env.BINANCE_TESTNET_TIMEOUT_MS || 15000),
    options: { defaultType: 'spot', adjustForTimeDifference: true },
  });
  if (runner.sandbox && typeof exchange.setSandboxMode === 'function') exchange.setSandboxMode(true);

  try {
    await exchange.loadMarkets();
    const orderId = String(runner.pending.orderId);
    const exactOrder = await exchange.fetchOrder(orderId, runner.pair);

    let exactTrades = [];
    let fetchMyTradesError = null;
    if (typeof exchange.fetchMyTrades === 'function') {
      try {
        exactTrades = await exchange.fetchMyTrades(runner.pair, undefined, 1000, { orderId });
      } catch (error) {
        fetchMyTradesError = String(error?.message || error);
        try {
          const since = Math.max(0, Number(exactOrder.timestamp || Date.now()) - 7 * 24 * 60 * 60 * 1000);
          const recent = await exchange.fetchMyTrades(runner.pair, since, 1000);
          exactTrades = (recent || []).filter((t) => String(t.order || t.info?.orderId || '') === orderId);
        } catch (fallbackError) {
          fetchMyTradesError = `${fetchMyTradesError}; fallback=${String(fallbackError?.message || fallbackError)}`;
        }
      }
    } else {
      fetchMyTradesError = 'Exchange adapter does not expose fetchMyTrades';
    }

    return {
      order: {
        id: String(exactOrder.id || ''),
        status: String(exactOrder.status || '').toLowerCase(),
        side: exactOrder.side || null,
        amount: Number(exactOrder.amount || 0),
        filled: Number(exactOrder.filled || 0),
        average: Number(exactOrder.average || exactOrder.price || 0),
        timestamp: exactOrder.timestamp || null,
        datetime: exactOrder.datetime || null,
        clientOrderId: exactOrder.clientOrderId || exactOrder.info?.clientOrderId || exactOrder.info?.origClientOrderId || null,
      },
      trades: (exactTrades || []).map((t) => ({
        id: String(t.id || ''),
        order: String(t.order || t.info?.orderId || ''),
        side: t.side || null,
        amount: Number(t.amount || 0),
        price: Number(t.price || 0),
        cost: Number(t.cost || 0),
        fee: t.fee || null,
        timestamp: t.timestamp || null,
        datetime: t.datetime || null,
      })),
      fetchMyTradesError,
    };
  } finally {
    try { exchange.close(); } catch {}
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!process.env.ENCRYPTION_MASTER_KEY) throw new Error('ENCRYPTION_MASTER_KEY is required');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const runners = await loadRunners(client);
    const credentialRows = (await client.query(
      `SELECT u.firebase_uid,ec.exchange,ec.sandbox,ec.status,ec.ciphertext,ec.iv,ec.auth_tag
         FROM exchange_credentials ec
         JOIN users u ON u.id=ec.user_id
        WHERE ec.status='ACTIVE'`,
    )).rows;

    const results = [];
    for (const runner of runners) {
      try {
        const db = await loadDb(client, runner);
        const credential = credentialRows.find((r) =>
          r.firebase_uid === runner.uid
          && String(r.exchange).toLowerCase() === runner.exchange
          && Boolean(r.sandbox) === runner.sandbox,
        );
        if (!credential) throw new Error('Active exchange credential not found for runner scope');

        const ex = await fetchExchangeProvenance(runner, credential);
        results.push({
          runnerId: runner.runnerId,
          botId: runner.botId,
          pair: runner.pair,
          exchange: runner.exchange,
          sandbox: runner.sandbox,
          firestorePending: {
            clientOrderId: runner.pending.clientOrderId || null,
            orderId: runner.pending.orderId || null,
            side: runner.pending.side || null,
            requestedQty: Number(runner.pending.requestedQty || 0),
          },
          postgres: {
            botId: db.bot?.external_bot_id || null,
            orderId: db.order?.id || null,
            orderStatus: db.order?.status || null,
            exchangeOrderId: db.order?.exchange_order_id || null,
            createdAt: db.order?.created_at || null,
            updatedAt: db.order?.updated_at || null,
            fills: db.fills,
          },
          exchange: ex,
          provenance: {
            exchangeTradesFound: ex.trades.length,
            postgresFillQty: db.fills.reduce((s, f) => s + Number(f.quantity || 0), 0),
            exchangeTradeQty: ex.trades.reduce((s, t) => s + Number(t.amount || 0), 0),
          },
          status: ex.trades.length > 0 ? 'TRADE_PROVENANCE_FOUND' : 'NO_TRADE_PROVENANCE',
        });
      } catch (error) {
        results.push({ runnerId: runner.runnerId, botId: runner.botId, pair: runner.pair, status: 'FAIL', error: String(error?.message || error) });
      }
    }

    console.log(JSON.stringify({ readOnly: true, exchangeWrites: 0, runnerCount: results.length, results }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
