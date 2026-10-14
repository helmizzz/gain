import { randomUUID } from 'node:crypto';
import { getReferralActivationBonus } from '../config/licensePromo';
import { FINANCIAL_CONFIG, getGasTopupBonus, calculateProfitShareBreakdown } from '../config/financialConfig';

export function toLedgerAmount(value: number | string): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 1e10) / 1e10;
}

let poolPromise: Promise<any> | null = null;

async function getPool(): Promise<any> {
  if (!process.env.DATABASE_URL) {
    throw Object.assign(new Error('DATABASE_URL is required for authoritative financial persistence.'), { code: 'DATABASE_NOT_CONFIGURED' });
  }
  if (!poolPromise) {
    // @ts-ignore Optional runtime dependency is installed by production deployment.
    poolPromise = import('pg').then(({ Pool }) => new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX || 20),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
    }));
  }
  return poolPromise;
}

const inMemoryTables: Record<string, any[]> = {
  users: [],
  exchange_accounts: [],
  bots: [],
  system_settings: [{ key: 'live_trading_enabled', value: { enabled: false } }],
  wallet_accounts: [],
  wallet_ledger: [],
  licenses: [],
  vouchers: [],
  voucher_redemptions: [],
};

async function executeInMemoryQuery<T = any>(text: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
  const normalized = text.trim().toLowerCase();
  if (normalized.includes('select 1')) {
    return { rows: [{ '?column?': 1 }] as any, rowCount: 1 };
  }
  if (normalized.startsWith('alter table') || normalized.startsWith('create table') || normalized.startsWith('create index')) {
    return { rows: [], rowCount: 0 };
  }
  if (normalized.includes('from users') || normalized.includes('users u')) {
    const uid = values[0] ? String(values[0]) : '';
    const user = inMemoryTables.users.find((u) => u.firebase_uid === uid || u.id === uid);
    if (user) {
      return { rows: [{ ...user, id: user.id || randomUUID() }] as any, rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  if (normalized.includes('insert into users')) {
    const firebaseUid = String(values[0] || '');
    const email = values[1] ? String(values[1]) : 'user@gainkoin.io';
    const memberId = values[2] ? String(values[2]) : `GAIN-${Math.floor(100000 + Math.random() * 900000)}`;
    const status = values[3] ? String(values[3]) : 'active';
    let user = inMemoryTables.users.find((u) => u.firebase_uid === firebaseUid);
    if (!user) {
      user = { id: randomUUID(), firebase_uid: firebaseUid, email, member_id: memberId, status, created_at: new Date() };
      inMemoryTables.users.push(user);
    }
    return { rows: [user] as any, rowCount: 1 };
  }
  if (normalized.includes('system_settings')) {
    return { rows: [{ value: { enabled: false } }] as any, rowCount: 1 };
  }
  if (normalized.includes('exchange_accounts')) {
    return { rows: inMemoryTables.exchange_accounts as any, rowCount: inMemoryTables.exchange_accounts.length };
  }
  if (normalized.includes('bots')) {
    return { rows: inMemoryTables.bots as any, rowCount: inMemoryTables.bots.length };
  }
  return { rows: [], rowCount: 0 };
}

export async function dbQuery<T = any>(text: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
  try {
    const pool = await getPool();
    return await pool.query(text, values);
  } catch (error: any) {
    if (process.env.NODE_ENV !== 'production') {
      return executeInMemoryQuery<T>(text, values);
    }
    throw error;
  }
}

export async function dbTransaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
  let client: any;
  try {
    const pool = await getPool();
    client = await pool.connect();
  } catch (connError: any) {
    if (process.env.NODE_ENV !== 'production') {
      const mockClient = {
        query: (t: string, v: unknown[]) => executeInMemoryQuery(t, v),
      };
      return fn(mockClient);
    }
    throw connError;
  }

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await dbQuery('SELECT 1');
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error: any) {
    if (process.env.NODE_ENV !== 'production') {
      return { ok: true, latencyMs: Date.now() - started };
    }
    return { ok: false, latencyMs: Date.now() - started, error: String(error?.code || error?.message || 'DATABASE_ERROR').slice(0, 120) };
  }
}

export async function ensureUser(input: { firebaseUid: string; email?: string; memberId?: string; status?: string; username?: string; sponsorMemberId?: string }) {
  const cleanEmail = String(input.email || '').trim().toLowerCase();
  const masterEmail = String(process.env.GAIN_MASTER_OWNER_EMAIL || '').trim().toLowerCase();
  const adminEmails = String(process.env.ADMIN_EMAILS || '').toLowerCase();
  const isSuperAdmin = (masterEmail && cleanEmail === masterEmail) || (adminEmails && adminEmails.includes(cleanEmail));
  const targetRole = isSuperAdmin ? 'superadmin' : 'user';

  const result = await dbQuery<{ id: string; firebase_uid: string; member_id: string | null; role: string }>(
    `INSERT INTO users (firebase_uid, email, member_id, status, sponsor_user_id, role)
     VALUES ($1, $2, $3, COALESCE($4, 'active'), CASE WHEN CAST($5 AS text) IS NULL OR CAST($5 AS text) = '' THEN NULL ELSE (SELECT id FROM users WHERE member_id = CAST($5 AS text)) END, $6)
     ON CONFLICT (firebase_uid) DO UPDATE SET 
       email = COALESCE(EXCLUDED.email, users.email), 
       member_id = COALESCE(EXCLUDED.member_id, users.member_id), 
       sponsor_user_id = COALESCE(users.sponsor_user_id, EXCLUDED.sponsor_user_id), 
       role = CASE WHEN EXCLUDED.role = 'superadmin' THEN 'superadmin' ELSE users.role END,
       updated_at = now()
     RETURNING id, firebase_uid, member_id, role`,
    [input.firebaseUid, input.email || null, input.memberId || null, input.status || null, input.sponsorMemberId || null, targetRole],
  );
  return result.rows[0];
}

export async function getUserByFirebaseUid(firebaseUid: string) {
  const result = await dbQuery<any>('SELECT * FROM users WHERE firebase_uid = $1', [firebaseUid]);
  return result.rows[0] || null;
}

export async function getWalletSnapshot(firebaseUid: string) {
  const result = await dbQuery<any>(
    `SELECT u.id, u.firebase_uid, u.member_id, u.status, u.role,
            u.status AS member_status,
            sponsor.member_id AS sponsor_member_id,
            COALESCE(active_license.status, 'NONE') AS license_status,
            active_license.tier AS license_tier,
            active_license.license_type AS license_type,
            active_license.name AS license_name,
            active_license.max_active_bots AS max_active_bots,
            active_license.expires_at AS license_expires_at,
            COALESCE(w.currency, 'USDT') AS currency,
            COALESCE(w.available_balance, 0) AS available_balance,
            COALESCE(w.locked_balance, 0) AS locked_balance,
            COALESCE(w.total_inflow, 0) AS total_inflow,
            COALESCE(w.total_outflow, 0) AS total_outflow,
            COALESCE(w.gas_reserve, 0) AS gas_reserve,
            COALESCE(w.non_cash_gas_bonus, 0) AS non_cash_gas_bonus,
            COALESCE(w.withdrawable_trading_yield, 0) AS withdrawable_trading_yield,
            (SELECT da.address FROM wallet_deposit_addresses da
              WHERE da.user_id = u.id AND da.currency = 'USDT' AND da.network = 'BEP-20' AND da.provider = 'native-bsc' AND da.status = 'ACTIVE'
              LIMIT 1) AS deposit_address,
            COALESCE(s.two_factor_enabled, false) AS two_factor_enabled
       FROM users u
       LEFT JOIN wallet_accounts w ON w.user_id = u.id AND w.currency = 'USDT'
       LEFT JOIN security_credentials s ON s.user_id = u.id
       LEFT JOIN users sponsor ON sponsor.id = u.sponsor_user_id
       LEFT JOIN LATERAL (
         SELECT l.status, l.tier, l.license_type, l.name, l.max_active_bots, l.expires_at
           FROM licenses l
          WHERE l.user_id = u.id
            AND l.status = 'ACTIVE'
            AND (l.expires_at IS NULL OR l.expires_at > now())
          ORDER BY l.activated_at DESC
          LIMIT 1
       ) active_license ON TRUE
      WHERE u.firebase_uid = $1`,
    [firebaseUid],
  );
  return result.rows[0] || null;
}

export async function createWalletIfMissing(firebaseUid: string, currency = 'USDT') {
  await dbQuery(
    `INSERT INTO wallet_accounts (user_id, currency)
     SELECT id, $2 FROM users WHERE firebase_uid = $1
     ON CONFLICT (user_id, currency) DO NOTHING`,
    [firebaseUid, currency],
  );
}

export async function provisionWalletDepositAddress(input: { firebaseUid: string; address: string; provider: string; providerWalletId?: string }) {
  const address = input.address.trim().toLowerCase();
  const provider = input.provider.trim().slice(0,100);
  const providerWalletId = String(input.providerWalletId || '').trim().slice(0,200);
  if (!/^0x[a-f0-9]{40}$/.test(address)) throw Object.assign(new Error('A valid BSC EVM deposit address is required.'), { code: 'DEPOSIT_ADDRESS_INVALID', statusCode: 400 });
  if (!provider) throw Object.assign(new Error('Custody provider is required.'), { code: 'DEPOSIT_PROVIDER_REQUIRED', statusCode: 400 });
  if (!providerWalletId) throw Object.assign(new Error('Custody provider wallet ID is required.'), { code: 'DEPOSIT_PROVIDER_WALLET_ID_REQUIRED', statusCode: 400 });
  return dbTransaction(async (client) => {
    const user = await client.query(`SELECT id,member_id FROM users WHERE firebase_uid=$1 FOR UPDATE`, [input.firebaseUid]);
    if (!user.rows[0]) throw Object.assign(new Error('Account not provisioned.'), { code: 'ACCOUNT_NOT_PROVISIONED', statusCode: 404 });
    const prior = await client.query(`SELECT user_id,address,status,provider,provider_wallet_id FROM wallet_deposit_addresses WHERE provider=$1 AND provider_wallet_id=$2 FOR UPDATE`, [provider,providerWalletId]);
    if (prior.rows[0]) {
      if (String(prior.rows[0].user_id) !== String(user.rows[0].id) || String(prior.rows[0].address).toLowerCase() !== address || prior.rows[0].status !== 'ACTIVE') {
        throw Object.assign(new Error('Custody provider wallet ID is already bound to another assignment.'), { code: 'DEPOSIT_PROVIDER_WALLET_ID_CONFLICT', statusCode: 409 });
      }
      return { memberId: user.rows[0].member_id, ...prior.rows[0], currency: 'USDT', network: 'BEP-20', provider, provider_wallet_id: providerWalletId, replayed: true };
    }
    const activeForUser = await client.query(`SELECT id,address,provider,provider_wallet_id,status FROM wallet_deposit_addresses WHERE user_id=$1 AND currency='USDT' AND network='BEP-20' AND status='ACTIVE' FOR UPDATE`, [user.rows[0].id]);
    if (activeForUser.rows[0]) {
      if (String(activeForUser.rows[0].address).toLowerCase() !== address || String(activeForUser.rows[0].provider).toLowerCase() !== provider.toLowerCase()) {
        throw Object.assign(new Error('An active deposit address already exists for this user. It is immutable for the configured asset/network.'), { code: 'DEPOSIT_ADDRESS_IMMUTABLE_CONFLICT', statusCode: 409 });
      }
      return { memberId: user.rows[0].member_id, ...activeForUser.rows[0], currency: 'USDT', network: 'BEP-20', provider, provider_wallet_id: activeForUser.rows[0].provider_wallet_id, replayed: true };
    }
    const inserted = await client.query(
      `INSERT INTO wallet_deposit_addresses(user_id,currency,network,address,provider,provider_wallet_id,status)
       VALUES($1,'USDT','BEP-20',$2,$3,$4,'ACTIVE') RETURNING id,address,network,currency,provider,provider_wallet_id,status,created_at`,
      [user.rows[0].id,address,provider,providerWalletId],
    );
    return { memberId: user.rows[0].member_id, ...inserted.rows[0], replayed: false };
  });
}

export async function getWalletDepositAddresses(firebaseUid: string, network = 'BEP-20') {
  const result = await dbQuery<any>(
    `SELECT da.address, da.status, da.currency, da.network
       FROM wallet_deposit_addresses da
       JOIN users u ON u.id=da.user_id
      WHERE u.firebase_uid=$1 AND da.network=$2 AND da.currency='USDT'
      ORDER BY CASE WHEN da.status='ACTIVE' THEN 0 ELSE 1 END, da.created_at DESC`,
    [firebaseUid, network],
  );
  return result.rows;
}

export async function getActiveWalletDepositAssignment(firebaseUid: string, network = 'BEP-20') {
  const result = await dbQuery<any>(
    `SELECT da.id, da.user_id, da.address, da.status, da.currency, da.network, da.provider, da.provider_wallet_id, da.provider_wallet_type, da.qr_payload, da.asset_id, da.chain_id, da.created_at
       FROM wallet_deposit_addresses da
       JOIN users u ON u.id=da.user_id
      WHERE u.firebase_uid=$1 AND da.network=$2 AND da.currency='USDT' AND da.status='ACTIVE'
      ORDER BY da.created_at ASC LIMIT 1`,
    [firebaseUid, network],
  );
  return result.rows[0] || null;
}


export async function listFinancialWalletUsers(limit = 100) {
  const safeLimit=Math.min(Math.max(Number(limit)||100,1),500);
  const result=await dbQuery<any>(
    `SELECT
       u.firebase_uid, u.member_id, u.email,
       COALESCE(w.available_balance,0)::text AS available_balance,
       COALESCE(w.locked_balance,0)::text AS locked_balance,
       COALESCE(w.total_inflow,0)::text AS total_inflow,
       COALESCE(w.total_outflow,0)::text AS total_outflow,
       COALESCE(w.gas_reserve,0)::text AS gas_reserve,
       da.address AS deposit_address, da.provider, da.provider_wallet_id, da.created_at AS address_created_at,
       (SELECT max(d.created_at) FROM deposits d WHERE d.user_id=u.id) AS last_deposit_at,
       (SELECT max(wd.requested_at) FROM withdrawals wd WHERE wd.user_id=u.id) AS last_withdrawal_at,
       (SELECT count(*)::int FROM deposits d WHERE d.user_id=u.id AND d.status='PENDING') AS pending_deposits,
       (SELECT count(*)::int FROM withdrawals wd WHERE wd.user_id=u.id AND wd.status IN ('REVIEW','PROCESSING')) AS pending_withdrawals
     FROM users u
     LEFT JOIN wallet_accounts w ON w.user_id=u.id AND w.currency='USDT'
     LEFT JOIN wallet_deposit_addresses da ON da.user_id=u.id AND da.currency='USDT' AND da.network='BEP-20' AND da.provider='native-bsc' AND da.status='ACTIVE'
     ORDER BY u.created_at DESC
     LIMIT $1`,
    [safeLimit],
  );
  return result.rows;
}

export async function getFinancialWalletOverview() {
  const [totals, deposits, withdrawals, users, addresses, liability] = await Promise.all([
    dbQuery<any>(`SELECT
      COALESCE(SUM(available_balance),0)::text AS available,
      COALESCE(SUM(locked_balance),0)::text AS locked,
      COALESCE(SUM(total_inflow),0)::text AS inflow,
      COALESCE(SUM(total_outflow),0)::text AS outflow,
      COALESCE(SUM(gas_reserve),0)::text AS gas_reserve,
      COUNT(*)::int AS wallet_accounts
      FROM wallet_accounts WHERE currency='USDT'`),
    dbQuery<any>(`SELECT count(*)::int AS pending FROM deposits WHERE status='PENDING'`),
    dbQuery<any>(`SELECT count(*)::int AS pending FROM withdrawals WHERE status IN ('REVIEW','PROCESSING','SENT')`),
    dbQuery<any>(`SELECT count(*)::int AS total FROM users`),
    dbQuery<any>(`SELECT count(*)::int AS active FROM wallet_deposit_addresses WHERE currency='USDT' AND network='BEP-20' AND status='ACTIVE'`),
    getDailyCustomerLiability('USDT'),
  ]);
  return {
    totals: totals.rows[0],
    pendingDeposits: Number(deposits.rows[0]?.pending || 0),
    pendingWithdrawals: Number(withdrawals.rows[0]?.pending || 0),
    users: Number(users.rows[0]?.total || 0),
    activeDepositAddresses: Number(addresses.rows[0]?.active || 0),
    customerLiability: Number(liability || 0),
  };
}

export async function appendLedgerEntry(input: {
  firebaseUid: string;
  currency?: string;
  amount: number;
  direction: 'CREDIT' | 'DEBIT';
  type: string;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('Ledger amount must be positive.');
  return dbTransaction(async (client) => {
    const user = await client.query('SELECT id FROM users WHERE firebase_uid = $1 FOR UPDATE', [input.firebaseUid]);
    if (!user.rows[0]) throw new Error('User is not provisioned in the financial database.');
    const userId = user.rows[0].id;
    const currency = input.currency || 'USDT';
    const wallet = await client.query(
      `INSERT INTO wallet_accounts (user_id, currency)
       VALUES ($1, $2)
       ON CONFLICT (user_id, currency) DO UPDATE SET updated_at = now()
       RETURNING id, available_balance, locked_balance`,
      [userId, currency],
    );
    const account = wallet.rows[0];
    const before = Number(account.available_balance);
    const delta = input.direction === 'CREDIT' ? input.amount : -input.amount;
    const after = before + delta;
    if (after < 0) throw Object.assign(new Error('Insufficient available balance.'), { code: 'INSUFFICIENT_BALANCE' });
    await client.query(
      `UPDATE wallet_accounts SET available_balance = $2,
          total_inflow = total_inflow + CASE WHEN $3 = 'CREDIT' THEN $4 ELSE 0 END,
          total_outflow = total_outflow + CASE WHEN $3 = 'DEBIT' THEN $4 ELSE 0 END,
          updated_at = now()
       WHERE id = $1`,
      [account.id, after, input.direction, input.amount],
    );
    const entry = await client.query(
      `INSERT INTO wallet_ledger (account_id, direction, amount, balance_before, balance_after, entry_type, reference_type, reference_id, description, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, created_at`,
      [account.id, input.direction, input.amount, before, after, input.type, input.referenceType || null, input.referenceId || null, input.description || null, JSON.stringify(input.metadata || {})],
    );
    return { ledgerId: entry.rows[0].id, createdAt: entry.rows[0].created_at, balanceBefore: before, balanceAfter: after };
  });
}

export async function createAuditEvent(input: { userId?: string; firebaseUid?: string; botId?: string; eventType: string; correlationId?: string; payload?: Record<string, unknown> }) {
  let userId = input.userId || null;
  if (!userId && input.firebaseUid) {
    const user = await getUserByFirebaseUid(input.firebaseUid);
    userId = user?.id || null;
  }
  await dbQuery(
    `INSERT INTO audit_events (user_id, bot_id, event_type, correlation_id, payload) VALUES ($1,$2,$3,$4,$5)`,
    [userId, input.botId || null, input.eventType, input.correlationId || randomUUID(), JSON.stringify(input.payload || {})],
  );
}

export async function createOrderRecord(input: {
  firebaseUid: string; botId?: string; exchange: string; symbol: string; side: string; orderType: string;
  clientOrderId: string; idempotencyKey?: string; requestedQty?: number; requestedPrice?: number; expectedNotional?: number; status: string;
}) {
  const user = await ensureUser({ firebaseUid: input.firebaseUid });
  if (input.idempotencyKey) {
    const existing = await dbQuery<any>('SELECT id,status,exchange_order_id FROM orders WHERE idempotency_key=$1', [input.idempotencyKey]);
    if (existing.rows[0]) return { id: existing.rows[0].id as string, replayed: true, status: existing.rows[0].status };
  }
  let resolvedBotId: string | null = null;

  if (input.botId) {
    if (/^[0-9a-f-]{36}$/i.test(input.botId)) {
        resolvedBotId = input.botId;
    } else {
      const ownedBot = await dbQuery(
        `SELECT b.id
           FROM bots b
           JOIN exchange_accounts ea ON ea.id=b.exchange_account_id
          WHERE b.user_id = $1
            AND b.external_bot_id = $2
            AND lower(ea.exchange) = lower($3)
            AND upper(b.symbol) = upper($4)
          LIMIT 1`,
        [user.id, input.botId, input.exchange, input.symbol],
      );

      if (!ownedBot.rows[0]) {
        throw Object.assign(new Error('Bot runtime is not provisioned.'), {
          code: 'BOT_RUNTIME_NOT_FOUND',
        });
      }

      resolvedBotId = ownedBot.rows[0].id as string;
    }
  }

  if (resolvedBotId) {
    const scope = await dbQuery<any>(
      `SELECT b.id
         FROM bots b
         JOIN exchange_accounts ea ON ea.id=b.exchange_account_id
        WHERE b.id=$1 AND b.user_id=$2
          AND lower(ea.exchange)=lower($3)
          AND upper(b.symbol)=upper($4)
        LIMIT 1`,
      [resolvedBotId, user.id, input.exchange, input.symbol],
    );
    if (!scope.rows[0]) {
      throw Object.assign(new Error('Bot order exchange/symbol scope mismatch.'), { code: 'BOT_ORDER_SCOPE_MISMATCH', statusCode: 409 });
    }
  }

  const result = await dbQuery<any>(
    `INSERT INTO orders (client_order_id, idempotency_key, bot_id, user_id, exchange, symbol, side, order_type, requested_qty, requested_price, expected_notional, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (client_order_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
     RETURNING id,status`,
    [input.clientOrderId, input.idempotencyKey || null, resolvedBotId, user.id, input.exchange, input.symbol, input.side, input.orderType, input.requestedQty || null, input.requestedPrice || null, input.expectedNotional || null, input.status],
  );
  return { id: result.rows[0]?.id as string, replayed: false, status: result.rows[0]?.status };
}




export async function reserveOrderExecution(input: {
  orderId: string;
  firebaseUid: string;
  botId: string;
  exchange: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
}) {
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw Object.assign(new Error('Execution reservation quantity is invalid.'), { code: 'EXECUTION_RESERVATION_QTY_INVALID', statusCode: 400 });
  }

  return dbTransaction(async (client) => {
    const user = await client.query(`SELECT id FROM users WHERE firebase_uid=$1 LIMIT 1`, [input.firebaseUid]);
    if (!user.rows[0]) throw Object.assign(new Error('User is not provisioned.'), { code: 'ACCOUNT_NOT_PROVISIONED', statusCode: 409 });

    const orderResult = await client.query(
      `SELECT id, bot_id, user_id, exchange, symbol, side, requested_qty, status
         FROM orders WHERE id=$1 FOR UPDATE`,
      [input.orderId],
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Financial order not found.'), { code: 'FINANCIAL_ORDER_NOT_FOUND', statusCode: 404 });
    if (String(order.user_id) !== String(user.rows[0].id)) throw Object.assign(new Error('Order does not belong to the authenticated user.'), { code: 'ORDER_USER_MISMATCH', statusCode: 403 });
    if (String(order.exchange).toLowerCase() !== String(input.exchange).toLowerCase() || String(order.symbol).toUpperCase() !== String(input.symbol).toUpperCase() || String(order.side).toLowerCase() !== input.side) {
      throw Object.assign(new Error('Execution reservation exchange identity mismatch.'), { code: 'EXECUTION_EXCHANGE_SCOPE_MISMATCH', statusCode: 409 });
    }

    const existing = await client.query(`SELECT id, status, quantity FROM order_execution_reservations WHERE order_id=$1 FOR UPDATE`, [input.orderId]);
    if (existing.rows[0]) {
      const prior = existing.rows[0];
      if (String(prior.status) === 'RESERVED' || String(prior.status) === 'UNKNOWN') return { id: prior.id, replayed: true, status: prior.status, quantity: Number(prior.quantity) };
      throw Object.assign(new Error('Execution reservation is already terminal.'), { code: 'EXECUTION_RESERVATION_TERMINAL', statusCode: 409 });
    }

    const botResult = await client.query(
      `SELECT b.id,b.exchange_account_id,b.symbol,ea.exchange,ea.sandbox,ea.status AS exchange_account_status
         FROM bots b
         LEFT JOIN exchange_accounts ea ON ea.id=b.exchange_account_id
        WHERE b.external_bot_id=$1 AND b.user_id=$2
          AND lower(ea.exchange)=lower($3)
          AND upper(b.symbol)=upper($4)
        LIMIT 1`,
      [input.botId, user.rows[0].id, input.exchange, input.symbol],
    );
    const botRow = botResult.rows[0];
    if (!botRow) throw Object.assign(new Error('Bot financial runtime is not registered.'), { code: 'BOT_RUNTIME_NOT_FOUND', statusCode: 409 });
    if (String(botRow.exchange).toLowerCase() !== String(input.exchange).toLowerCase() || String(botRow.symbol).toUpperCase() !== String(input.symbol).toUpperCase()) {
      throw Object.assign(new Error('Bot exchange scope does not match the requested execution exchange.'), { code: 'BOT_EXCHANGE_SCOPE_MISMATCH', statusCode: 409 });
    }
    if (!botRow.exchange_account_id || String(botRow.exchange_account_status || '') !== 'ACTIVE') {
      throw Object.assign(new Error('The exchange account attached to this bot is not active.'), { code: 'BOT_EXCHANGE_ACCOUNT_INACTIVE', statusCode: 409 });
    }

    if (input.side === 'sell') {
      const positionResult = await client.query(
        `SELECT p.id, p.quantity, p.reserved_quantity, p.average_entry, p.realized_pnl
           FROM positions p
          WHERE p.bot_id=$1 AND upper(p.symbol)=upper($2)
          FOR UPDATE`,
        [botRow.id, input.symbol],
      );
      const position = positionResult.rows[0];
      if (!position) throw Object.assign(new Error('A durable position is required before submitting a SELL order.'), { code: 'POSITION_REQUIRED_FOR_SELL', statusCode: 409 });
      const available = Number(position.quantity || 0) - Number(position.reserved_quantity || 0);
      if (!Number.isFinite(available) || quantity > available + 1e-10) {
        throw Object.assign(new Error(`SELL quantity exceeds the available durable position: requested=${quantity}, available=${Math.max(0, available)}.`), { code: 'POSITION_QUANTITY_RESERVED', statusCode: 409 });
      }
      await client.query(`UPDATE positions SET reserved_quantity=reserved_quantity+$2,updated_at=now() WHERE id=$1`, [position.id, quantity]);
    }

    const created = await client.query(
      `INSERT INTO order_execution_reservations(order_id,bot_id,user_id,exchange,symbol,side,quantity,status,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,'RESERVED',$8::jsonb)
       RETURNING id,status,quantity`,
      [input.orderId, botRow.id, user.rows[0].id, input.exchange.toLowerCase(), input.symbol.toUpperCase(), input.side, quantity, JSON.stringify({ source: 'reserveOrderExecution', exchangeAccountId: botRow.exchange_account_id })],
    );

    return { id: created.rows[0].id, replayed: false, status: created.rows[0].status, quantity: Number(created.rows[0].quantity) };
  });
}

export async function releaseOrderExecution(orderId: string, status: 'RELEASED' | 'SETTLED' | 'UNKNOWN' = 'SETTLED') {
  return dbTransaction(async (client) => {
    const reservationResult = await client.query(
      `SELECT r.id,r.bot_id,r.side,r.quantity,r.status,o.symbol
         FROM order_execution_reservations r JOIN orders o ON o.id=r.order_id
        WHERE r.order_id=$1 FOR UPDATE`,
      [orderId],
    );
    const reservation = reservationResult.rows[0];
    if (!reservation) return { released: false, reason: 'NO_RESERVATION' };
    if (String(reservation.status) === 'RELEASED' || String(reservation.status) === 'SETTLED') return { released: false, reason: 'ALREADY_TERMINAL' };

    if (String(reservation.side).toLowerCase() === 'sell') {
      const position = await client.query(`SELECT id,reserved_quantity FROM positions WHERE bot_id=$1 AND symbol=$2 FOR UPDATE`, [reservation.bot_id, String(reservation.symbol || '')]);
      if (position.rows[0]) {
        const nextReserved = Math.max(0, Number(position.rows[0].reserved_quantity || 0) - Number(reservation.quantity || 0));
        await client.query(`UPDATE positions SET reserved_quantity=$2,updated_at=now() WHERE id=$1`, [position.rows[0].id, nextReserved]);
      }
    }

    await client.query(`UPDATE order_execution_reservations SET status=$2,released_at=now() WHERE id=$1`, [reservation.id, status]);
    return { released: true, status };
  });
}

export async function getDurableBotPosition(firebaseUid: string, externalBotId: string, symbol: string, exchange?: string, isSandbox?: boolean) {
  const params: unknown[] = [firebaseUid, externalBotId, symbol];
  let sql = `SELECT p.id::text AS position_id,p.quantity,p.reserved_quantity,p.average_entry,p.realized_pnl,p.total_fees,
            b.id::text AS bot_id,b.external_bot_id,b.exchange_account_id,ea.exchange,ea.sandbox,ea.status AS exchange_account_status
       FROM positions p
       JOIN bots b ON b.id=p.bot_id
       JOIN users u ON u.id=b.user_id
       LEFT JOIN exchange_accounts ea ON ea.id=b.exchange_account_id
      WHERE u.firebase_uid=$1 AND b.external_bot_id=$2 AND upper(b.symbol)=upper($3)`;
  if (exchange) { params.push(exchange); sql += ` AND lower(ea.exchange)=lower($${params.length})`; }
  if (typeof isSandbox === 'boolean') { params.push(isSandbox); sql += ` AND ea.sandbox=$${params.length}`; }
  sql += ` LIMIT 1`;
  const result = await dbQuery<any>(sql, params);
  return result.rows[0] || null;
}


export async function rebuildBotPositionFromFills(input: { firebaseUid: string; externalBotId: string; symbol: string; exchange: string }) {
  return dbTransaction(async (client) => {
    const botResult = await client.query(
      `SELECT b.id,b.external_bot_id,b.symbol,ea.exchange,ea.sandbox,ea.status AS exchange_account_status
         FROM bots b
         JOIN users u ON u.id=b.user_id
         LEFT JOIN exchange_accounts ea ON ea.id=b.exchange_account_id
        WHERE u.firebase_uid=$1 AND b.external_bot_id=$2 AND upper(b.symbol)=upper($3)
          AND lower(ea.exchange)=lower($4)
        LIMIT 1`,
      [input.firebaseUid, input.externalBotId, input.symbol, input.exchange],
    );
    const bot = botResult.rows[0];
    if (!bot) throw Object.assign(new Error('Bot financial runtime is not registered.'), { code: 'BOT_RUNTIME_NOT_FOUND', statusCode: 404 });
    if (String(bot.exchange || '').toLowerCase() !== String(input.exchange || '').toLowerCase()) {
      throw Object.assign(new Error('Position rebuild exchange scope does not match the bot exchange.'), { code: 'BOT_EXCHANGE_SCOPE_MISMATCH', statusCode: 409 });
    }

    const fillsResult = await client.query(
      `SELECT o.side,f.price,f.quantity,f.quote_amount,COALESCE(f.fee_amount,0) AS fee_amount,f.fee_asset,f.filled_at,f.id::text AS fill_id
         FROM fills f
         JOIN orders o ON o.id=f.order_id
        WHERE o.bot_id=$1 AND upper(o.symbol)=upper($2) AND lower(o.exchange)=lower($3)
        ORDER BY f.filled_at ASC,f.id ASC`,
      [bot.id, input.symbol, input.exchange],
    );

    const EPSILON = 1e-10;
    let quantity = 0;
    let averageEntry = 0;
    let realizedPnl = 0;
    let totalFees = 0;
    for (const fill of fillsResult.rows) {
      const side = String(fill.side || '').toLowerCase();
      const q = Number(fill.quantity || 0);
      const quote = Number(fill.quote_amount || 0);
      const price = Number(fill.price || 0);
      const fee = Number(fill.fee_amount || 0);
      if (!(q > 0) || !(price > 0) || !(quote > 0)) continue;
      totalFees += fee;
      if (side === 'buy') {
        const nextQty = quantity + q;
        averageEntry = nextQty > EPSILON ? ((quantity * averageEntry) + quote) / nextQty : 0;
        quantity = nextQty;
      } else if (side === 'sell') {
        if (q > quantity + EPSILON) {
          throw Object.assign(new Error(`Immutable fill history is inconsistent: SELL ${q} exceeds reconstructed position ${quantity}.`), { code: 'FILL_HISTORY_POSITION_INCONSISTENT', statusCode: 409 });
        }
        realizedPnl += (price - averageEntry) * q - fee;
        quantity = Math.max(0, quantity - q);
        if (quantity <= EPSILON) {
          quantity = 0;
          averageEntry = 0;
        }
      } else {
        throw Object.assign(new Error(`Unsupported historical fill side: ${side}`), { code: 'FILL_HISTORY_SIDE_INVALID', statusCode: 409 });
      }
    }

    const currentResult = await client.query(
      `SELECT id,quantity,reserved_quantity,average_entry,realized_pnl,total_fees
         FROM positions WHERE bot_id=$1 AND symbol=$2 FOR UPDATE`,
      [bot.id, input.symbol],
    );
    const current = currentResult.rows[0];
    const reserved = Number(current?.reserved_quantity || 0);
    if (reserved > 1e-10) throw Object.assign(new Error('Cannot rebuild a position while an execution reservation is active.'), { code: 'POSITION_REBUILD_RESERVATION_ACTIVE', statusCode: 409 });

    let positionRow;
    if (current) {
      const updated = await client.query(
        `UPDATE positions
            SET quantity=$2,average_entry=$3,realized_pnl=$4,total_fees=$5,reserved_quantity=0,updated_at=now()
          WHERE id=$1
          RETURNING *`,
        [current.id, quantity, averageEntry, realizedPnl, totalFees],
      );
      positionRow = updated.rows[0];
    } else {
      const created = await client.query(
        `INSERT INTO positions(bot_id,symbol,quantity,average_entry,realized_pnl,unrealized_pnl,total_fees,reserved_quantity)
         VALUES($1,$2,$3,$4,$5,0,$6,0)
         RETURNING *`,
        [bot.id, input.symbol, quantity, averageEntry, realizedPnl, totalFees],
      );
      positionRow = created.rows[0];
    }

    return {
      repaired: true,
      exchange: String(bot.exchange).toLowerCase(),
      symbol: input.symbol.toUpperCase(),
      botId: input.externalBotId,
      position: {
        quantity: Number(positionRow.quantity || 0),
        averageEntry: Number(positionRow.average_entry || 0),
        realizedPnl: Number(positionRow.realized_pnl || 0),
        totalFees: Number(positionRow.total_fees || 0),
      },
      source: 'IMMUTABLE_FILL_HISTORY',
      fillCount: fillsResult.rows.length,
      currentBeforeRepair: current ? {
        quantity: Number(current.quantity || 0),
        averageEntry: Number(current.average_entry || 0),
        realizedPnl: Number(current.realized_pnl || 0),
        totalFees: Number(current.total_fees || 0),
      } : null,
    };
  });
}

export async function createExchangeCertificationRun(input: {
  firebaseUid: string;
  exchange: string;
  stage: 'authenticated_readonly' | 'sandbox_demo_order' | 'micro_live_order' | 'reconcile' | 'recovery';
  mode: 'READ_ONLY' | 'SANDBOX_DEMO' | 'MICRO_LIVE' | 'RECONCILE' | 'RECOVERY';
  status?: 'RUNNING' | 'PASS' | 'FAIL' | 'BLOCKED' | 'WARNING';
  symbol?: string;
  side?: string;
  orderType?: string;
  clientOrderId?: string;
  exchangeOrderId?: string;
  requestedQty?: number;
  requestedPrice?: number;
  expectedNotional?: number;
  exchangeStatus?: string;
  filledQty?: number;
  averagePrice?: number;
  result?: Record<string, unknown>;
}) {
  const user = await ensureUser({ firebaseUid: input.firebaseUid });
  const result = await dbQuery<any>(
    `INSERT INTO exchange_certification_runs (
       id, user_id, firebase_uid, exchange, stage, mode, status, symbol, side, order_type,
       client_order_id, exchange_order_id, requested_qty, requested_price, expected_notional,
       exchange_status, filled_qty, average_price, result
     ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *`,
    [
      user.id, input.firebaseUid, input.exchange, input.stage, input.mode, input.status || 'RUNNING',
      input.symbol || null, input.side || null, input.orderType || null, input.clientOrderId || null,
      input.exchangeOrderId || null, input.requestedQty ?? null, input.requestedPrice ?? null, input.expectedNotional ?? null,
      input.exchangeStatus || null, input.filledQty ?? null, input.averagePrice ?? null, JSON.stringify(input.result || {}),
    ],
  );
  return result.rows[0];
}

export async function updateExchangeCertificationRun(id: string, input: Partial<{
  status: 'RUNNING' | 'PASS' | 'FAIL' | 'BLOCKED' | 'WARNING';
  exchangeOrderId: string;
  exchangeStatus: string;
  filledQty: number;
  averagePrice: number;
  result: Record<string, unknown>;
}>) {
  const result = await dbQuery<any>(
    `UPDATE exchange_certification_runs
        SET status = COALESCE($2, status),
            exchange_order_id = COALESCE($3, exchange_order_id),
            exchange_status = COALESCE($4, exchange_status),
            filled_qty = COALESCE($5, filled_qty),
            average_price = COALESCE($6, average_price),
            result = CASE WHEN $7::jsonb IS NULL THEN result ELSE result || $7::jsonb END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      id, input.status || null, input.exchangeOrderId || null, input.exchangeStatus || null,
      input.filledQty ?? null, input.averagePrice ?? null, input.result ? JSON.stringify(input.result) : null,
    ],
  );
  return result.rows[0] || null;
}

export async function getLatestExchangeCertificationRun(firebaseUid: string, exchange: string, stage?: string) {
  const params: unknown[] = [firebaseUid, exchange];
  let sql = `SELECT * FROM exchange_certification_runs WHERE firebase_uid = $1 AND exchange = $2`;
  if (stage) {
    params.push(stage);
    sql += ` AND stage = $3`;
  }
  sql += ` ORDER BY created_at DESC LIMIT 1`;
  const result = await dbQuery<any>(sql, params);
  return result.rows[0] || null;
}

export async function finalizeOrderWithFill(input: {
  orderId: string;
  exchangeOrderId: string;
  quantity: number;
  price: number;
  quoteAmount: number;
  feeAmount?: number;
  feeAsset?: string;
}) {
  return dbTransaction(async (client) => {
    /*
     * Exchange "filled" quantity is cumulative.
     * Therefore settlement must only apply:
     *
     *   cumulative exchange quantity
     *   - quantity already recorded in fills
     *
     * This makes repeated fetchOrder()/retry/reconciliation calls idempotent.
     */

    const orderResult = await client.query(
      `SELECT o.id, o.bot_id, o.user_id, o.exchange, o.symbol, o.side, o.requested_qty, o.status, o.exchange_order_id,
              b.external_bot_id, ea.exchange AS bot_exchange, ea.sandbox AS bot_sandbox, ea.status AS bot_exchange_status
         FROM orders o
         LEFT JOIN bots b ON b.id=o.bot_id
         LEFT JOIN exchange_accounts ea ON ea.id=b.exchange_account_id
        WHERE o.id = $1
        FOR UPDATE OF o`,
      [input.orderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      throw Object.assign(new Error('Financial order not found.'), {
        code: 'FINANCIAL_ORDER_NOT_FOUND',
      });
    }

    if (order.bot_id) {
      if (!order.bot_exchange || String(order.bot_exchange).toLowerCase() !== String(order.exchange).toLowerCase()) {
        throw Object.assign(new Error('Bot financial order exchange scope does not match its attached exchange account.'), { code: 'BOT_EXCHANGE_SCOPE_MISMATCH' });
      }
      if (String(order.bot_exchange_status || '') !== 'ACTIVE') {
        throw Object.assign(new Error('Bot exchange account is not active for settlement.'), { code: 'BOT_EXCHANGE_ACCOUNT_INACTIVE' });
      }
    }

    if (
      order.exchange_order_id &&
      String(order.exchange_order_id) !== String(input.exchangeOrderId)
    ) {
      throw Object.assign(new Error('Exchange order identity mismatch.'), {
        code: 'EXCHANGE_ORDER_ID_MISMATCH',
      });
    }

    const cumulativeQty = Number(input.quantity);
    const cumulativeQuote = Number(input.quoteAmount);
    const incomingPrice = Number(input.price);
    const incomingFee = Number(input.feeAmount || 0);
    const requestedQty = Number(order.requested_qty || 0);

    if (!Number.isFinite(cumulativeQty) || cumulativeQty <= 0) {
      throw Object.assign(new Error('Invalid cumulative fill quantity.'), {
        code: 'INVALID_FILL_QUANTITY',
      });
    }

    if (!Number.isFinite(cumulativeQuote) || cumulativeQuote <= 0) {
      throw Object.assign(new Error('Invalid cumulative fill quote amount.'), {
        code: 'INVALID_FILL_QUOTE',
      });
    }

    if (!Number.isFinite(incomingPrice) || incomingPrice <= 0) {
      throw Object.assign(new Error('Invalid fill price.'), {
        code: 'INVALID_FILL_PRICE',
      });
    }

    const settledResult = await client.query(
      `SELECT
          COALESCE(SUM(quantity), 0) AS settled_quantity,
          COALESCE(SUM(quote_amount), 0) AS settled_quote,
          COALESCE(SUM(COALESCE(fee_amount, 0)), 0) AS settled_fee
         FROM fills
        WHERE order_id = $1`,
      [input.orderId],
    );

    const settled = settledResult.rows[0] || {};

    const settledQty = Number(settled.settled_quantity || 0);
    const settledQuote = Number(settled.settled_quote || 0);
    const settledFee = Number(settled.settled_fee || 0);

    const EPSILON = 1e-10;

    const rawDeltaQty = cumulativeQty - settledQty;

    /*
     * Exchange must never move backwards.
     * If it does, stop settlement rather than corrupting position state.
     */
    if (rawDeltaQty < -EPSILON) {
      throw Object.assign(
        new Error(
          `Exchange cumulative fill regressed: exchange=${cumulativeQty}, settled=${settledQty}`,
        ),
        {
          code: 'FILL_QUANTITY_REGRESSION',
        },
      );
    }

    const isTerminalFilled =
      requestedQty > 0 &&
      cumulativeQty + EPSILON >= requestedQty;

    const targetStatus = isTerminalFilled
      ? 'filled'
      : 'partially_filled';

    /*
     * Replay:
     * Exchange reports the same cumulative quantity again.
     * Nothing must be added to fills or positions.
     */
    if (rawDeltaQty <= EPSILON) {
      await client.query(
        `UPDATE orders
            SET exchange_order_id = $2,
                status = $3,
                updated_at = now()
          WHERE id = $1`,
        [
          input.orderId,
          input.exchangeOrderId,
          targetStatus,
        ],
      );

      return {
        replayed: true,
        deltaQuantity: 0,
        cumulativeQuantity: cumulativeQty,
        status: targetStatus,
      };
    }

    const deltaQty = rawDeltaQty;

    /*
     * quoteAmount supplied by the caller represents cumulative
     * executed notional. Convert it into only the new delta.
     */
    let deltaQuote = cumulativeQuote - settledQuote;

    if (!Number.isFinite(deltaQuote) || deltaQuote <= EPSILON) {
      deltaQuote = deltaQty * incomingPrice;
    }

    const deltaPrice = deltaQuote / deltaQty;

    /*
     * Fee handling:
     * assume exchange order.fee.cost is cumulative for this
     * order snapshot. Only the incremental fee is applied.
     */
    let deltaFee = incomingFee - settledFee;

    if (!Number.isFinite(deltaFee) || deltaFee < 0) {
      deltaFee = 0;
    }

    /*
     * Lock position before modifying it.
     * The entire fill + position + order update remains inside
     * the same PostgreSQL transaction.
     */
    if (order.bot_id) {
      const positionResult = await client.query(
        `SELECT *
           FROM positions
          WHERE bot_id = $1
            AND symbol = $2
          FOR UPDATE`,
        [order.bot_id, order.symbol],
      );

      const position = positionResult.rows[0];
      const side = String(order.side || '').toLowerCase();

      const baseCoin = String(order.symbol).split('/')[0].trim().toUpperCase();
      const feeAssetUpper = String(input.feeAsset || '').trim().toUpperCase();
      const isBaseFee = (feeAssetUpper === baseCoin || (!input.feeAsset && deltaFee > 0 && deltaFee < deltaQty * 0.05));
      const netDeltaQty = isBaseFee ? Math.max(0, deltaQty - deltaFee) : deltaQty;

      if (!position) {
        if (side === 'sell') {
          throw Object.assign(
            new Error('Cannot apply sell fill without an existing position.'),
            {
              code: 'POSITION_MISSING_FOR_SELL',
            },
          );
        }

        const effectiveQty = netDeltaQty;
        const effectiveAvg = effectiveQty > 0 ? deltaQuote / effectiveQty : deltaPrice;

        await client.query(
          `INSERT INTO positions
            (bot_id, symbol, quantity, average_entry, realized_pnl, unrealized_pnl, total_fees)
           VALUES ($1, $2, $3, $4, 0, 0, $5)`,
          [
            order.bot_id,
            order.symbol,
            effectiveQty,
            effectiveAvg,
            deltaFee,
          ],
        );
      } else {
        const oldQty = Number(position.quantity || 0);
        const oldAvg = Number(position.average_entry || 0);

        let newQty = oldQty;
        let newAvg = oldAvg;
        let realized = Number(position.realized_pnl || 0);

        if (side === 'buy') {
          newQty = oldQty + netDeltaQty;

          newAvg =
            newQty > 0
              ? ((oldQty * oldAvg) + deltaQuote) / newQty
              : 0;
        } else if (side === 'sell') {
          if (deltaQty > oldQty + 1e-4) {
            throw Object.assign(
              new Error(
                `Sell fill exceeds database position: sell=${deltaQty}, position=${oldQty}`,
              ),
              {
                code: 'POSITION_QUANTITY_INSUFFICIENT',
              },
            );
          }

          const sold = Math.min(deltaQty, oldQty);

          const incrementalPnl = (deltaPrice - oldAvg) * sold - deltaFee;
          realized += incrementalPnl;

          if (incrementalPnl > EPSILON && order.user_id) {
            await deductProfitShareFromGasPoolClient(client, {
              userId: String(order.user_id),
              realizedProfitUsdt: incrementalPnl,
              orderId: input.orderId,
              pair: order.symbol,
            });
          }

          newQty = Math.max(0, oldQty - deltaQty);

          const dustThreshold = Math.max(EPSILON, Number(position.total_fees || 0) + 1e-6);
          if (newQty <= EPSILON || (newQty <= dustThreshold && newQty * deltaPrice < 1.0) || (newQty * deltaPrice < 0.2)) {
            newQty = 0;
            newAvg = 0;
          }
        } else {
          throw Object.assign(
            new Error(`Unsupported order side: ${side}`),
            {
              code: 'UNSUPPORTED_ORDER_SIDE',
            },
          );
        }

        await client.query(
          `UPDATE positions
              SET quantity = $3,
                  average_entry = $4,
                  realized_pnl = $5,
                  total_fees = total_fees + $6,
                  updated_at = now()
            WHERE bot_id = $1
              AND symbol = $2`,
          [
            order.bot_id,
            order.symbol,
            newQty,
            newAvg,
            realized,
            deltaFee,
          ],
        );
      }
    }

    /*
     * Insert ONLY the delta fill.
     *
     * exchange_trade_id currently stores exchange order id,
     * so we intentionally do not add a UNIQUE constraint here:
     * one exchange order can legitimately contain multiple fills.
     */
    await client.query(
      `INSERT INTO fills
        (order_id, exchange_trade_id, price, quantity, quote_amount, fee_amount, fee_asset, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        input.orderId,
        input.exchangeOrderId,
        deltaPrice,
        deltaQty,
        deltaQuote,
        deltaFee > 0 ? deltaFee : null,
        input.feeAsset || null,
        JSON.stringify({
          source: 'finalizeOrderWithFill',
          cumulativeQuantity: cumulativeQty,
          cumulativeQuote,
          cumulativeFee: incomingFee,
          settledQuantity: settledQty,
          settledQuote,
          settledFee,
        }),
      ],
    );

    // Authoritative referral trading-fee settlement. Only USDT-denominated
    // exchange fees are credited as USDT rewards; non-USDT fees remain exchange-native.
    if (deltaFee > EPSILON && String(input.feeAsset || '').toUpperCase() === 'USDT') {
      const orderUser = await client.query(
        `SELECT u.id AS source_user_id, u.sponsor_user_id
           FROM orders o
           JOIN users u ON u.id = o.user_id
          WHERE o.id = $1`,
        [input.orderId],
      );
      const sponsorId = orderUser.rows[0]?.sponsor_user_id;
      if (sponsorId) {
        const reward = Number((deltaFee * FINANCIAL_CONFIG.referral.tradingFeeCashPct / 100).toFixed(10));
        if (reward > EPSILON) {
          const sponsorWallet = await client.query(
            `SELECT id, available_balance, withdrawable_trading_yield
               FROM wallet_accounts
              WHERE user_id = $1 AND currency = 'USDT'
              FOR UPDATE`,
            [sponsorId],
          );
          if (sponsorWallet.rows[0]) {
            const before = Number(sponsorWallet.rows[0].available_balance || 0);
            const after = before + reward;
            await client.query(
              `UPDATE wallet_accounts
                  SET available_balance = $2,
                      withdrawable_trading_yield = withdrawable_trading_yield + $3,
                      total_inflow = total_inflow + $3,
                      version = version + 1,
                      updated_at = now()
                WHERE id = $1`,
              [sponsorWallet.rows[0].id, after, reward],
            );
            await client.query(
              `INSERT INTO wallet_ledger
                (account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description,metadata)
               VALUES ($1,'CREDIT',$2,$3,$4,'REFERRAL_TRADING_FEE','ORDER',$5,$6,$7::jsonb)`,
              [sponsorWallet.rows[0].id, reward, before, after, input.orderId, '20% cash referral share of USDT trading fee', JSON.stringify({ feeUsdt: deltaFee, pct: FINANCIAL_CONFIG.referral.tradingFeeCashPct })],
            );
            await client.query(
              `INSERT INTO referral_events(sponsor_user_id,source_user_id,event_type,gross_amount,reward_amount,cashable,metadata)
               VALUES($1,$2,'TRADING_FEE',$3,$4,true,$5)`,
              [sponsorId, orderUser.rows[0].source_user_id, deltaFee, reward, JSON.stringify({ orderId: input.orderId, feeAsset: input.feeAsset || 'USDT' })],
            );
          }
        }
      }
    }

    await client.query(
      `UPDATE orders
          SET exchange_order_id = $2,
              status = $3,
              updated_at = now()
        WHERE id = $1`,
      [
        input.orderId,
        input.exchangeOrderId,
        targetStatus,
      ],
    );

    return {
      replayed: false,
      deltaQuantity: deltaQty,
      cumulativeQuantity: cumulativeQty,
      deltaQuote,
      deltaPrice,
      deltaFee,
      status: targetStatus,
    };
  });
}


export async function saveTwoFactorSecret(firebaseUid: string, payload: { enabled: boolean; ciphertext?: string; iv?: string; authTag?: string }) {
  const user = await getUserByFirebaseUid(firebaseUid);
  if (!user) throw new Error('User is not provisioned in the financial database.');
  await dbQuery(
    `INSERT INTO security_credentials (user_id, two_factor_enabled, two_factor_secret_ciphertext, two_factor_secret_iv, two_factor_secret_auth_tag)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET two_factor_enabled=EXCLUDED.two_factor_enabled,
       two_factor_secret_ciphertext=EXCLUDED.two_factor_secret_ciphertext,
       two_factor_secret_iv=EXCLUDED.two_factor_secret_iv,
       two_factor_secret_auth_tag=EXCLUDED.two_factor_secret_auth_tag,
       updated_at=now()`,
    [user.id, payload.enabled, payload.enabled ? (payload.ciphertext || null) : null, payload.enabled ? (payload.iv || null) : null, payload.enabled ? (payload.authTag || null) : null],
  );
}

export async function getTwoFactorSecretRecord(firebaseUid: string) {
  const result = await dbQuery<any>(
    `SELECT s.two_factor_enabled, s.two_factor_secret_ciphertext, s.two_factor_secret_iv, s.two_factor_secret_auth_tag
       FROM security_credentials s JOIN users u ON u.id=s.user_id WHERE u.firebase_uid=$1`,
    [firebaseUid],
  );
  return result.rows[0] || null;
}

export async function getSystemSetting<T = unknown>(key: string): Promise<T | null> {
  const result = await dbQuery<any>('SELECT value FROM system_settings WHERE key=$1', [key]);
  return result.rows[0]?.value ?? null;
}

export async function setSystemSetting(key: string, value: unknown, updatedByFirebaseUid?: string): Promise<void> {
  const user = updatedByFirebaseUid ? await getUserByFirebaseUid(updatedByFirebaseUid) : null;
  await dbQuery(`INSERT INTO system_settings(key,value,updated_by) VALUES($1,$2::jsonb,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`, [key, JSON.stringify(value), user?.id || null]);
}


export async function queueNativeBscWithdrawal(withdrawalId: string, maxAutoUsdt?: number) {
  return dbTransaction(async (client) => {
    const row = await client.query(
      `SELECT id,user_id,status,net_amount,screening_status,screening_provider FROM withdrawals WHERE id=$1 FOR UPDATE`,
      [withdrawalId],
    );
    if (!row.rows[0]) throw Object.assign(new Error('Withdrawal not found.'), { code: 'WITHDRAWAL_NOT_FOUND', statusCode: 404 });
    if (row.rows[0].status === 'PROCESSING' || row.rows[0].status === 'SENT') return { replayed: true, status: row.rows[0].status, autoApproved: true };
    if (row.rows[0].status !== 'REVIEW') throw Object.assign(new Error('Withdrawal is not ready for native BSC processing.'), { code: 'WITHDRAWAL_STATE_CONFLICT', statusCode: 409 });
    
    // Safety check 1: if net_amount exceeds super admin threshold limit, require 2-Admin approval!
    const effectiveMaxAuto = (maxAutoUsdt !== undefined && Number.isFinite(maxAutoUsdt) && maxAutoUsdt > 0) ? maxAutoUsdt : 50;
    if (Number(row.rows[0].net_amount) > effectiveMaxAuto) {
      return { replayed: false, status: 'REVIEW', autoApproved: false, message: `Withdrawal net amount (${row.rows[0].net_amount} USDT) exceeds auto-withdrawal limit (${effectiveMaxAuto} USDT). 2-Admin approval is required.` };
    }

    // Safety check 2: 24-hour velocity limit (max 2 auto withdrawals, max aggregate amount per user in 24h)
    const velocityCheck = await client.query(
      `SELECT count(*)::int AS count_24h, COALESCE(SUM(net_amount), 0)::numeric AS sum_24h
         FROM withdrawals
        WHERE user_id = $1
          AND status IN ('PROCESSING', 'SENT', 'CONFIRMED')
          AND (screening_reason_code = 'NATIVE_BSC_AUTO_CLEAR' OR provider = 'native-bsc')
          AND requested_at >= now() - interval '24 hours'
          AND id <> $2`,
      [row.rows[0].user_id, withdrawalId],
    );
    const count24h = Number(velocityCheck.rows[0]?.count_24h || 0);
    const sum24h = Number(velocityCheck.rows[0]?.sum_24h || 0);
    const maxDailyCount = 2;
    const maxDailySum = Math.max(effectiveMaxAuto * 2, 100);

    if (count24h >= maxDailyCount || (sum24h + Number(row.rows[0].net_amount)) > maxDailySum) {
      return {
        replayed: false,
        status: 'REVIEW',
        autoApproved: false,
        message: `Withdrawal exceeds 24-hour auto-withdrawal velocity limit (${count24h}/${maxDailyCount} txs, ${(sum24h + Number(row.rows[0].net_amount)).toFixed(2)}/${maxDailySum} USDT). 2-Admin approval is required.`,
      };
    }

    const provider = 'native-bsc';
    const eventId = `native-bsc:auto-clear:${withdrawalId}`;
    await client.query(
      `INSERT INTO withdrawal_screening_events(withdrawal_id,provider,provider_event_id,status,reason_code)
       VALUES($1,$2,$3,'CLEAR','NATIVE_BSC_AUTO_CLEAR')
       ON CONFLICT(provider,provider_event_id) DO NOTHING`,
      [withdrawalId, provider, eventId],
    );
    await client.query(
      `UPDATE withdrawals
          SET screening_status='CLEAR', screening_provider=$2, screening_reference=$3,
              screening_checked_at=now(), screening_reason_code='NATIVE_BSC_AUTO_CLEAR',
              status='PROCESSING', approved_at=COALESCE(approved_at,now())
        WHERE id=$1 AND status='REVIEW'`,
      [withdrawalId, provider, eventId],
    );
    return { replayed: false, status: 'PROCESSING', autoApproved: true };
  });
}

export async function listNativeBscWithdrawalCandidates(limit = 10) {
  const safeLimit = Math.min(Math.max(Math.floor(Number(limit) || 10), 1), 50);
  const result = await dbQuery<any>(
    `SELECT w.id,w.user_id,u.firebase_uid,u.member_id,w.destination_address,w.amount,w.fee,w.net_amount,
            w.status,w.tx_hash,w.screening_status,w.processor_attempt_count,w.requested_at
       FROM withdrawals w
       JOIN users u ON u.id=w.user_id
      WHERE w.status IN ('PROCESSING', 'SENT')
        AND w.network='BEP-20'
        AND w.currency='USDT'
        AND w.screening_status='CLEAR'
        AND (w.provider IS NULL OR w.provider='native-bsc')
        AND (w.processor_claim_id IS NULL OR w.processor_lease_until<=now())
        AND w.processor_attempt_count < $1
      ORDER BY w.approved_at ASC NULLS LAST,w.requested_at ASC
      LIMIT $2`,
    [Math.max(Number(process.env.WITHDRAWAL_MAX_PROCESSOR_ATTEMPTS || 5), 1), safeLimit],
  );
  return result.rows;
}

export async function claimNativeBscWithdrawal(withdrawalId: string, processorId: string) {
  return dbTransaction(async (client) => {
    const claimId = randomUUID();
    const row = await client.query(
      `UPDATE withdrawals
          SET processor_claim_id=$2,processor_claimed_by=$3,processor_claimed_at=now(),
              processor_lease_until=now()+interval '2 minutes',
              processor_attempt_count=processor_attempt_count+1,
              provider='native-bsc'
        WHERE id=$1 AND status IN ('PROCESSING', 'SENT') AND screening_status='CLEAR'
          AND (processor_claim_id IS NULL OR processor_lease_until<=now())
        RETURNING id,destination_address,amount,fee,net_amount,network,currency,processor_attempt_count,tx_hash,status`,
      [withdrawalId, claimId, processorId.slice(0, 80)],
    );
    if (!row.rows[0]) return null;
    return { claimId, ...row.rows[0] };
  });
}

export async function recordNativeBscWithdrawalSent(input: {
  withdrawalId: string;
  claimId: string;
  txHash: string;
  hotWalletAddress?: string;
}) {
  return dbTransaction(async (client) => {
    const row = await client.query(
      `SELECT id, status, processor_claim_id, tx_hash FROM withdrawals WHERE id=$1 FOR UPDATE`,
      [input.withdrawalId],
    );
    if (!row.rows[0]) throw Object.assign(new Error('Withdrawal not found.'), { code: 'WITHDRAWAL_NOT_FOUND', statusCode: 404 });
    const w = row.rows[0];
    if (w.status === 'CONFIRMED') return { replayed: true, status: 'CONFIRMED', txHash: w.tx_hash };
    if (String(w.processor_claim_id) !== input.claimId) {
      throw Object.assign(new Error('Native BSC withdrawal claim is invalid.'), { code: 'PAYOUT_CLAIM_INVALID', statusCode: 409 });
    }
    await client.query(
      `UPDATE withdrawals
          SET status='SENT',
              tx_hash=$2,
              provider='native-bsc',
              provider_withdrawal_id=$2,
              provider_status='SENT',
              payout_submitted_at=COALESCE(payout_submitted_at, now()),
              processor_lease_until=now() + interval '5 minutes',
              metadata = metadata || $3::jsonb
        WHERE id=$1`,
      [
        input.withdrawalId,
        input.txHash.toLowerCase(),
        JSON.stringify({ hotWalletAddress: input.hotWalletAddress, broadcastAt: new Date().toISOString() }),
      ],
    );
    return { replayed: false, status: 'SENT', txHash: input.txHash.toLowerCase() };
  });
}

export async function settleNativeBscWithdrawal(input: { withdrawalId: string; claimId: string; txHash: string; metadata?: Record<string, unknown> }) {
  return dbTransaction(async (client) => {
    const reused = await client.query(
      `SELECT id FROM withdrawals WHERE lower(tx_hash)=lower($1) AND id<>$2 LIMIT 1`,
      [input.txHash, input.withdrawalId],
    );
    if (reused.rows[0]) throw Object.assign(new Error('This transaction hash is already assigned to another withdrawal.'), { code: 'WITHDRAWAL_TX_HASH_REUSED', statusCode: 409 });
    const row = await client.query(
      `SELECT w.*,wa.id AS account_id,wa.locked_balance
         FROM withdrawals w
         JOIN wallet_accounts wa ON wa.user_id=w.user_id AND wa.currency=w.currency
        WHERE w.id=$1 FOR UPDATE`,
      [input.withdrawalId],
    );
    if (!row.rows[0]) throw Object.assign(new Error('Withdrawal not found.'), { code: 'WITHDRAWAL_NOT_FOUND', statusCode: 404 });
    const w = row.rows[0];
    if (w.status === 'CONFIRMED') {
      if (String(w.tx_hash || '').toLowerCase() !== input.txHash.toLowerCase()) throw Object.assign(new Error('Withdrawal was already settled with another transaction hash.'), { code: 'WITHDRAWAL_SETTLEMENT_CONFLICT', statusCode: 409 });
      return { replayed: true, status: w.status, txHash: w.tx_hash };
    }
    if (!['PROCESSING', 'SENT'].includes(String(w.status)) || String(w.processor_claim_id) !== input.claimId) throw Object.assign(new Error('Native BSC withdrawal claim is invalid.'), { code: 'PAYOUT_CLAIM_INVALID', statusCode: 409 });
    if (Number(w.locked_balance) < Number(w.amount)) throw Object.assign(new Error('Locked withdrawal balance is below the request amount.'), { code: 'WITHDRAWAL_LOCK_INVARIANT_FAILED', statusCode: 409 });
    const locked = Number(w.locked_balance) - Number(w.amount);
    await client.query(`UPDATE wallet_accounts SET locked_balance=$2,version=version+1,updated_at=now() WHERE id=$1`, [w.account_id, locked]);
    await client.query(
      `UPDATE withdrawals
          SET status='CONFIRMED',tx_hash=$2,provider='native-bsc',provider_withdrawal_id=$2,
              provider_status='CONFIRMED',payout_submitted_at=COALESCE(payout_submitted_at,now()),processed_at=now(),
              settlement_verified_at=now(),metadata=metadata || $3::jsonb
        WHERE id=$1`,
      [input.withdrawalId, input.txHash.toLowerCase(), JSON.stringify(input.metadata || {})],
    );
    await client.query(
      `INSERT INTO native_bsc_transaction_events(event_type,tx_hash,user_id,destination_address,amount,status,metadata)
       VALUES('WITHDRAWAL',$1,$2,$3,$4,'CONFIRMED',$5::jsonb)
       ON CONFLICT(network,tx_hash,event_type,log_index) DO NOTHING`,
      [input.txHash.toLowerCase(), w.user_id, w.destination_address, Number(w.net_amount), JSON.stringify({ withdrawalId: input.withdrawalId, nativeBsc: true })],
    );
    return { replayed: false, status: 'CONFIRMED', txHash: input.txHash.toLowerCase() };
  });
}

export async function failNativeBscWithdrawal(withdrawalId: string, claimId: string, reason: string) {
  return dbTransaction(async (client) => {
    const row = await client.query(
      `SELECT w.*,wa.id AS account_id,wa.available_balance,wa.locked_balance
         FROM withdrawals w
         JOIN wallet_accounts wa ON wa.user_id=w.user_id AND wa.currency=w.currency
        WHERE w.id=$1 FOR UPDATE`,
      [withdrawalId],
    );
    if (!row.rows[0]) throw Object.assign(new Error('Withdrawal not found.'), { code: 'WITHDRAWAL_NOT_FOUND' });
    const w = row.rows[0];
    if (w.status === 'FAILED') return { replayed: true, status: 'FAILED' };
    if (!['PROCESSING', 'SENT'].includes(String(w.status)) || String(w.processor_claim_id) !== claimId) throw Object.assign(new Error('Native BSC withdrawal claim is invalid.'), { code: 'PAYOUT_CLAIM_INVALID', statusCode: 409 });
    const available = Number(w.available_balance) + Number(w.amount);
    const locked = Number(w.locked_balance) - Number(w.amount);
    if (locked < 0) throw Object.assign(new Error('Withdrawal lock invariant failed.'), { code: 'WITHDRAWAL_LOCK_INVARIANT_FAILED', statusCode: 409 });
    await client.query(`UPDATE wallet_accounts SET available_balance=$2,locked_balance=$3,total_outflow=GREATEST(0,total_outflow-$4),version=version+1,updated_at=now() WHERE id=$1`, [w.account_id, available, locked, Number(w.amount)]);
    const reversal = await client.query(
      `INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description,metadata)
       VALUES($1,'CREDIT',$2,$3,$4,'WITHDRAWAL_FAILED_REVERSAL','WITHDRAWAL',$5,$6,$7::jsonb) RETURNING id`,
      [w.account_id, Number(w.amount), Number(w.available_balance), available, withdrawalId, `Native BSC withdrawal failed: ${reason.slice(0, 400)}`, JSON.stringify({ originalEntryType: 'WITHDRAWAL_HOLD' })],
    );
    await client.query(`UPDATE withdrawals SET status='FAILED',failure_reason=$2,rejection_reversal_ledger_id=$3,processed_at=now(),processor_lease_until=NULL WHERE id=$1`, [withdrawalId, reason.slice(0, 500), reversal.rows[0].id]);
    return { replayed: false, status: 'FAILED', reversalLedgerId: reversal.rows[0].id };
  });
}

export async function listFinancialTransactions(limit = 200) {
  const safeLimit = Math.min(Math.max(Math.floor(Number(limit) || 200), 1), 1000);
  const result = await dbQuery<any>(
    `SELECT * FROM (
       SELECT d.created_at AS occurred_at,'DEPOSIT' AS type,d.id::text AS id,u.member_id,u.email,
              d.amount::text AS amount,d.status,d.network,d.tx_hash,d.destination_address,d.source_address,
              NULL::text AS destination,d.confirmations,d.credited_at AS finalized_at
         FROM deposits d JOIN users u ON u.id=d.user_id
       UNION ALL
       SELECT w.requested_at,'WITHDRAWAL',w.id::text,u.member_id,u.email,
              w.net_amount::text,w.status,w.network,w.tx_hash,NULL::text,w.destination_address,
              w.destination_address,0,w.processed_at
         FROM withdrawals w JOIN users u ON u.id=w.user_id
       UNION ALL
       SELECT l.created_at,'LEDGER',l.id::text,u.member_id,u.email,
              CASE WHEN l.direction='CREDIT' THEN l.amount::text ELSE ('-'||l.amount::text) END,
              l.entry_type,'INTERNAL',NULL,NULL,NULL,NULL,0,l.created_at
         FROM wallet_ledger l
         JOIN wallet_accounts wa ON wa.id=l.account_id
         JOIN users u ON u.id=wa.user_id
       UNION ALL
       SELECT t.created_at,'TRANSFER',t.id::text,u.member_id,u.email,
              ('-'||t.amount::text),t.status,'INTERNAL',NULL,NULL,NULL,NULL,0,t.completed_at
         FROM transfers t
         JOIN users u ON u.id=t.sender_user_id
     ) tx
     ORDER BY occurred_at DESC
     LIMIT $1`,
    [safeLimit],
  );
  return result.rows;
}

export async function getNativeBscUserBalances(limit = 2000) {
  const safeLimit = Math.min(Math.max(Math.floor(Number(limit) || 2000), 1), 5000);
  const result = await dbQuery<any>(
    `SELECT u.id::text AS user_id,u.firebase_uid,u.member_id,u.email,u.status AS account_status,
            COALESCE(w.available_balance,0)::text AS available_balance,
            COALESCE(w.locked_balance,0)::text AS locked_balance,
            COALESCE(w.gas_reserve,0)::text AS gas_reserve,
            COALESCE(w.total_inflow,0)::text AS total_inflow,
            COALESCE(w.total_outflow,0)::text AS total_outflow,
            da.address AS deposit_address,da.derivation_index,da.derivation_path,
            (SELECT COUNT(*)::int FROM deposits d WHERE d.user_id=u.id) AS deposit_count,
            (SELECT COUNT(*)::int FROM withdrawals wd WHERE wd.user_id=u.id) AS withdrawal_count,
            GREATEST((SELECT MAX(d.created_at) FROM deposits d WHERE d.user_id=u.id),(SELECT MAX(wd.requested_at) FROM withdrawals wd WHERE wd.user_id=u.id)) AS last_financial_activity
       FROM users u
       LEFT JOIN wallet_accounts w ON w.user_id=u.id AND w.currency='USDT'
       LEFT JOIN wallet_deposit_addresses da ON da.user_id=u.id AND da.currency='USDT' AND da.network='BEP-20' AND da.provider='native-bsc' AND da.status='ACTIVE'
      ORDER BY u.created_at DESC
      LIMIT $1`,
    [safeLimit],
  );
  return result.rows;
}

export async function closeDatabase() {
  if (!poolPromise) return;
  const pool = await poolPromise;
  await pool.end();
  poolPromise = null;
}

export interface CreateVoucherInput {
  code: string;
  discountType: 'PERCENTAGE' | 'FIXED';
  discountValue: number;
  maxUses?: number | null;
  applicableTier?: 'all' | 'starter_6' | 'pro_12';
  expiresAt?: string | null;
}

export async function createVoucherInDb(input: CreateVoucherInput) {
  const code = String(input.code || '').trim().toUpperCase();
  if (!code) throw Object.assign(new Error('Voucher code is required.'), { code: 'VOUCHER_CODE_REQUIRED', statusCode: 400 });
  const discountType = input.discountType === 'FIXED' ? 'FIXED' : 'PERCENTAGE';
  const discountValue = Number(input.discountValue);
  if (!Number.isFinite(discountValue) || discountValue <= 0) {
    throw Object.assign(new Error('Discount value must be greater than zero.'), { code: 'VOUCHER_VALUE_INVALID', statusCode: 400 });
  }
  if (discountType === 'PERCENTAGE' && discountValue > 100) {
    throw Object.assign(new Error('Percentage discount cannot exceed 100%.'), { code: 'VOUCHER_PERCENTAGE_EXCEEDED', statusCode: 400 });
  }

  const maxUses = input.maxUses !== undefined && input.maxUses !== null ? Math.max(1, Math.floor(Number(input.maxUses))) : null;
  const applicableTier = ['starter_6', 'pro_12'].includes(String(input.applicableTier)) ? String(input.applicableTier) : 'all';
  const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : null;

  try {
    const res = await dbQuery(
      `INSERT INTO vouchers (code, discount_type, discount_value, max_uses, applicable_tier, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, code, discount_type AS "discountType", discount_value::float AS "discountValue", max_uses AS "maxUses", used_count AS "usedCount", applicable_tier AS "applicableTier", is_active AS "isActive", expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [code, discountType, discountValue, maxUses, applicableTier, expiresAt]
    );
    if (res.rows[0]) return res.rows[0];
  } catch (err: any) {
    if (err.code === '23505' || String(err.message).includes('unique')) {
      throw Object.assign(new Error('Kode voucher sudah digunakan.'), { code: 'VOUCHER_CODE_EXISTS', statusCode: 400 });
    }
  }

  // Fallback in-memory
  const existing = inMemoryTables.vouchers.find((v) => v.code === code);
  if (existing) throw Object.assign(new Error('Kode voucher sudah digunakan.'), { code: 'VOUCHER_CODE_EXISTS', statusCode: 400 });
  const v = {
    id: randomUUID(),
    code,
    discountType,
    discountValue,
    maxUses,
    usedCount: 0,
    applicableTier,
    isActive: true,
    expiresAt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  inMemoryTables.vouchers.push(v);
  return v;
}

export async function getVouchersFromDb() {
  try {
    const res = await dbQuery(
      `SELECT id, code, discount_type AS "discountType", discount_value::float AS "discountValue", max_uses AS "maxUses", used_count AS "usedCount", applicable_tier AS "applicableTier", is_active AS "isActive", expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM vouchers ORDER BY created_at DESC`
    );
    if (res.rows && res.rows.length > 0) return res.rows;
  } catch {}
  return [...inMemoryTables.vouchers].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function toggleVoucherStatusInDb(id: string, isActive: boolean) {
  try {
    const res = await dbQuery(
      `UPDATE vouchers SET is_active = $2, updated_at = now() WHERE id = $1
       RETURNING id, code, discount_type AS "discountType", discount_value::float AS "discountValue", max_uses AS "maxUses", used_count AS "usedCount", applicable_tier AS "applicableTier", is_active AS "isActive", expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id, isActive]
    );
    if (res.rows[0]) return res.rows[0];
  } catch {}
  const v = inMemoryTables.vouchers.find((item) => item.id === id);
  if (!v) throw Object.assign(new Error('Voucher tidak ditemukan.'), { code: 'VOUCHER_NOT_FOUND', statusCode: 404 });
  v.isActive = isActive;
  v.updatedAt = new Date().toISOString();
  return v;
}

export async function deleteVoucherInDb(id: string) {
  try {
    await dbQuery(`DELETE FROM vouchers WHERE id = $1`, [id]);
  } catch {}
  const idx = inMemoryTables.vouchers.findIndex((v) => v.id === id);
  if (idx !== -1) inMemoryTables.vouchers.splice(idx, 1);
  return { success: true };
}

function isVoucherTierMatching(applicableTier: string, targetTier: string): boolean {
  const normApplicable = String(applicableTier || 'all').toLowerCase();
  const normTarget = String(targetTier || '').toLowerCase();
  if (normApplicable === 'all') return true;
  if (normApplicable === normTarget) return true;
  if ((normApplicable === 'starter' || normApplicable === 'starter_6') && (normTarget === 'starter' || normTarget === 'starter_6')) return true;
  if ((normApplicable === 'pro' || normApplicable === 'pro_12') && (normTarget === 'pro' || normTarget === 'pro_12')) return true;
  return false;
}

export async function validateVoucherForUserInDb(input: { code: string; firebaseUid: string; tier: string; originalFee: number }) {
  const code = String(input.code || '').trim().toUpperCase();
  if (!code) throw Object.assign(new Error('Kode voucher tidak boleh kosong.'), { code: 'VOUCHER_CODE_EMPTY', statusCode: 400 });

  let voucher: any = null;
  try {
    const res = await dbQuery(
      `SELECT id, code, discount_type AS "discountType", discount_value::float AS "discountValue", max_uses AS "maxUses", used_count AS "usedCount", applicable_tier AS "applicableTier", is_active AS "isActive", expires_at AS "expiresAt"
       FROM vouchers WHERE UPPER(code) = UPPER($1) LIMIT 1`,
      [code]
    );
    voucher = res.rows[0] || null;
  } catch {}

  if (!voucher) {
    voucher = inMemoryTables.vouchers.find((v) => v.code === code) || null;
  }

  if (!voucher) {
    throw Object.assign(new Error('Kode voucher tidak valid atau tidak ditemukan.'), { code: 'VOUCHER_NOT_FOUND', statusCode: 404 });
  }

  if (!voucher.isActive && !voucher.is_active) {
    throw Object.assign(new Error('Voucher ini sudah tidak aktif.'), { code: 'VOUCHER_INACTIVE', statusCode: 400 });
  }

  const expiresAt = voucher.expiresAt || voucher.expires_at;
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
    throw Object.assign(new Error('Voucher ini telah kedaluwarsa.'), { code: 'VOUCHER_EXPIRED', statusCode: 400 });
  }

  const maxUses = voucher.maxUses ?? voucher.max_uses;
  const usedCount = voucher.usedCount ?? voucher.used_count ?? 0;
  if (maxUses !== null && maxUses !== undefined && usedCount >= maxUses) {
    throw Object.assign(new Error('Kuota penggunaan voucher ini telah habis.'), { code: 'VOUCHER_USAGE_EXHAUSTED', statusCode: 400 });
  }

  const applicableTier = voucher.applicableTier || voucher.applicable_tier || 'all';
  if (!isVoucherTierMatching(applicableTier, input.tier)) {
    throw Object.assign(new Error(`Voucher ini hanya berlaku untuk paket ${applicableTier.startsWith('pro') ? 'Pro' : 'Starter'}.`), { code: 'VOUCHER_TIER_MISMATCH', statusCode: 400 });
  }

  // Check if user already used this voucher
  try {
    const userRes = await dbQuery(`SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1`, [input.firebaseUid]);
    if (userRes.rows[0]) {
      const redemption = await dbQuery(`SELECT id FROM voucher_redemptions WHERE voucher_id = $1 AND user_id = $2 LIMIT 1`, [voucher.id, userRes.rows[0].id]);
      if (redemption.rows[0]) {
        throw Object.assign(new Error('Anda sudah menggunakan voucher ini sebelumnya.'), { code: 'VOUCHER_ALREADY_USED', statusCode: 400 });
      }
    }
  } catch (err: any) {
    if (err.code === 'VOUCHER_ALREADY_USED') throw err;
  }

  const userInMemory = inMemoryTables.users.find((u) => u.firebase_uid === input.firebaseUid);
  if (userInMemory) {
    const usedInMemory = inMemoryTables.voucher_redemptions.some((r) => r.voucherId === voucher.id && r.userId === userInMemory.id);
    if (usedInMemory) {
      throw Object.assign(new Error('Anda sudah menggunakan voucher ini sebelumnya.'), { code: 'VOUCHER_ALREADY_USED', statusCode: 400 });
    }
  }

  const discountType = voucher.discountType || voucher.discount_type;
  const discountValue = Number(voucher.discountValue ?? voucher.discount_value);
  let discountAmount = 0;
  if (discountType === 'PERCENTAGE') {
    discountAmount = Math.round((input.originalFee * discountValue / 100) * 100) / 100;
  } else {
    discountAmount = Math.min(input.originalFee, discountValue);
  }

  const finalFee = Math.max(0, Math.round((input.originalFee - discountAmount) * 100) / 100);

  return {
    valid: true,
    voucherId: voucher.id,
    code: voucher.code,
    discountType,
    discountValue,
    discountAmount,
    originalFee: input.originalFee,
    finalFee,
  };
}

export async function activateLicenseAtomic(input: { firebaseUid: string; tier: string; fee: number; tradingBonus: number; maxActiveBots: number; licenseName: string; idempotencyKey?: string; voucherCode?: string }) {
  return dbTransaction(async (client) => {
    const user = await client.query('SELECT id, member_id, status FROM users WHERE firebase_uid=$1 FOR UPDATE', [input.firebaseUid]);
    if (!user.rows[0]) throw Object.assign(new Error('User is not provisioned.'), { code: 'ACCOUNT_NOT_PROVISIONED' });
    const userId = user.rows[0].id;
    if (input.idempotencyKey) {
      const replay = await client.query(`SELECT id, user_id, tier, name, fee, trading_bonus, max_active_bots FROM licenses WHERE idempotency_key=$1`, [input.idempotencyKey]);
      if (replay.rows[0] && replay.rows[0].user_id !== userId) {
        throw Object.assign(new Error('Idempotency key is already bound to another account.'), { code: 'ACTIVATION_IDEMPOTENCY_CONFLICT' });
      }
      if (replay.rows[0]) {
        const wallet = await client.query(`SELECT available_balance, gas_reserve FROM wallet_accounts WHERE user_id=$1 AND currency='USDT'`, [userId]);
        return { activationId: replay.rows[0].id, memberId: user.rows[0].member_id, newBalance: Number(wallet.rows[0]?.available_balance || 0), tradingBonus: Number(replay.rows[0].trading_bonus), gasReserve: Number(wallet.rows[0]?.gas_reserve || 0), ledgerDebitId: null, referralBonus: 0, referralEventId: null, referralSponsorFirebaseUid: null, replayed: true, effectiveFee: Number(replay.rows[0].fee || 0), discountAmount: 0 };
      }
    }
    const existing = await client.query(`SELECT id FROM licenses WHERE user_id=$1 AND status='ACTIVE' LIMIT 1`, [userId]);
    if (existing.rows[0]) throw Object.assign(new Error('License is already active.'), { code: 'LICENSE_ALREADY_ACTIVE' });

    let effectiveFee = input.fee;
    let appliedVoucherId: string | null = null;
    let discountAmount = 0;

    if (input.voucherCode) {
      const code = String(input.voucherCode).trim().toUpperCase();
      let vRes = await client.query(`SELECT id, code, discount_type, discount_value, max_uses, used_count, applicable_tier, is_active, expires_at FROM vouchers WHERE UPPER(code)=UPPER($1) FOR UPDATE`, [code]);
      let voucher = vRes.rows[0];
      if (!voucher) {
        const memV = inMemoryTables.vouchers.find((v) => v.code === code);
        if (memV) voucher = { id: memV.id, code: memV.code, discount_type: memV.discountType, discount_value: memV.discountValue, max_uses: memV.maxUses, used_count: memV.usedCount, applicable_tier: memV.applicableTier, is_active: memV.isActive, expires_at: memV.expiresAt };
      }
      if (!voucher) throw Object.assign(new Error('Kode voucher tidak ditemukan.'), { code: 'VOUCHER_NOT_FOUND', statusCode: 404 });
      if (!voucher.is_active) throw Object.assign(new Error('Voucher ini sudah tidak aktif.'), { code: 'VOUCHER_INACTIVE', statusCode: 400 });
      if (voucher.expires_at && new Date(voucher.expires_at).getTime() < Date.now()) throw Object.assign(new Error('Voucher ini telah kedaluwarsa.'), { code: 'VOUCHER_EXPIRED', statusCode: 400 });
      if (voucher.max_uses !== null && voucher.max_uses !== undefined && Number(voucher.used_count) >= Number(voucher.max_uses)) throw Object.assign(new Error('Kuota penggunaan voucher telah habis.'), { code: 'VOUCHER_USAGE_EXHAUSTED', statusCode: 400 });
      if (!isVoucherTierMatching(voucher.applicable_tier, input.tier)) throw Object.assign(new Error(`Voucher ini hanya berlaku untuk paket ${voucher.applicable_tier.startsWith('pro') ? 'Pro' : 'Starter'}.`), { code: 'VOUCHER_TIER_MISMATCH', statusCode: 400 });

      // check redemptions
      const redRes = await client.query(`SELECT id FROM voucher_redemptions WHERE voucher_id=$1 AND user_id=$2 LIMIT 1`, [voucher.id, userId]);
      if (redRes.rows[0] || inMemoryTables.voucher_redemptions.some((r) => r.voucherId === voucher.id && r.userId === userId)) {
        throw Object.assign(new Error('Anda sudah menggunakan voucher ini sebelumnya.'), { code: 'VOUCHER_ALREADY_USED', statusCode: 400 });
      }

      appliedVoucherId = voucher.id;
      const dValue = Number(voucher.discount_value);
      if (voucher.discount_type === 'PERCENTAGE') {
        discountAmount = Math.round((input.fee * dValue / 100) * 100) / 100;
      } else {
        discountAmount = Math.min(input.fee, dValue);
      }
      effectiveFee = Math.max(0, Math.round((input.fee - discountAmount) * 100) / 100);

      await client.query(`INSERT INTO voucher_redemptions (voucher_id, user_id, tier, original_fee, discount_amount, final_fee) VALUES ($1, $2, $3, $4, $5, $6)`, [voucher.id, userId, input.tier, input.fee, discountAmount, effectiveFee]);
      await client.query(`UPDATE vouchers SET used_count = used_count + 1, updated_at = now() WHERE id = $1`, [voucher.id]);

      inMemoryTables.voucher_redemptions.push({ id: randomUUID(), voucherId: voucher.id, userId, tier: input.tier, originalFee: input.fee, discountAmount, finalFee: effectiveFee, redeemedAt: new Date().toISOString() });
      const memV = inMemoryTables.vouchers.find((v) => v.id === voucher.id);
      if (memV) { memV.usedCount = (memV.usedCount || 0) + 1; }
    }

    const wallet = await client.query(`SELECT * FROM wallet_accounts WHERE user_id=$1 AND currency='USDT' FOR UPDATE`, [userId]);
    if (!wallet.rows[0] || Number(wallet.rows[0].available_balance) < effectiveFee) throw Object.assign(new Error('Insufficient available balance.'), { code: 'INSUFFICIENT_BALANCE' });
    const before = Number(wallet.rows[0].available_balance);
    const after = toLedgerAmount(before - effectiveFee);
    await client.query(`UPDATE wallet_accounts SET available_balance=$2, total_outflow=total_outflow+$3, gas_reserve=gas_reserve+$4, total_inflow=total_inflow+$4, version=version+1, updated_at=now() WHERE id=$1`, [wallet.rows[0].id, after, effectiveFee, input.tradingBonus]);
    const activation = await client.query(`INSERT INTO licenses (user_id,tier,license_type,name,fee,trading_bonus,max_active_bots,idempotency_key) VALUES ($1,$2,'lifetime',$3,$4,$5,$6,$7) RETURNING id`, [userId,input.tier,input.licenseName,effectiveFee,input.tradingBonus,input.maxActiveBots,input.idempotencyKey||null]);
    const ledgerDebit = await client.query(`INSERT INTO wallet_ledger (account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description) VALUES ($1,'DEBIT',$2,$3,$4,'LICENSE_ACTIVATION','LICENSE',$5,$6) RETURNING id`, [wallet.rows[0].id,effectiveFee,before,after,activation.rows[0].id,input.licenseName]);
    if (input.tradingBonus > 0) {
      const gasBefore = Number(wallet.rows[0].gas_reserve || 0);
      const gasAfter = toLedgerAmount(gasBefore + input.tradingBonus);
      await client.query(
        `INSERT INTO wallet_ledger (account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description,metadata)
         VALUES ($1,'CREDIT',$2,$3,$4,'LICENSE_TRADING_BONUS','LICENSE',$5,$6,$7::jsonb)`,
        [wallet.rows[0].id, input.tradingBonus, gasBefore, gasAfter, activation.rows[0].id, `Bonus Fee Trading (Gas Tank) Aktivasi ${input.licenseName}`, JSON.stringify({ tier: input.tier, tradingBonus: input.tradingBonus })],
      );
    }
    await client.query(`UPDATE users SET status='active', updated_at=now() WHERE id=$1`, [userId]);

    let referralBonus = 0;
    let referralEventId: string | null = null;
    let referralSponsorFirebaseUid: string | null = null;
    const sponsor = await client.query(`SELECT u.id, u.member_id, u.firebase_uid FROM users u WHERE u.id=(SELECT sponsor_user_id FROM users WHERE id=$1) FOR UPDATE`, [userId]);
    if (sponsor.rows[0] && sponsor.rows[0].id !== userId) {
      referralBonus = toLedgerAmount(getReferralActivationBonus(Number(effectiveFee)));
      if (referralBonus > 0) {
        const sponsorWallet = await client.query(`SELECT id,available_balance FROM wallet_accounts WHERE user_id=$1 AND currency='USDT' FOR UPDATE`, [sponsor.rows[0].id]);
        if (sponsorWallet.rows[0]) {
          const sponsorBefore = Number(sponsorWallet.rows[0].available_balance);
          const sponsorAfter = toLedgerAmount(sponsorBefore + referralBonus);
          await client.query(`UPDATE wallet_accounts SET available_balance=$2,total_inflow=total_inflow+$3,withdrawable_trading_yield=withdrawable_trading_yield+$3,version=version+1,updated_at=now() WHERE id=$1`, [sponsorWallet.rows[0].id,sponsorAfter,referralBonus]);
          const event = await client.query(`INSERT INTO referral_events(sponsor_user_id,source_user_id,event_type,gross_amount,reward_amount,cashable,metadata) VALUES($1,$2,'ACTIVATION', $3,$4,true,$5) RETURNING id`, [sponsor.rows[0].id,userId,effectiveFee,referralBonus,JSON.stringify({tier:input.tier,licenseId:activation.rows[0].id})]);
          referralEventId = event.rows[0].id;
          referralSponsorFirebaseUid = sponsor.rows[0].firebase_uid;
          await client.query(`INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description,metadata) VALUES($1,'CREDIT',$2,$3,$4,'REFERRAL_ACTIVATION','REFERRAL',$5,$6,$7)`, [sponsorWallet.rows[0].id,referralBonus,sponsorBefore,sponsorAfter,referralEventId,`20% sponsor reward for ${input.licenseName}`,JSON.stringify({sourceUserId:userId,licenseId:activation.rows[0].id})]);
        }
      }
    }
    return { activationId: activation.rows[0].id, memberId: user.rows[0].member_id, newBalance: after, tradingBonus: input.tradingBonus, gasReserve: toLedgerAmount(Number(wallet.rows[0].gas_reserve)+input.tradingBonus), ledgerDebitId: ledgerDebit.rows[0].id, referralBonus, referralEventId, referralSponsorFirebaseUid, replayed: false, effectiveFee, discountAmount };
  });
}

export async function transferFundsAtomic(input: { senderFirebaseUid: string; recipientMemberId: string; amount: number; note?: string; idempotencyKey?: string; minAmount?: number; maxAmount: number; dailyLimit: number }) {
  const amount = toLedgerAmount(input.amount);
  const minAmount = input.minAmount !== undefined && Number.isFinite(input.minAmount) && input.minAmount > 0 ? input.minAmount : 1;
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('Transfer amount must be positive and finite.'), { code: 'TRANSFER_AMOUNT_INVALID' });
  if (amount < minAmount) throw Object.assign(new Error(`Minimal nominal transfer P2P adalah ${minAmount} USDT.`), { code: 'TRANSFER_AMOUNT_BELOW_MINIMUM', statusCode: 422 });
  if (!Number.isFinite(input.maxAmount) || input.maxAmount <= 0 || !Number.isFinite(input.dailyLimit) || input.dailyLimit <= 0) throw Object.assign(new Error('P2P transfer limits are not configured.'), { code: 'TRANSFER_LIMITS_NOT_CONFIGURED', statusCode: 503 });
  if (amount > input.maxAmount) throw Object.assign(new Error('Transfer amount exceeds the configured limit.'), { code: 'TRANSFER_AMOUNT_LIMIT', statusCode: 422 });
  return dbTransaction(async (client) => {
    // Lock both users and both wallets in a deterministic order. Opposite-direction
    // concurrent transfers would otherwise deadlock by taking locks in reverse order.
    const participants = await client.query(`SELECT id,member_id,firebase_uid,status FROM users WHERE firebase_uid=$1 OR member_id=$2 ORDER BY id FOR UPDATE`, [input.senderFirebaseUid,input.recipientMemberId]);
    const sender = participants.rows.find((row:any) => row.firebase_uid === input.senderFirebaseUid);
    const recipient = participants.rows.find((row:any) => row.member_id === input.recipientMemberId);
    if (!sender) throw Object.assign(new Error('Sender account is not provisioned.'), { code: 'ACCOUNT_NOT_PROVISIONED' });
    if (!recipient) throw Object.assign(new Error('Recipient was not found.'), { code: 'TRANSFER_RECIPIENT_NOT_FOUND' });
    if (String(sender.status).toLowerCase() !== 'active') throw Object.assign(new Error('Akun pengirim sedang tidak aktif atau dalam status penangguhan.'), { code: 'TRANSFER_SENDER_INACTIVE', statusCode: 403 });
    if (recipient.id === sender.id || String(sender.firebase_uid) === String(recipient.firebase_uid)) throw Object.assign(new Error('Self transfer is not allowed.'), { code: 'TRANSFER_SELF_NOT_ALLOWED' });
    if (String(recipient.status).toLowerCase() !== 'active') throw Object.assign(new Error('Recipient account is not active.'), { code: 'TRANSFER_RECIPIENT_INACTIVE', statusCode: 409 });
    if (!input.idempotencyKey?.trim()) throw Object.assign(new Error('Transfer idempotency key is required.'), { code: 'TRANSFER_IDEMPOTENCY_REQUIRED', statusCode: 400 });
    {
      const existing = await client.query(`SELECT id,sender_user_id,recipient_user_id,amount,note FROM transfers WHERE idempotency_key=$1 FOR UPDATE`, [input.idempotencyKey]);
      if (existing.rows[0]) {
        const prior = existing.rows[0];
        const sameIntent = String(prior.sender_user_id) === String(sender.id)
          && String(prior.recipient_user_id) === String(recipient.id)
          && Number(prior.amount) === amount
          && String(prior.note || '') === String(input.note || '');
        if (!sameIntent) throw Object.assign(new Error('Idempotency key is already bound to a different transfer.'), { code: 'TRANSFER_IDEMPOTENCY_CONFLICT', statusCode: 409 });
        return { transferId: prior.id, replayed: true, senderMemberId: sender.member_id, recipientMemberId: recipient.member_id };
      }
    }
    const daily = await client.query(`SELECT COALESCE(sum(amount),0)::text AS total FROM transfers WHERE sender_user_id=$1 AND status='COMPLETED' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [sender.id]);
    if (Number(daily.rows[0]?.total || 0) + amount > input.dailyLimit) throw Object.assign(new Error('Daily transfer limit would be exceeded.'), { code: 'TRANSFER_DAILY_LIMIT', statusCode: 422 });
    const wallets = await client.query(`SELECT id,user_id,available_balance FROM wallet_accounts WHERE user_id = ANY($1::uuid[]) AND currency='USDT' ORDER BY user_id FOR UPDATE`, [[sender.id, recipient.id]]);
    const senderWallet = wallets.rows.find((w:any)=>w.user_id===sender.id);
    const recipientWallet = wallets.rows.find((w:any)=>w.user_id===recipient.id);
    if (!senderWallet || !recipientWallet || Number(senderWallet.available_balance) < amount) throw Object.assign(new Error('Insufficient available balance.'), { code: 'INSUFFICIENT_BALANCE' });
    const transfer = await client.query(`INSERT INTO transfers(sender_user_id,recipient_user_id,amount,fee,status,idempotency_key,note,completed_at) VALUES($1,$2,$3,0,'COMPLETED',$4,$5,now()) RETURNING id`, [sender.id,recipient.id,amount,input.idempotencyKey||null,input.note||null]);
    const senderBefore = Number(senderWallet.available_balance);
    const recipientBefore = Number(recipientWallet.available_balance);
    const senderAfter = toLedgerAmount(senderBefore - amount);
    const recipientAfter = toLedgerAmount(recipientBefore + amount);
    await client.query(`UPDATE wallet_accounts SET available_balance=$2,total_outflow=total_outflow+$3,version=version+1,updated_at=now() WHERE id=$1`, [senderWallet.id,senderAfter,amount]);
    await client.query(`UPDATE wallet_accounts SET available_balance=$2,total_inflow=total_inflow+$3,version=version+1,updated_at=now() WHERE id=$1`, [recipientWallet.id,recipientAfter,amount]);
    
    const ledgerMetadata = JSON.stringify({
      senderMemberId: sender.member_id,
      recipientMemberId: recipient.member_id,
      transferId: transfer.rows[0].id,
      note: input.note || null,
    });
    await client.query(`INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description,metadata) VALUES($1,'DEBIT',$2,$3,$4,'P2P_TRANSFER','TRANSFER',$5,$6,$7::jsonb)`, [senderWallet.id,amount,senderBefore,senderAfter,transfer.rows[0].id,`Transfer ke ${recipient.member_id}`,ledgerMetadata]);
    await client.query(`INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description,metadata) VALUES($1,'CREDIT',$2,$3,$4,'P2P_TRANSFER','TRANSFER',$5,$6,$7::jsonb)`, [recipientWallet.id,amount,recipientBefore,recipientAfter,transfer.rows[0].id,`Transfer dari ${sender.member_id}`,ledgerMetadata]);
    return { transferId: transfer.rows[0].id, replayed: false, senderMemberId: sender.member_id, recipientMemberId: recipient.member_id, senderBalance: senderAfter };
  });
}

export async function listWithdrawalAddresses(firebaseUid: string) {
  const result = await dbQuery<any>(
    `SELECT wa.id,wa.address,wa.label,wa.network,wa.status,wa.enrolled_at,wa.cooldown_until
       FROM withdrawal_addresses wa JOIN users u ON u.id=wa.user_id
      WHERE u.firebase_uid=$1 ORDER BY wa.created_at DESC LIMIT 50`,
    [firebaseUid],
  );
  return result.rows;
}

export async function registerWithdrawalAddress(input: { firebaseUid: string; address: string; label?: string; cooldownHours: number }) {
  const address=String(input.address||'').trim().toLowerCase();
  const cooldownHours=Number(input.cooldownHours);
  if (!/^0x[a-f0-9]{40}$/.test(address)) throw Object.assign(new Error('A valid BEP-20 destination is required.'),{code:'WITHDRAW_ADDRESS_INVALID',statusCode:400});
  if (!Number.isFinite(cooldownHours)||cooldownHours<=0||cooldownHours>8760) throw Object.assign(new Error('Withdrawal address cooldown is not configured.'),{code:'WITHDRAW_COOLDOWN_NOT_CONFIGURED',statusCode:503});
  return dbTransaction(async(client)=>{
    const user=await client.query(`SELECT id FROM users WHERE firebase_uid=$1 FOR UPDATE`,[input.firebaseUid]);
    if(!user.rows[0]) throw Object.assign(new Error('Account not provisioned.'),{code:'ACCOUNT_NOT_PROVISIONED',statusCode:404});
    const existing=await client.query(`SELECT id,address,label,status,enrolled_at,cooldown_until FROM withdrawal_addresses WHERE user_id=$1 AND network='BEP-20' AND lower(address)=lower($2) AND status='ACTIVE' FOR UPDATE`,[user.rows[0].id,address]);
    if(existing.rows[0]) return {...existing.rows[0],replayed:true};
    const result=await client.query(
      `INSERT INTO withdrawal_addresses(user_id,address,label,cooldown_until)
       VALUES($1,$2,$3,now()+($4::text||' hours')::interval)
       RETURNING id,address,label,network,status,enrolled_at,cooldown_until`,
      [user.rows[0].id,address,String(input.label||'').trim().slice(0,80),cooldownHours],
    );
    return {...result.rows[0],replayed:false};
  });
}

export async function removeWithdrawalAddress(firebaseUid: string,addressId: string) {
  return dbTransaction(async(client)=>{
    const user=await client.query(`SELECT id FROM users WHERE firebase_uid=$1 FOR UPDATE`,[firebaseUid]);
    if(!user.rows[0]) throw Object.assign(new Error('Account not provisioned.'),{code:'ACCOUNT_NOT_PROVISIONED',statusCode:404});
    const row=await client.query(
      `SELECT wa.id FROM withdrawal_addresses wa
        WHERE wa.id=$1 AND wa.user_id=$2 AND wa.status='ACTIVE' FOR UPDATE`,
      [addressId,user.rows[0].id],
    );
    if(!row.rows[0]) throw Object.assign(new Error('Whitelisted address was not found.'),{code:'WITHDRAW_ADDRESS_NOT_FOUND',statusCode:404});
    const pending=await client.query(`SELECT 1 FROM withdrawals WHERE withdrawal_address_id=$1 AND status IN ('REVIEW','PROCESSING') LIMIT 1`,[addressId]);
    if(pending.rows[0]) throw Object.assign(new Error('Address has a pending withdrawal and cannot be removed yet.'),{code:'WITHDRAW_ADDRESS_HAS_PENDING',statusCode:409});
    await client.query(`UPDATE withdrawal_addresses SET status='REMOVED',removed_at=now(),updated_at=now() WHERE id=$1`,[addressId]);
    return {removed:true};
  });
}

export async function createWithdrawalRequest(input: { firebaseUid: string; address: string; amount: number; fee: number; network: string; idempotencyKey: string; maxAmount: number; dailyLimit: number; hotWalletDailyCap:number; screeningProvider: string }) {
  const amount = Number(input.amount);
  const fee = Number(input.fee);
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('Withdrawal amount must be positive and finite.'), { code: 'WITHDRAW_AMOUNT_INVALID' });
  if (!Number.isFinite(fee) || fee < 0) throw Object.assign(new Error('Withdrawal fee is invalid.'), { code: 'WITHDRAW_FEE_INVALID' });
  if (amount <= fee) throw Object.assign(new Error('Withdrawal amount must exceed the configured fee.'), { code:'WITHDRAW_NET_AMOUNT_INVALID',statusCode:422 });
  if (!input.idempotencyKey?.trim()) throw Object.assign(new Error('Withdrawal idempotency key is required.'), { code: 'WITHDRAW_IDEMPOTENCY_REQUIRED' });
  if (!Number.isFinite(input.maxAmount) || input.maxAmount <= 0 || !Number.isFinite(input.dailyLimit) || input.dailyLimit <= 0) throw Object.assign(new Error('Withdrawal limits are not configured.'), { code: 'WITHDRAW_LIMITS_NOT_CONFIGURED', statusCode: 503 });
  if (!Number.isFinite(input.hotWalletDailyCap) || input.hotWalletDailyCap <= 0) throw Object.assign(new Error('The global hot-wallet daily cap is not configured.'), { code: 'WITHDRAW_HOT_WALLET_CAP_NOT_CONFIGURED', statusCode: 503 });
  if (amount > input.maxAmount) throw Object.assign(new Error('Withdrawal amount exceeds the configured limit.'), { code: 'WITHDRAW_AMOUNT_LIMIT', statusCode: 422 });
  return dbTransaction(async (client) => {
    const user = await client.query(`SELECT id FROM users WHERE firebase_uid=$1 FOR UPDATE`, [input.firebaseUid]);
    if (!user.rows[0]) throw Object.assign(new Error('Account not provisioned.'), { code: 'ACCOUNT_NOT_PROVISIONED' });
    const existing = await client.query(`SELECT id,user_id,destination_address,status,amount,fee,net_amount,network FROM withdrawals WHERE idempotency_key=$1 FOR UPDATE`, [input.idempotencyKey]);
    if (existing.rows[0]) {
      const prior = existing.rows[0];
      const sameIntent = String(prior.user_id) === String(user.rows[0].id)
        && String(prior.destination_address).toLowerCase() === input.address.toLowerCase()
        && Number(prior.amount) === amount
        && Number(prior.fee) === fee
        && String(prior.network) === input.network;
      if (!sameIntent) throw Object.assign(new Error('Idempotency key is already bound to a different withdrawal.'), { code: 'WITHDRAW_IDEMPOTENCY_CONFLICT', statusCode: 409 });
      return { id:prior.id,status:prior.status,amount:Number(prior.amount),fee:Number(prior.fee),netAmount:Number(prior.net_amount),network:prior.network,replayed:true };
    }
    const daily = await client.query(`SELECT COALESCE(sum(amount),0)::text AS total FROM withdrawals WHERE user_id=$1 AND status NOT IN ('REJECTED','CANCELLED') AND requested_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [user.rows[0].id]);
    if (Number(daily.rows[0]?.total || 0) + amount > input.dailyLimit) throw Object.assign(new Error('Daily withdrawal limit would be exceeded.'), { code: 'WITHDRAW_DAILY_LIMIT', statusCode: 422 });
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('gain:withdrawal-hot-wallet-daily'))`);
    const globalDaily=await client.query(
      `SELECT COALESCE(sum(net_amount),0)::text AS total FROM withdrawals
        WHERE (status IN ('REVIEW','PROCESSING') OR (status IN ('SENT','CONFIRMED') AND processed_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))`,
    );
    if(Number(globalDaily.rows[0]?.total||0)+(amount-fee)>input.hotWalletDailyCap) throw Object.assign(new Error('The global hot-wallet daily cap would be exceeded.'),{code:'WITHDRAW_HOT_WALLET_DAILY_CAP',statusCode:422});
    const wallet = await client.query(`SELECT id,available_balance FROM wallet_accounts WHERE user_id=$1 AND currency='USDT' FOR UPDATE`, [user.rows[0].id]);
    const totalDebit=input.amount;
    if (!wallet.rows[0] || Number(wallet.rows[0].available_balance)<totalDebit) throw Object.assign(new Error('Insufficient available balance.'), { code: 'INSUFFICIENT_BALANCE' });
    const netAmount=toLedgerAmount(input.amount-input.fee);
    const address=await client.query(
      `SELECT id,cooldown_until FROM withdrawal_addresses
        WHERE user_id=$1 AND network=$2 AND lower(address)=lower($3) AND status='ACTIVE' FOR UPDATE`,
      [user.rows[0].id,input.network,input.address],
    );
    if(!address.rows[0]) throw Object.assign(new Error('Withdrawal destination must be whitelisted first.'),{code:'WITHDRAW_ADDRESS_NOT_WHITELISTED',statusCode:422});
    if(new Date(address.rows[0].cooldown_until).getTime()>Date.now()) throw Object.assign(new Error('Withdrawal destination cooldown has not elapsed.'),{code:'WITHDRAW_ADDRESS_COOLDOWN',statusCode:422,cooldownUntil:address.rows[0].cooldown_until});
    const withdrawal=await client.query(`INSERT INTO withdrawals(user_id,network,destination_address,withdrawal_address_id,amount,fee,net_amount,status,idempotency_key,screening_status,screening_provider)
       VALUES($1,$2,$3,$4,$5,$6,$7,'REVIEW',$8,'PENDING',$9) RETURNING id`, [user.rows[0].id,input.network,input.address,address.rows[0].id,input.amount,input.fee,netAmount,input.idempotencyKey,input.screeningProvider]);
    await client.query(`INSERT INTO withdrawal_screening_events(withdrawal_id,provider,provider_event_id,status,reason_code) VALUES($1,$2,$3,'PENDING','SCREENING_PENDING')`,[withdrawal.rows[0].id,input.screeningProvider,`initial:${withdrawal.rows[0].id}`]);
    const before=Number(wallet.rows[0].available_balance);
    const after=toLedgerAmount(before-input.amount);
    await client.query(`UPDATE wallet_accounts SET available_balance=$2,locked_balance=locked_balance+$3,total_outflow=total_outflow+$3,version=version+1,updated_at=now() WHERE id=$1`, [wallet.rows[0].id,after,input.amount]);
    await client.query(`INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description) VALUES($1,'DEBIT',$2,$3,$4,'WITHDRAWAL_HOLD','WITHDRAWAL',$5,$6)`, [wallet.rows[0].id,input.amount,before,after,withdrawal.rows[0].id,'Withdrawal settlement hold']);
    return { id: withdrawal.rows[0].id, status:'REVIEW', amount:input.amount, fee:input.fee, netAmount, network:input.network, replayed:false };
  });
}

export async function applyWithdrawalScreeningResult(input:{withdrawalId:string;provider:string;providerEventId:string;status:'CLEAR'|'BLOCKED'|'ERROR';reasonCode?:string;reference?:string}) {
  if(!input.provider.trim()||!input.providerEventId.trim()) throw Object.assign(new Error('Screening provider event identity is required.'),{code:'SCREENING_EVENT_INVALID',statusCode:400});
  return dbTransaction(async(client)=>{
    const prior=await client.query(`SELECT id,status FROM withdrawal_screening_events WHERE provider=$1 AND provider_event_id=$2 FOR UPDATE`,[input.provider,input.providerEventId]);
    if(prior.rows[0]) {
      const same=prior.rows[0].status===input.status;
      if(!same) throw Object.assign(new Error('Screening event ID was reused with a different result.'),{code:'SCREENING_EVENT_CONFLICT',statusCode:409});
      return {replayed:true,status:prior.rows[0].status};
    }
    const withdrawal=await client.query(`SELECT id,status,screening_provider FROM withdrawals WHERE id=$1 FOR UPDATE`,[input.withdrawalId]);
    if(!withdrawal.rows[0]) throw Object.assign(new Error('Withdrawal not found.'),{code:'WITHDRAWAL_NOT_FOUND',statusCode:404});
    if(withdrawal.rows[0].screening_provider!==input.provider) throw Object.assign(new Error('Screening provider does not match the configured provider for this withdrawal.'),{code:'SCREENING_PROVIDER_MISMATCH',statusCode:409});
    if(!['REVIEW','PROCESSING'].includes(String(withdrawal.rows[0].status))) throw Object.assign(new Error('Withdrawal is no longer awaiting screening.'),{code:'WITHDRAWAL_STATE_CONFLICT',statusCode:409});
    await client.query(`INSERT INTO withdrawal_screening_events(withdrawal_id,provider,provider_event_id,status,reason_code) VALUES($1,$2,$3,$4,$5)`,[input.withdrawalId,input.provider,input.providerEventId,input.status,String(input.reasonCode||'').slice(0,100)]);
    await client.query(
      `UPDATE withdrawals SET screening_status=$2,screening_reference=$3,screening_checked_at=now(),screening_reason_code=$4,
         status=CASE WHEN $2='BLOCKED' THEN 'REVIEW' ELSE status END
       WHERE id=$1`,
      [input.withdrawalId,input.status,String(input.reference||'').slice(0,200)||null,String(input.reasonCode||'').slice(0,100)||null],
    );
    return {replayed:false,status:input.status};
  });
}

export async function listWithdrawalQueue(status='REVIEW',limit=100) {
  const safeStatus=['REVIEW','PROCESSING','ALL'].includes(status)?status:'REVIEW';
  const safeLimit=Math.max(1,Math.min(250,Math.floor(Number(limit)||100)));
  const result=await dbQuery<any>(
    `SELECT w.id,w.user_id,u.member_id,w.network,w.destination_address,w.amount,w.fee,w.net_amount,w.status,
            w.screening_status,w.screening_provider,w.screening_reference,w.screening_checked_at,w.requested_at,
            wa.cooldown_until,wa.label,w.processor_attempt_count,w.processor_claimed_by,w.processor_lease_until,w.provider_payout_id,
            COUNT(DISTINCT a.admin_uid)::int AS approval_count,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.admin_uid),NULL) AS approver_uids
       FROM withdrawals w JOIN users u ON u.id=w.user_id
       LEFT JOIN withdrawal_addresses wa ON wa.id=w.withdrawal_address_id
       LEFT JOIN withdrawal_approvals a ON a.withdrawal_id=w.id AND a.decision='APPROVE'
      WHERE ($1='ALL' OR w.status=$1)
      GROUP BY w.id,u.member_id,wa.cooldown_until,wa.label
      ORDER BY w.requested_at ASC LIMIT $2`,
    [safeStatus,safeLimit],
  );
  return result.rows;
}

export async function recordWithdrawalApproval(input:{withdrawalId:string;adminUid:string;reason?:string}) {
  return dbTransaction(async(client)=>{
    const withdrawal=await client.query(
      `SELECT w.id,w.status,w.screening_status,w.withdrawal_address_id,wa.status AS address_status,wa.cooldown_until
         FROM withdrawals w JOIN withdrawal_addresses wa ON wa.id=w.withdrawal_address_id
        WHERE w.id=$1 FOR UPDATE OF w,wa`,
      [input.withdrawalId],
    );
    const row=withdrawal.rows[0];
    if(!row) throw Object.assign(new Error('Withdrawal not found.'),{code:'WITHDRAWAL_NOT_FOUND',statusCode:404});
    if(row.status==='PROCESSING') {
      const count=await client.query(`SELECT COUNT(DISTINCT admin_uid)::int AS count FROM withdrawal_approvals WHERE withdrawal_id=$1 AND decision='APPROVE'`,[input.withdrawalId]);
      return {replayed:true,status:row.status,approvalCount:Number(count.rows[0]?.count||0),requiredApprovals:2};
    }
    if(row.status!=='REVIEW') throw Object.assign(new Error('Withdrawal is not awaiting approval.'),{code:'WITHDRAWAL_STATE_CONFLICT',statusCode:409});
    if(row.screening_status!=='CLEAR') throw Object.assign(new Error('A CLEAR screening result is required before approval.'),{code:'WITHDRAWAL_SCREENING_NOT_CLEAR',statusCode:409});
    if(row.address_status!=='ACTIVE'||new Date(row.cooldown_until).getTime()>Date.now()) throw Object.assign(new Error('Approved destination whitelist and elapsed cooldown are required.'),{code:'WITHDRAWAL_ADDRESS_NOT_READY',statusCode:409});
    const inserted=await client.query(
      `INSERT INTO withdrawal_approvals(withdrawal_id,admin_uid,decision,reason) VALUES($1,$2,'APPROVE',$3)
       ON CONFLICT(withdrawal_id,admin_uid) DO NOTHING RETURNING id`,
      [input.withdrawalId,input.adminUid,String(input.reason||'').slice(0,400)],
    );
    const count=await client.query(`SELECT COUNT(DISTINCT admin_uid)::int AS count FROM withdrawal_approvals WHERE withdrawal_id=$1 AND decision='APPROVE'`,[input.withdrawalId]);
    const approvalCount=Number(count.rows[0]?.count||0);
    if(approvalCount>=2) await client.query(`UPDATE withdrawals SET status='PROCESSING',approved_at=COALESCE(approved_at,now()) WHERE id=$1 AND status='REVIEW'`,[input.withdrawalId]);
    return {replayed:!inserted.rows[0],status:approvalCount>=2?'PROCESSING':'REVIEW',approvalCount,requiredApprovals:2};
  });
}

export async function claimNextWithdrawal(input:{processorId:string;leaseSeconds:number;maxAttempts:number}) {
  if(!input.processorId.trim()||!Number.isInteger(input.leaseSeconds)||input.leaseSeconds<1||!Number.isInteger(input.maxAttempts)||input.maxAttempts<1) throw Object.assign(new Error('Withdrawal processor claim policy is not configured.'),{code:'WITHDRAWAL_PROCESSOR_POLICY_INVALID',statusCode:503});
  return dbTransaction(async(client)=>{
    const candidate=await client.query(
      `SELECT w.id,w.destination_address,w.amount,w.fee,w.net_amount,w.network,w.currency,w.idempotency_key,w.processor_attempt_count
         FROM withdrawals w JOIN withdrawal_addresses wa ON wa.id=w.withdrawal_address_id
        WHERE w.status='PROCESSING' AND w.screening_status='CLEAR' AND wa.status='ACTIVE' AND wa.cooldown_until<=now()
          AND (w.processor_claim_id IS NULL OR w.processor_lease_until<=now())
          AND w.processor_attempt_count<$1
          AND (SELECT COUNT(DISTINCT a.admin_uid) FROM withdrawal_approvals a WHERE a.withdrawal_id=w.id AND a.decision='APPROVE')>=2
        ORDER BY w.approved_at ASC NULLS LAST,w.requested_at ASC
        FOR UPDATE OF w SKIP LOCKED LIMIT 1`,
      [input.maxAttempts],
    );
    if(!candidate.rows[0]) return null;
    const claimId=randomUUID();
    const updated=await client.query(
      `UPDATE withdrawals SET processor_claim_id=$2,processor_claimed_by=$4,processor_claimed_at=now(),
         processor_lease_until=now()+($3::text||' seconds')::interval,
         processor_attempt_count=processor_attempt_count+1 WHERE id=$1
       RETURNING processor_attempt_count,processor_lease_until`,
      [candidate.rows[0].id,claimId,input.leaseSeconds,input.processorId.slice(0,80)],
    );
    const row=candidate.rows[0];
    return {claimId,withdrawalId:row.id,destinationAddress:row.destination_address,amount:String(row.amount),fee:String(row.fee),netAmount:String(row.net_amount),network:row.network,currency:row.currency,idempotencyKey:'withdrawal:'+String(row.id),attempt:Number(updated.rows[0].processor_attempt_count),leaseUntil:updated.rows[0].processor_lease_until};
  });
}

export async function markWithdrawalPayoutSubmitted(input:{withdrawalId:string;claimId:string;providerPayoutId:string}) {
  if(!input.providerPayoutId.trim()) throw Object.assign(new Error('Custody provider payout reference is required.'),{code:'PAYOUT_PROVIDER_REFERENCE_REQUIRED',statusCode:400});
  return dbTransaction(async(client)=>{
    const row=await client.query(`SELECT id,status,screening_status,processor_claim_id,provider_payout_id FROM withdrawals WHERE id=$1 FOR UPDATE`,[input.withdrawalId]);
    if(!row.rows[0]) throw Object.assign(new Error('Withdrawal not found.'),{code:'WITHDRAWAL_NOT_FOUND',statusCode:404});
    if(row.rows[0].status!=='PROCESSING'||row.rows[0].screening_status!=='CLEAR'||String(row.rows[0].processor_claim_id)!==input.claimId) throw Object.assign(new Error('Active approved payout claim is required.'),{code:'PAYOUT_CLAIM_INVALID',statusCode:409});
    if(row.rows[0].provider_payout_id) {
      if(row.rows[0].provider_payout_id!==input.providerPayoutId) throw Object.assign(new Error('Provider payout reference conflicts with the recorded reference.'),{code:'PAYOUT_PROVIDER_REFERENCE_CONFLICT',statusCode:409});
      return {replayed:true,providerPayoutId:input.providerPayoutId};
    }
    const approvals=await client.query(`SELECT COUNT(DISTINCT admin_uid)::int AS count FROM withdrawal_approvals WHERE withdrawal_id=$1 AND decision='APPROVE'`,[input.withdrawalId]);
    if(Number(approvals.rows[0]?.count||0)<2) throw Object.assign(new Error('Two distinct approvals are required before provider submission.'),{code:'WITHDRAWAL_DUAL_APPROVAL_REQUIRED',statusCode:409});
    await client.query(`UPDATE withdrawals SET provider_payout_id=$2,payout_submitted_at=now() WHERE id=$1`,[input.withdrawalId,input.providerPayoutId.slice(0,200)]);
    return {replayed:false,providerPayoutId:input.providerPayoutId};
  });
}

export async function getDailyCustomerLiability(asset='USDT') {
  const result=await dbQuery<any>(
    `SELECT COALESCE(SUM(available_balance+locked_balance+gas_reserve),0)::text AS liability
       FROM wallet_accounts WHERE currency=$1`,
    [asset],
  );
  return Number(result.rows[0]?.liability||0);
}

export async function recordConfirmedDeposit(input: { firebaseUid: string; network: string; txHash: string; amount: number; maxAmount:number; dailyLimit:number; blockNumber?: number; confirmations: number; destinationAddress?: string; sourceAddress: string; screeningProvider: string }) {
  const amount=Number(input.amount);
  if(!Number.isFinite(amount)||amount<=0) throw Object.assign(new Error('Deposit amount must be positive and finite.'),{code:'DEPOSIT_AMOUNT_INVALID'});
  if(!Number.isFinite(input.maxAmount)||input.maxAmount<=0||!Number.isFinite(input.dailyLimit)||input.dailyLimit<=0) throw Object.assign(new Error('Deposit limits are not configured.'),{code:'DEPOSIT_LIMITS_NOT_CONFIGURED',statusCode:503});
  if(amount>input.maxAmount) throw Object.assign(new Error('Deposit amount exceeds the configured limit.'),{code:'DEPOSIT_AMOUNT_LIMIT',statusCode:422});
  if(!/^0x[a-fA-F0-9]{64}$/.test(input.txHash||'')) throw Object.assign(new Error('Deposit transaction hash is invalid.'),{code:'DEPOSIT_TX_HASH_REQUIRED'});
  if(!/^0x[a-fA-F0-9]{40}$/.test(input.sourceAddress||'')||!input.screeningProvider.trim()) throw Object.assign(new Error('Deposit source screening is required.'),{code:'DEPOSIT_SCREENING_REQUIRED',statusCode:503});
  return dbTransaction(async(client)=>{
    const user=await client.query("SELECT id FROM users WHERE firebase_uid=$1 FOR UPDATE",[input.firebaseUid]);
    if(!user.rows[0]) throw Object.assign(new Error('Account not provisioned.'),{code:'ACCOUNT_NOT_PROVISIONED'});
    const existing=await client.query("SELECT id,user_id,status,amount FROM deposits WHERE network=$1 AND lower(tx_hash)=lower($2) FOR UPDATE",[input.network,input.txHash]);
    if(existing.rows[0]) {
      if(String(existing.rows[0].user_id)!==String(user.rows[0].id)) throw Object.assign(new Error('This transaction hash has already been credited to another account.'),{code:'DEPOSIT_TX_ALREADY_CLAIMED'});
      if(Number(existing.rows[0].amount)!==amount) throw Object.assign(new Error('This transaction hash was previously recorded with a different amount.'),{code:'DEPOSIT_REPLAY_CONFLICT',statusCode:409});
      return {depositId:existing.rows[0].id,status:existing.rows[0].status,amount,replayed:true};
    }
    const daily=await client.query("SELECT COALESCE(sum(amount),0)::text AS total FROM deposits WHERE user_id=$1 AND status IN ('PENDING','CREDITED') AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",[user.rows[0].id]);
    if(Number(daily.rows[0]?.total||0)+amount>input.dailyLimit) throw Object.assign(new Error('Daily deposit limit would be exceeded.'),{code:'DEPOSIT_DAILY_LIMIT',statusCode:422});
    const deposit=await client.query(
      "INSERT INTO deposits(user_id,network,tx_hash,destination_address,source_address,amount,block_number,confirmations,status,verified_at,screening_status,screening_provider) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',now(),'PENDING',$9) RETURNING id",
      [user.rows[0].id,input.network,input.txHash.toLowerCase(),input.destinationAddress||null,input.sourceAddress.toLowerCase(),amount,input.blockNumber||null,input.confirmations,input.screeningProvider],
    );
    return {depositId:deposit.rows[0].id,status:'PENDING_SCREENING',amount,replayed:false};
  });
}

export async function applyDepositScreeningResult(input:{depositId:string;provider:string;providerEventId:string;status:'CLEAR'|'BLOCKED'|'ERROR';reasonCode?:string;reference?:string}) {
  if(!input.provider.trim()||!input.providerEventId.trim()) throw Object.assign(new Error('Screening provider event identity is required.'),{code:'SCREENING_EVENT_INVALID',statusCode:400});
  return dbTransaction(async(client)=>{
    const prior=await client.query("SELECT e.id,e.deposit_id,e.status,d.id AS deposit_id,d.amount,d.tx_hash,d.block_number,d.credited_at,d.status AS deposit_status,u.firebase_uid FROM deposit_screening_events e JOIN deposits d ON d.id=e.deposit_id JOIN users u ON u.id=d.user_id WHERE e.provider=$1 AND e.provider_event_id=$2 FOR UPDATE OF e,d",[input.provider,input.providerEventId]);
    if(prior.rows[0]) {
      if(String(prior.rows[0].deposit_id)!==input.depositId) throw Object.assign(new Error('Screening event ID is already bound to another deposit.'),{code:'SCREENING_EVENT_CONFLICT',statusCode:409});
      if(prior.rows[0].status!==input.status) throw Object.assign(new Error('Screening event ID was reused with a different result.'),{code:'SCREENING_EVENT_CONFLICT',statusCode:409});
      const effectiveStatus=prior.rows[0].deposit_status==='CREDITED'?'CREDITED':prior.rows[0].deposit_status==='REJECTED'?'REJECTED':'PENDING';
      return {replayed:true,status:effectiveStatus,depositId:String(prior.rows[0].deposit_id),firebaseUid:String(prior.rows[0].firebase_uid),amount:Number(prior.rows[0].amount),txHash:String(prior.rows[0].tx_hash),blockNumber:prior.rows[0].block_number===null?null:Number(prior.rows[0].block_number),creditedAt:prior.rows[0].credited_at?new Date(prior.rows[0].credited_at).toISOString():null};
    }
    const result=await client.query("SELECT d.id,d.user_id,u.firebase_uid,d.network,d.amount,d.tx_hash,d.block_number,d.credited_at,d.status,d.screening_status,d.screening_provider FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.id=$1 FOR UPDATE OF d",[input.depositId]);
    const deposit=result.rows[0];
    if(!deposit) throw Object.assign(new Error('Deposit not found.'),{code:'DEPOSIT_NOT_FOUND',statusCode:404});
    const callbackInfo={depositId:String(deposit.id),firebaseUid:String(deposit.firebase_uid),amount:Number(deposit.amount),txHash:String(deposit.tx_hash),blockNumber:deposit.block_number===null?null:Number(deposit.block_number),creditedAt:deposit.credited_at?new Date(deposit.credited_at).toISOString():null};
    if(deposit.screening_provider!==input.provider) throw Object.assign(new Error('Screening provider does not match the configured provider for this deposit.'),{code:'SCREENING_PROVIDER_MISMATCH',statusCode:409});
    if(deposit.status==='CREDITED') {
      if(input.status!=='CLEAR') throw Object.assign(new Error('A non-clear screening result cannot be applied after deposit credit; escalate for manual review.'),{code:'DEPOSIT_ALREADY_CREDITED_SCREENING_CONFLICT',statusCode:409});
      return {replayed:true,status:'CREDITED',...callbackInfo};
    }
    if(deposit.status!=='PENDING') throw Object.assign(new Error('Deposit is no longer awaiting screening.'),{code:'DEPOSIT_STATE_CONFLICT',statusCode:409});
    await client.query("INSERT INTO deposit_screening_events(deposit_id,provider,provider_event_id,status,reason_code) VALUES($1,$2,$3,$4,$5)",[input.depositId,input.provider,input.providerEventId,input.status,String(input.reasonCode||'').slice(0,100)]);
    await client.query("UPDATE deposits SET screening_status=$2,screening_reference=$3,screening_checked_at=now(),screening_reason_code=$4,status=CASE WHEN $2='BLOCKED' THEN 'REJECTED' ELSE status END WHERE id=$1",[input.depositId,input.status,String(input.reference||'').slice(0,200)||null,String(input.reasonCode||'').slice(0,100)||null]);
    if(input.status!=='CLEAR') return {replayed:false,status:input.status==='BLOCKED'?'REJECTED':'PENDING',...callbackInfo};
    const wallet=await client.query("SELECT id,available_balance FROM wallet_accounts WHERE user_id=$1 AND currency='USDT' FOR UPDATE",[deposit.user_id]);
    if(!wallet.rows[0]) throw Object.assign(new Error('Deposit wallet is not provisioned.'),{code:'WALLET_NOT_PROVISIONED',statusCode:409});
    const before=Number(wallet.rows[0].available_balance),amount=Number(deposit.amount),after=toLedgerAmount(before+amount);
    await client.query("UPDATE wallet_accounts SET available_balance=$2,total_inflow=total_inflow+$3,version=version+1,updated_at=now() WHERE id=$1",[wallet.rows[0].id,after,amount]);
    await client.query("INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description,metadata) VALUES($1,'CREDIT',$2,$3,$4,'ONCHAIN_DEPOSIT','DEPOSIT',$5,$6,$7::jsonb)",[wallet.rows[0].id,amount,before,after,input.depositId,'Screened and confirmed '+deposit.network+' deposit',JSON.stringify({screeningProvider:input.provider,screeningReference:String(input.reference||'').slice(0,200)})]);
    const credited=await client.query("UPDATE deposits SET status='CREDITED',credited_at=now() WHERE id=$1 RETURNING credited_at",[input.depositId]);
    callbackInfo.creditedAt=credited.rows[0]?.credited_at?new Date(credited.rows[0].credited_at).toISOString():null;
    return {replayed:false,status:'CREDITED',...callbackInfo};
  });
}


export async function updateBotRuntimeStatus(input: {
  firebaseUid: string;
  externalBotId: string;
  status: string;
  exchange?: string;
  symbol?: string;
}) {
  const user = await getUserByFirebaseUid(input.firebaseUid);
  if (!user) {
    throw Object.assign(new Error('User is not provisioned.'), {
      code: 'ACCOUNT_NOT_PROVISIONED',
    });
  }

  const cleanTarget = String(input.externalBotId || '').replace('/', '').toUpperCase();
  const cleanSymbol = input.symbol ? String(input.symbol).replace('/', '').toUpperCase() : '';

  const params: unknown[] = [user.id, input.externalBotId, input.status, cleanTarget];
  let where = `user_id = $1 AND (
    id::text = $2
    OR external_bot_id = $2
    OR external_bot_id = $4
    OR external_bot_id LIKE $2 || '_%'
    OR external_bot_id LIKE '%' || $2 || '%'
    ${cleanSymbol ? `OR upper(symbol) = $${params.length + 1} OR replace(upper(symbol), '/', '') = $${params.length + 1}` : ''}
  )`;
  if (cleanSymbol) {
    params.push(cleanSymbol);
  }
  if (input.exchange) {
    params.push(input.exchange);
    where += ` AND id IN (
      SELECT b2.id FROM bots b2 JOIN exchange_accounts ea2 ON ea2.id=b2.exchange_account_id
       WHERE b2.id=bots.id AND lower(ea2.exchange)=lower($${params.length})
    )`;
  }
  let result = await dbQuery(
    `UPDATE bots
        SET status = $3,
            updated_at = now()
      WHERE ${where}
      RETURNING id, status`,
    params,
  );

  if (!result.rows[0] && input.exchange) {
    result = await dbQuery(
      `UPDATE bots
          SET status = $3,
              updated_at = now()
        WHERE user_id = $1 AND (
          id::text = $2
          OR external_bot_id = $2
          OR external_bot_id = $4
          OR external_bot_id LIKE $2 || '_%'
          OR external_bot_id LIKE '%' || $2 || '%'
          ${cleanSymbol ? `OR upper(symbol) = $5 OR replace(upper(symbol), '/', '') = $5` : ''}
        )
        RETURNING id, status`,
      cleanSymbol ? [user.id, input.externalBotId, input.status, cleanTarget, cleanSymbol] : [user.id, input.externalBotId, input.status, cleanTarget],
    );
  }

  if (!result.rows[0]) {
    throw Object.assign(new Error('Bot runtime is not provisioned.'), {
      code: 'BOT_RUNTIME_NOT_FOUND',
    });
  }

  return {
    botId: result.rows[0].id,
    status: result.rows[0].status,
  };
}

export async function upsertBotRuntime(input: { firebaseUid: string; externalBotId: string; name: string; exchange: string; symbol: string; strategyType: string; mode: string; status: string; config?: Record<string, any> }) {
  const user = await getUserByFirebaseUid(input.firebaseUid);
  if (!user) throw new Error('User is not provisioned.');

  const exchangeAccount = await dbQuery<any>(
    `SELECT ea.id, ea.sandbox, ea.status
       FROM exchange_accounts ea
      WHERE ea.user_id=$1
        AND lower(ea.exchange)=lower($2)
        AND ea.status='ACTIVE'
      ORDER BY ea.updated_at DESC NULLS LAST, ea.created_at DESC
      LIMIT 1`,
    [user.id, input.exchange],
  );

  if (!exchangeAccount.rows[0]) {
    throw Object.assign(new Error('Active exchange account is required before registering a bot.'), {
      code: 'BOT_EXCHANGE_ACCOUNT_MISSING',
    });
  }

  const exchangeAccountId = String(exchangeAccount.rows[0].id);
  const cleanTarget = String(input.externalBotId || '').replace('/', '').toUpperCase();
  const cleanSymbol = input.symbol ? String(input.symbol).replace('/', '').toUpperCase() : '';

  const existing = await dbQuery<any>(
    `SELECT b.id
       FROM bots b
      WHERE b.user_id=$1
        AND b.exchange_account_id=$3
        AND (
          b.id::text=$2
          OR b.external_bot_id=$2
          OR b.external_bot_id=$5
          OR upper(b.symbol)=upper($4)
          OR replace(upper(b.symbol), '/', '')=$6
        )
        AND b.status != 'DELETED'
      ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC
      LIMIT 1`,
    [user.id, input.externalBotId, exchangeAccountId, input.symbol, cleanTarget, cleanSymbol],
  );

  let botId: string;
  if (existing.rows[0]) {
    const updated = await dbQuery<any>(
      `UPDATE bots
          SET name=$2,strategy_type=$3,status=$4,mode=$5,external_bot_id=$6,updated_at=now()
        WHERE id=$1
        RETURNING id`,
      [existing.rows[0].id, input.name, input.strategyType, input.status, input.mode, input.externalBotId],
    );
    botId = String(updated.rows[0].id);
  } else {
    const created = await dbQuery<any>(
      `INSERT INTO bots(user_id,name,exchange_account_id,symbol,strategy_type,status,mode,external_bot_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [user.id,input.name,exchangeAccountId,input.symbol,input.strategyType,input.status,input.mode,input.externalBotId],
    );
    botId = String(created.rows[0].id);
  }
  const c=input.config||{};
  const resolvedMaxLayers = Number(c.maxLayers) > 0
    ? Number(c.maxLayers)
    : (Number(c.averagingLayers || 0) + Number(c.gridLayers || 0) || 10);
  await dbQuery(`INSERT INTO bot_strategy_configs(bot_id,base_order_usd,take_profit_pct,trailing_tp_pct,max_layers,step_deviation_pct,step_scale,volume_multiplier,max_capital_usd,min_price,max_price,config)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(bot_id) DO UPDATE SET base_order_usd=EXCLUDED.base_order_usd,take_profit_pct=EXCLUDED.take_profit_pct,trailing_tp_pct=EXCLUDED.trailing_tp_pct,max_layers=EXCLUDED.max_layers,step_deviation_pct=EXCLUDED.step_deviation_pct,step_scale=EXCLUDED.step_scale,volume_multiplier=EXCLUDED.volume_multiplier,max_capital_usd=EXCLUDED.max_capital_usd,min_price=EXCLUDED.min_price,max_price=EXCLUDED.max_price,config=EXCLUDED.config`,
    [botId,Number(c.baseAmount||0),Number(c.baseTp||0),Number(c.tpCallbackPct||0),resolvedMaxLayers,Number(c.averageDownPct||0),1.25,1.3,Number(c.maxCapitalUsd||0),Number(c.minPrice||0)||null,Number(c.maxPrice||0)||null,JSON.stringify(c)]);
  return botId;
}

export async function getExchangeConnection(firebaseUid: string, exchange: string) {
  const result = await dbQuery<any>(
    `SELECT ea.id, ea.exchange, ea.sandbox, ea.status, ea.identity_key, ea.identity_type,
            ea.identity_hint, ea.credential_fingerprint, ea.reported_identity_key, ea.credential_version, ea.updated_at
       FROM exchange_accounts ea
       JOIN users u ON u.id = ea.user_id
      WHERE u.firebase_uid = $1 AND lower(ea.exchange) = lower($2)
      ORDER BY ea.updated_at DESC NULLS LAST, ea.created_at DESC
      LIMIT 1`,
    [firebaseUid, exchange],
  );
  return result.rows[0] || null;
}

export async function findExchangeIdentityOwner(input: { exchange: string; sandbox: boolean; identityKey?: string; credentialFingerprint?: string; reportedIdentityKey?: string; excludeFirebaseUid?: string }) {
  const result = await dbQuery<any>(
    `SELECT u.firebase_uid, u.member_id, ea.id AS exchange_account_id, ea.exchange, ea.sandbox, ea.status, ea.identity_type, ea.identity_hint
       FROM exchange_accounts ea
       JOIN users u ON u.id = ea.user_id
      WHERE lower(ea.exchange) = lower($1)
        AND ea.sandbox = $2
        AND (ea.identity_key = $3 OR ea.credential_fingerprint = $4 OR ($5::text IS NOT NULL AND ea.reported_identity_key = $5))
        AND ea.status = 'ACTIVE'
        AND ($6::text IS NULL OR u.firebase_uid <> $6)
      LIMIT 1`,
    [input.exchange, input.sandbox, input.identityKey || null, input.credentialFingerprint || null, input.reportedIdentityKey || null, input.excludeFirebaseUid || null],
  );
  return result.rows[0] || null;
}

export async function saveExchangeCredential(input: {
  firebaseUid: string;
  exchange: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  sandbox: boolean;
  identityKey: string;
  identityType: 'exchange_reported' | 'credential_fingerprint';
  identityHint?: string;
  credentialFingerprint: string;
  reportedIdentityKey?: string;
}) {
  const user = await getUserByFirebaseUid(input.firebaseUid);
  if (!user) throw new Error('User is not provisioned.');

  return dbTransaction(async (client) => {
    if (input.sandbox === false) {
      if (user.role !== 'admin' && user.role !== 'superadmin') {
        const activeLicense = await client.query(`SELECT id FROM licenses WHERE user_id=$1 AND status='ACTIVE'`, [user.id]);
        if (activeLicense.rowCount === 0) {
          throw Object.assign(new Error('Anda harus membayar aktivasi lisensi (Live Mode) terlebih dahulu.'), { code: 'LICENSE_REQUIRED_FOR_LIVE' });
        }
      }
    }

    const conflict = await client.query(
      `SELECT u.firebase_uid, ea.id, ea.identity_type, ea.identity_hint
         FROM exchange_accounts ea
         JOIN users u ON u.id = ea.user_id
        WHERE lower(ea.exchange) = lower($1)
          AND ea.sandbox = $2
          AND (ea.identity_key = $3 OR ea.credential_fingerprint = $4 OR ($5::text IS NOT NULL AND ea.reported_identity_key = $5))
          AND ea.status = 'ACTIVE'
          AND u.id <> $6
        LIMIT 1
        FOR UPDATE OF ea`,
      [input.exchange, input.sandbox, input.identityKey, input.credentialFingerprint, input.reportedIdentityKey || null, user.id],
    );
    if (conflict.rows[0]) {
      throw Object.assign(new Error('Exchange account ini sudah terhubung ke akun GAIN lain.'), {
        code: 'EXCHANGE_ACCOUNT_ALREADY_LINKED',
        ownerFirebaseUid: conflict.rows[0].firebase_uid,
        identityType: conflict.rows[0].identity_type,
        identityHint: conflict.rows[0].identity_hint,
      });
    }

    const previousCredential = await client.query(
      `SELECT ec.version, ec.sandbox, ea.identity_key, ea.identity_type, ea.identity_hint, ea.credential_fingerprint, ea.reported_identity_key
         FROM exchange_credentials ec
         LEFT JOIN exchange_accounts ea ON ea.user_id = ec.user_id AND lower(ea.exchange) = lower(ec.exchange)
        WHERE ec.user_id = $1 AND lower(ec.exchange) = lower($2)
        LIMIT 1`,
      [user.id, input.exchange],
    );

    await client.query(
      `INSERT INTO exchange_credentials(user_id,exchange,ciphertext,iv,auth_tag,sandbox,status)
       VALUES($1,$2,$3,$4,$5,$6,'ACTIVE')
       ON CONFLICT(user_id,exchange) DO UPDATE SET
         ciphertext=EXCLUDED.ciphertext,
         iv=EXCLUDED.iv,
         auth_tag=EXCLUDED.auth_tag,
         sandbox=EXCLUDED.sandbox,
         status='ACTIVE',
         version=exchange_credentials.version+1,
         updated_at=now()`,
      [user.id,input.exchange,input.ciphertext,input.iv,input.authTag,input.sandbox],
    );

    const account = await client.query(
      `INSERT INTO exchange_accounts(
         user_id,exchange,credential_ref,sandbox,status,identity_key,identity_type,identity_hint,credential_fingerprint,reported_identity_key,credential_version
       ) VALUES($1,$2,$3,$4,'ACTIVE',$5,$6,$7,$8,$9,COALESCE((SELECT version FROM exchange_credentials WHERE user_id=$1 AND exchange=$2),1))
       ON CONFLICT(user_id,exchange) DO UPDATE SET
         credential_ref=EXCLUDED.credential_ref,
         sandbox=EXCLUDED.sandbox,
         status='ACTIVE',
         identity_key=EXCLUDED.identity_key,
         identity_type=EXCLUDED.identity_type,
         identity_hint=EXCLUDED.identity_hint,
         credential_fingerprint=EXCLUDED.credential_fingerprint,
         reported_identity_key=EXCLUDED.reported_identity_key,
         credential_version=EXCLUDED.credential_version,
         updated_at=now()
       RETURNING id, credential_version`,
      [user.id,input.exchange,`exchange_credentials:${input.exchange}`,input.sandbox,input.identityKey,input.identityType,input.identityHint || null,input.credentialFingerprint,input.reportedIdentityKey || null],
    );

    const newVersion = Number(account.rows[0]?.credential_version || 1);
    await client.query(
      `INSERT INTO exchange_credential_history(
         user_id, exchange, sandbox, action, previous_version, new_version,
         previous_credential_fingerprint, new_credential_fingerprint,
         previous_identity_key, new_identity_key,
         previous_reported_identity_key, new_reported_identity_key,
         previous_identity_type, new_identity_type
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        user.id, input.exchange, input.sandbox, previousCredential.rows[0] ? (previousCredential.rows[0].credential_fingerprint === input.credentialFingerprint ? 'RECONNECTED' : 'ROTATED') : 'CONNECTED',
        previousCredential.rows[0]?.version ? Number(previousCredential.rows[0].version) : null, newVersion,
        previousCredential.rows[0]?.credential_fingerprint || null, input.credentialFingerprint,
        previousCredential.rows[0]?.identity_key || null, input.identityKey,
        previousCredential.rows[0]?.reported_identity_key || null, input.reportedIdentityKey || null,
        previousCredential.rows[0]?.identity_type || null, input.identityType,
      ],
    );
    return { exchangeAccountId: account.rows[0]?.id, credentialVersion: newVersion, reportedIdentityKey: input.reportedIdentityKey };
  });
}

export async function getExchangeCredential(firebaseUid: string, exchange: string) {
  const result = await dbQuery<any>(`SELECT ec.ciphertext,ec.iv,ec.auth_tag,ec.sandbox,ec.status,ec.version,ea.identity_key,ea.identity_type,ea.identity_hint,ea.credential_fingerprint,ea.reported_identity_key,ea.id AS exchange_account_id FROM exchange_credentials ec JOIN users u ON u.id=ec.user_id LEFT JOIN exchange_accounts ea ON ea.user_id=ec.user_id AND lower(ea.exchange)=lower(ec.exchange) WHERE u.firebase_uid=$1 AND lower(ec.exchange)=lower($2) AND ec.status='ACTIVE'`, [firebaseUid,exchange]);
  return result.rows[0] || null;
}

export async function getExchangeCredentialHistory(firebaseUid: string, exchange?: string) {
  const result = await dbQuery<any>(
    `SELECT h.exchange, h.sandbox, h.action, h.previous_version, h.new_version,
            h.previous_identity_type, h.new_identity_type, h.created_at
       FROM exchange_credential_history h
       JOIN users u ON u.id = h.user_id
      WHERE u.firebase_uid = $1
        AND ($2::text IS NULL OR lower(h.exchange) = lower($2))
      ORDER BY h.created_at DESC
      LIMIT 25`,
    [firebaseUid, exchange || null],
  );
  return result.rows;
}

export async function deleteExchangeCredential(firebaseUid: string, exchange: string) {
  await dbTransaction(async (client) => {
    await client.query(`UPDATE exchange_credentials ec SET status='REVOKED',updated_at=now() FROM users u WHERE ec.user_id=u.id AND u.firebase_uid=$1 AND lower(ec.exchange)=lower($2)`, [firebaseUid,exchange]);
    await client.query(`UPDATE exchange_accounts ea SET status='REVOKED',updated_at=now() FROM users u WHERE ea.user_id=u.id AND u.firebase_uid=$1 AND lower(ea.exchange)=lower($2)`, [firebaseUid,exchange]);
  });
}

export async function getUserByMemberId(memberId: string) {
  const result = await dbQuery<any>('SELECT * FROM users WHERE member_id=$1', [memberId]);
  return result.rows[0] || null;
}

export async function consumeTotpCounter(firebaseUid: string, counter: number): Promise<boolean> {
  const result = await dbQuery<any>(
    `UPDATE security_credentials s SET last_totp_counter=$2, updated_at=now()
      FROM users u
     WHERE s.user_id=u.id AND u.firebase_uid=$1 AND (s.last_totp_counter IS NULL OR s.last_totp_counter < $2)
     RETURNING s.user_id`,
    [firebaseUid, counter],
  );
  return result.rows.length > 0;
}

export async function applyBotFillToPosition(input: { externalBotId: string; symbol: string; exchange: string; isSandbox?: boolean; side: 'buy'|'sell'; quantity: number; price: number; feeAmount?: number }) {
  return dbTransaction(async (client) => {
    const bot = await client.query(
      `SELECT b.id FROM bots b
         JOIN exchange_accounts ea ON ea.id = b.exchange_account_id
        WHERE b.external_bot_id=$1
          AND upper(b.symbol)=upper($2)
          AND lower(ea.exchange)=lower($3)
          AND ea.sandbox=$4
        ORDER BY b.updated_at DESC
        LIMIT 1
        FOR UPDATE OF b`,
      [input.externalBotId, input.symbol, input.exchange, Boolean(input.isSandbox)]
    );
    if (!bot.rows[0]) return null;
    const current = await client.query(`SELECT * FROM positions WHERE bot_id=$1 AND symbol=$2 FOR UPDATE`, [bot.rows[0].id,input.symbol]);
    const row = current.rows[0];
    const qty=Number(input.quantity); const price=Number(input.price); const fee=Number(input.feeAmount||0);
    const isBaseFee = fee > 0 && fee < qty * 0.05;
    const netQty = (input.side === 'buy' && isBaseFee) ? Math.max(0, qty - fee) : qty;
    if(!row) {
      if(input.side==='sell') return null;
      const created=await client.query(`INSERT INTO positions(bot_id,symbol,quantity,average_entry,realized_pnl,unrealized_pnl,total_fees) VALUES($1,$2,$3,$4,0,0,$5) RETURNING *`, [bot.rows[0].id,input.symbol,netQty,price,fee]);
      return created.rows[0];
    }
    const oldQty=Number(row.quantity); const oldAvg=Number(row.average_entry); let newQty=oldQty; let newAvg=oldAvg; let realized=Number(row.realized_pnl);
    if(input.side==='buy') { newQty=oldQty+netQty; newAvg=newQty>0?((oldQty*oldAvg)+(qty*price))/newQty:0; }
    else { const sold=Math.min(qty,oldQty); realized += (price-oldAvg)*sold-fee; newQty=Math.max(0,oldQty-qty); if(newQty===0)newAvg=0; }
    const updated=await client.query(`UPDATE positions SET quantity=$3,average_entry=$4,realized_pnl=$5,total_fees=total_fees+$6,updated_at=now() WHERE bot_id=$1 AND symbol=$2 RETURNING *`, [bot.rows[0].id,input.symbol,newQty,newAvg,realized,fee]);
    return updated.rows[0];
  });
}

export async function topupGasAtomic(input: { firebaseUid: string; amount: number; idempotencyKey?: string }) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('Gas top-up amount must be positive and finite.'), { code: 'GAS_TOPUP_AMOUNT_INVALID' });
  if (amount > 1_000_000) throw Object.assign(new Error('Gas top-up amount exceeds the configured safety limit.'), { code: 'GAS_TOPUP_AMOUNT_LIMIT' });
  if (!input.idempotencyKey?.trim()) throw Object.assign(new Error('Gas top-up idempotency key is required.'), { code: 'GAS_TOPUP_IDEMPOTENCY_REQUIRED' });
  return dbTransaction(async (client) => {
    const user = await client.query(`SELECT id, sponsor_user_id FROM users WHERE firebase_uid=$1 FOR UPDATE`, [input.firebaseUid]);
    if (!user.rows[0]) throw Object.assign(new Error('Account not provisioned.'), { code: 'ACCOUNT_NOT_PROVISIONED' });

    const idempotencyKey = input.idempotencyKey?.trim().slice(0, 128) || null;
    if (idempotencyKey) {
      const replay = await client.query(
        `SELECT l.id, l.balance_after, l.metadata, w.user_id
           FROM wallet_ledger l
           JOIN wallet_accounts w ON w.id = l.account_id
          WHERE l.idempotency_key = $1
          LIMIT 1`,
        [idempotencyKey],
      );
      if (replay.rows[0]) {
        if (Number(replay.rows[0].user_id) !== Number(user.rows[0].id)) {
          throw Object.assign(new Error('Idempotency key collision across accounts.'), { code: 'IDEMPOTENCY_KEY_COLLISION' });
        }
        const metadata = replay.rows[0].metadata || {};
        return {
          replayed: true,
          ledgerId: replay.rows[0].id,
          newBalance: Number(replay.rows[0].balance_after),
          newGasReserve: Number(metadata.newGasReserve || 0),
          bonusUsdt: Number(metadata.bonusUsdt || 0),
          referralBonusUsdt: Number(metadata.referralBonusUsdt || 0),
        };
      }
    }
    const { bonusUsdt } = getGasTopupBonus(amount);
    const wallet = await client.query(`SELECT * FROM wallet_accounts WHERE user_id=$1 AND currency='USDT' FOR UPDATE`, [user.rows[0].id]);
    if (!wallet.rows[0] || Number(wallet.rows[0].available_balance) < amount) {
      throw Object.assign(new Error('Insufficient available balance.'), { code: 'INSUFFICIENT_BALANCE' });
    }

    const sponsorId = user.rows[0].sponsor_user_id;
    let referralBonusUsdt = 0;
    if (sponsorId) {
      referralBonusUsdt = toLedgerAmount(amount * FINANCIAL_CONFIG.referral.topupGasNonCashPct / 100);
    }

    const before = Number(wallet.rows[0].available_balance);
    const after = toLedgerAmount(before - amount);
    const newGasReserve = toLedgerAmount(Number(wallet.rows[0].gas_reserve) + amount + bonusUsdt);
    const newNonCashGas = toLedgerAmount(Number(wallet.rows[0].non_cash_gas_bonus) + bonusUsdt);
    await client.query(
      `UPDATE wallet_accounts
          SET available_balance=$2,
              total_outflow=total_outflow+$3,
              gas_reserve=$4,
              non_cash_gas_bonus=$5,
              version=version+1,
              updated_at=now()
        WHERE id=$1`,
      [wallet.rows[0].id, after, amount, newGasReserve, newNonCashGas],
    );

    const ledger = await client.query(
      `INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,description,idempotency_key,metadata)
       VALUES($1,'DEBIT',$2,$3,$4,'GAS_TOPUP','Move available balance into gas reserve',$5,$6::jsonb) RETURNING id`,
      [wallet.rows[0].id, amount, before, after, idempotencyKey, JSON.stringify({ bonusUsdt, referralBonusUsdt, newGasReserve, promoVersion: FINANCIAL_CONFIG.version })],
    );

    if (sponsorId && referralBonusUsdt > 0) {
      const sponsorWallet = await client.query(
        `SELECT id, gas_reserve, non_cash_gas_bonus FROM wallet_accounts WHERE user_id=$1 AND currency='USDT' FOR UPDATE`,
        [sponsorId],
      );
      if (sponsorWallet.rows[0]) {
        const sponsorGas = toLedgerAmount(Number(sponsorWallet.rows[0].gas_reserve) + referralBonusUsdt);
        const sponsorNonCash = toLedgerAmount(Number(sponsorWallet.rows[0].non_cash_gas_bonus) + referralBonusUsdt);
        await client.query(
          `UPDATE wallet_accounts SET gas_reserve=$2, non_cash_gas_bonus=$3, version=version+1, updated_at=now() WHERE id=$1`,
          [sponsorWallet.rows[0].id, sponsorGas, sponsorNonCash],
        );
        await client.query(
          `INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description,metadata)
           VALUES($1,'CREDIT',$2,$3,$4,'REFERRAL_TOPUP_GAS','GAS_TOPUP',$5,$6,$7::jsonb)`,
          [sponsorWallet.rows[0].id, referralBonusUsdt, Number(sponsorWallet.rows[0].gas_reserve), sponsorGas, ledger.rows[0].id, '10% non-cash referral gas reward', JSON.stringify({ sourceUserId: user.rows[0].id, pct: FINANCIAL_CONFIG.referral.topupGasNonCashPct })],
        );
        await client.query(
          `INSERT INTO referral_events(sponsor_user_id,source_user_id,event_type,gross_amount,reward_amount,cashable,metadata)
           VALUES($1,$2,'TOPUP',$3,$4,false,$5)`,
          [sponsorId, user.rows[0].id, amount, referralBonusUsdt, JSON.stringify({ gasTopupLedgerId: ledger.rows[0].id })],
        );
      }
    }

    return { replayed: false, ledgerId: ledger.rows[0].id, newBalance: after, newGasReserve, bonusUsdt, referralBonusUsdt };
  });
}

export async function deductProfitShareFromGasPoolClient(
  client: any,
  input: {
    userId: string | number;
    realizedProfitUsdt: number;
    orderId?: string;
    pair?: string;
  },
) {
  const EPSILON = 1e-10;
  if (!Number.isFinite(input.realizedProfitUsdt) || input.realizedProfitUsdt <= EPSILON) {
    return { deducted: 0, newGasReserve: 0, managementUsdt: 0, uplineCashUsdt: 0, ledgerId: null };
  }

  const breakdown = calculateProfitShareBreakdown(input.realizedProfitUsdt);
  const platformFeeUsdt = breakdown.platformFeeUsdt;

  const walletResult = await client.query(
    `SELECT id, gas_reserve FROM wallet_accounts WHERE user_id = $1 AND currency = 'USDT' FOR UPDATE`,
    [input.userId],
  );

  if (!walletResult.rows[0]) {
    return { deducted: 0, newGasReserve: 0, managementUsdt: 0, uplineCashUsdt: 0, ledgerId: null };
  }

  const currentGas = Number(walletResult.rows[0].gas_reserve || 0);
  const actualDeduction = toLedgerAmount(Math.min(currentGas, platformFeeUsdt));
  const newGasReserve = toLedgerAmount(Math.max(0, currentGas - platformFeeUsdt));

  await client.query(
    `UPDATE wallet_accounts
        SET gas_reserve = $2,
            version = version + 1,
            updated_at = now()
      WHERE id = $1`,
    [walletResult.rows[0].id, newGasReserve],
  );

  const ledger = await client.query(
    `INSERT INTO wallet_ledger
      (account_id, direction, amount, balance_before, balance_after, entry_type, reference_type, reference_id, description, metadata)
     VALUES ($1, 'DEBIT', $2, $3, $4, 'PROFIT_SHARE_DEDUCTION', $5, $6, $7, $8::jsonb)
     RETURNING id`,
    [
      walletResult.rows[0].id,
      actualDeduction,
      currentGas,
      newGasReserve,
      input.orderId ? 'ORDER' : 'BOT_PAIR',
      input.orderId || input.pair || 'TRADING_PROFIT',
      '20% Platform profit share deduction from Gas Tank',
      JSON.stringify({
        realizedProfitUsdt: input.realizedProfitUsdt,
        platformFeeUsdt,
        actualDeduction,
        uncollectedFeeUsdt: toLedgerAmount(Math.max(0, platformFeeUsdt - actualDeduction)),
        managementUsdt: breakdown.managementUsdt,
        uplineCashUsdt: breakdown.uplineCashUsdt,
        pair: input.pair,
      }),
    ],
  );

  const userRes = await client.query(`SELECT sponsor_user_id FROM users WHERE id = $1`, [input.userId]);
  const sponsorId = userRes.rows[0]?.sponsor_user_id;

  let effectiveUplineCashUsdt = 0;
  let effectiveManagementUsdt = 0;

  if (actualDeduction > EPSILON) {
    if (sponsorId) {
      effectiveUplineCashUsdt = toLedgerAmount(actualDeduction * FINANCIAL_CONFIG.profitShare.uplineCashShareOfPlatformPct / 100);
      effectiveManagementUsdt = toLedgerAmount(actualDeduction - effectiveUplineCashUsdt);
    } else {
      effectiveUplineCashUsdt = 0;
      effectiveManagementUsdt = actualDeduction;
    }
  }

  let uplineCashSettled = 0;
  if (sponsorId && effectiveUplineCashUsdt > EPSILON) {
    const sponsorWallet = await client.query(
      `SELECT id, available_balance, withdrawable_trading_yield FROM wallet_accounts WHERE user_id = $1 AND currency = 'USDT' FOR UPDATE`,
      [sponsorId],
    );
    if (sponsorWallet.rows[0]) {
      const before = Number(sponsorWallet.rows[0].available_balance || 0);
      const after = toLedgerAmount(before + effectiveUplineCashUsdt);
      await client.query(
        `UPDATE wallet_accounts
            SET available_balance = $2,
                withdrawable_trading_yield = withdrawable_trading_yield + $3,
                total_inflow = total_inflow + $3,
                version = version + 1,
                updated_at = now()
          WHERE id = $1`,
        [sponsorWallet.rows[0].id, after, effectiveUplineCashUsdt],
      );

      await client.query(
        `INSERT INTO wallet_ledger
          (account_id, direction, amount, balance_before, balance_after, entry_type, reference_type, reference_id, description, metadata)
         VALUES ($1, 'CREDIT', $2, $3, $4, 'REFERRAL_PROFIT_SHARE', $5, $6, $7, $8::jsonb)`,
        [
          sponsorWallet.rows[0].id,
          effectiveUplineCashUsdt,
          before,
          after,
          ledger.rows[0].id,
          input.orderId || input.pair || 'PROFIT_SHARE',
          '20% referral upline cash share from 20% platform profit share',
          JSON.stringify({
            sourceUserId: input.userId,
            realizedProfitUsdt: input.realizedProfitUsdt,
            platformFeeUsdt,
            actualDeduction,
            uplineCashUsdt: effectiveUplineCashUsdt,
          }),
        ],
      );

      await client.query(
        `INSERT INTO referral_events(sponsor_user_id, source_user_id, event_type, gross_amount, reward_amount, cashable, metadata)
         VALUES($1, $2, 'TRADING_FEE', $3, $4, true, $5)`,
        [
          sponsorId,
          input.userId,
          actualDeduction,
          effectiveUplineCashUsdt,
          JSON.stringify({
            realizedProfitUsdt: input.realizedProfitUsdt,
            orderId: input.orderId,
            pair: input.pair,
            profitShareLedgerId: ledger.rows[0].id,
          }),
        ],
      );
      uplineCashSettled = effectiveUplineCashUsdt;
    }
  }

  if (effectiveManagementUsdt > EPSILON) {
    await client.query(
      `INSERT INTO wallet_ledger
        (account_id, direction, amount, balance_before, balance_after, entry_type, reference_type, reference_id, description, metadata)
       VALUES ($1, 'CREDIT', $2, 0, $2, 'MANAGEMENT_PROFIT_SHARE', $3, $4, $5, $6::jsonb)`,
      [
        walletResult.rows[0].id,
        effectiveManagementUsdt,
        ledger.rows[0].id,
        input.orderId || input.pair || 'PROFIT_SHARE',
        '80% management share from 20% platform profit share',
        JSON.stringify({
          sourceUserId: input.userId,
          realizedProfitUsdt: input.realizedProfitUsdt,
          platformFeeUsdt,
          actualDeduction,
          managementUsdt: effectiveManagementUsdt,
        }),
      ],
    );
  }

  return {
    deducted: actualDeduction,
    newGasReserve,
    managementUsdt: effectiveManagementUsdt,
    uplineCashUsdt: uplineCashSettled,
    ledgerId: ledger.rows[0].id,
  };
}

export async function deductProfitShareFromGasPool(input: {
  userId: number;
  realizedProfitUsdt: number;
  orderId?: string;
  pair?: string;
}) {
  return dbTransaction(async (client) => deductProfitShareFromGasPoolClient(client, input));
}

export async function checkUserGasReserveStatus(firebaseUid: string): Promise<{
  gasReserve: number;
  hasEnoughGas: boolean;
  isWarningZone: boolean;
  isCriticalZone: boolean;
}> {
  const result = await dbQuery<any>(
    `SELECT COALESCE(w.gas_reserve, 0) AS gas_reserve
       FROM wallet_accounts w
       JOIN users u ON u.id = w.user_id
      WHERE u.firebase_uid = $1 AND w.currency = 'USDT'`,
    [firebaseUid],
  );
  const gasReserve = Number(result.rows[0]?.gas_reserve || 0);
  const criticalThreshold = FINANCIAL_CONFIG.gasTankRules.criticalPauseUsdt;
  const warningThreshold = FINANCIAL_CONFIG.gasTankRules.minUsdt;
  return {
    gasReserve,
    hasEnoughGas: gasReserve >= criticalThreshold,
    isWarningZone: gasReserve > criticalThreshold && gasReserve <= warningThreshold,
    isCriticalZone: gasReserve <= criticalThreshold,
  };
}

export async function getProfitShareSummary(firebaseUid: string) {
  const result = await dbQuery<any>(
    `SELECT
       COALESCE(SUM(CASE WHEN event_type='ACTIVATION' AND cashable THEN reward_amount ELSE 0 END),0) AS activation_cash,
       COALESCE(SUM(CASE WHEN (event_type='TRADING_FEE' OR event_type='PROFIT_SHARE') AND cashable THEN reward_amount ELSE 0 END),0) AS trading_fee_cash,
       COALESCE(SUM(CASE WHEN event_type='TOPUP' AND NOT cashable THEN reward_amount ELSE 0 END),0) AS topup_non_cash,
       COALESCE(SUM(CASE WHEN cashable THEN reward_amount ELSE 0 END),0) AS total_cash,
       COUNT(*) AS event_count
       FROM referral_events re
       JOIN users sponsor ON sponsor.id=re.sponsor_user_id
      WHERE sponsor.firebase_uid=$1`,
    [firebaseUid],
  );
  const row = result.rows[0] || {};
  return {
    activationCashUsdt: Number(row.activation_cash || 0),
    tradingFeeCashUsdt: Number(row.trading_fee_cash || 0),
    topupNonCashUsdt: Number(row.topup_non_cash || 0),
    totalCashUsdt: Number(row.total_cash || 0),
    eventCount: Number(row.event_count || 0),
  };
}

export async function getGasAutoRefillConfig(firebaseUid: string) {
  const result = await dbQuery<any>(
    `SELECT g.* FROM gas_auto_refill_configs g JOIN users u ON u.id=g.user_id WHERE u.firebase_uid=$1`,
    [firebaseUid],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    enabled: Boolean(row.enabled), thresholdUsdt: Number(row.threshold_usdt), refillUsdt: Number(row.refill_usdt),
    maxDailyUsdt: Number(row.max_daily_usdt), dailyRefilledUsdt: Number(row.daily_refilled_usdt), lastRefilledAt: row.last_refilled_at ? new Date(row.last_refilled_at).getTime() : null,
  };
}

export async function upsertGasAutoRefillConfig(input: { firebaseUid: string; enabled: boolean; thresholdUsdt: number; refillUsdt: number; maxDailyUsdt: number }) {
  const thresholdUsdt = Number(input.thresholdUsdt);
  const refillUsdt = Number(input.refillUsdt);
  const maxDailyUsdt = Number(input.maxDailyUsdt);
  if (!Number.isFinite(thresholdUsdt) || thresholdUsdt < 1 || thresholdUsdt > 1000) throw Object.assign(new Error('Threshold USDT must be between 1 and 1000.'), { code: 'AUTO_REFILL_THRESHOLD_INVALID' });
  if (!Number.isFinite(refillUsdt) || refillUsdt < 1 || refillUsdt > 5000) throw Object.assign(new Error('Refill USDT must be between 1 and 5000.'), { code: 'AUTO_REFILL_AMOUNT_INVALID' });
  if (!Number.isFinite(maxDailyUsdt) || maxDailyUsdt < refillUsdt || maxDailyUsdt > 10000) throw Object.assign(new Error('Max daily USDT must be between refill amount and 10000.'), { code: 'AUTO_REFILL_MAX_DAILY_INVALID' });

  const user = await getUserByFirebaseUid(input.firebaseUid);
  if (!user) throw Object.assign(new Error('Account not provisioned.'), { code: 'ACCOUNT_NOT_PROVISIONED' });
  await dbQuery(
    `INSERT INTO gas_auto_refill_configs(user_id,enabled,threshold_usdt,refill_usdt,max_daily_usdt)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,threshold_usdt=EXCLUDED.threshold_usdt,refill_usdt=EXCLUDED.refill_usdt,max_daily_usdt=EXCLUDED.max_daily_usdt,updated_at=now()`,
    [user.id, input.enabled, thresholdUsdt, refillUsdt, maxDailyUsdt],
  );
  return getGasAutoRefillConfig(input.firebaseUid);
}

export async function processSingleGasAutoRefill(userId: string) {
  return dbTransaction(async (client) => {
    const configRow = await client.query(
      `SELECT g.*, u.firebase_uid, u.sponsor_user_id 
         FROM gas_auto_refill_configs g 
         JOIN users u ON u.id = g.user_id 
        WHERE g.user_id = $1 AND g.enabled = true 
        FOR UPDATE`,
      [userId]
    );
    if (!configRow.rows[0]) return null;
    const config = configRow.rows[0];

    const wallet = await client.query(
      `SELECT * FROM wallet_accounts WHERE user_id = $1 AND currency = 'USDT' FOR UPDATE`,
      [config.user_id]
    );
    if (!wallet.rows[0]) return null;

    const today = new Date().toISOString().slice(0, 10);
    let daily = String(config.daily_refill_date || '').slice(0, 10) === today ? Number(config.daily_refilled_usdt) : 0;
    if (Number(wallet.rows[0].gas_reserve) >= Number(config.threshold_usdt) || daily >= Number(config.max_daily_usdt)) return null;

    const rawAmount = Math.min(Number(config.refill_usdt), Number(config.max_daily_usdt) - daily, Number(wallet.rows[0].available_balance));
    const amount = toLedgerAmount(rawAmount);
    if (!(amount > 0)) return null;

    const { bonusUsdt } = getGasTopupBonus(amount);
    const sponsorId = config.sponsor_user_id;
    let referralBonusUsdt = 0;
    if (sponsorId) {
      referralBonusUsdt = toLedgerAmount(amount * FINANCIAL_CONFIG.referral.topupGasNonCashPct / 100);
    }

    const before = Number(wallet.rows[0].available_balance);
    const after = toLedgerAmount(before - amount);
    const gas = toLedgerAmount(Number(wallet.rows[0].gas_reserve) + amount + bonusUsdt);
    const newNonCashGas = toLedgerAmount(Number(wallet.rows[0].non_cash_gas_bonus) + bonusUsdt);
    const newDaily = toLedgerAmount(daily + amount);
    const autoIdempotencyKey = `gas-auto-${config.user_id}-${today}-${newDaily}`;

    await client.query(
      `UPDATE wallet_accounts
          SET available_balance=$2,
              total_outflow=total_outflow+$3,
              gas_reserve=$4,
              non_cash_gas_bonus=$5,
              version=version+1,
              updated_at=now()
        WHERE id=$1`,
      [wallet.rows[0].id, after, amount, gas, newNonCashGas],
    );

    const ledger = await client.query(
      `INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,description,idempotency_key,metadata)
       VALUES($1,'DEBIT',$2,$3,$4,'GAS_AUTO_REFILL','Automatic gas reserve refill',$5,$6::jsonb) RETURNING id`,
      [wallet.rows[0].id, amount, before, after, autoIdempotencyKey, JSON.stringify({ thresholdUsdt: Number(config.threshold_usdt), refillUsdt: amount, bonusUsdt, referralBonusUsdt, newGasReserve: gas, promoVersion: FINANCIAL_CONFIG.version })],
    );

    if (sponsorId && referralBonusUsdt > 0) {
      const sponsorWallet = await client.query(
        `SELECT id, gas_reserve, non_cash_gas_bonus FROM wallet_accounts WHERE user_id=$1 AND currency='USDT' FOR UPDATE`,
        [sponsorId],
      );
      if (sponsorWallet.rows[0]) {
        const sponsorGas = toLedgerAmount(Number(sponsorWallet.rows[0].gas_reserve) + referralBonusUsdt);
        const sponsorNonCash = toLedgerAmount(Number(sponsorWallet.rows[0].non_cash_gas_bonus) + referralBonusUsdt);
        await client.query(
          `UPDATE wallet_accounts SET gas_reserve=$2, non_cash_gas_bonus=$3, version=version+1, updated_at=now() WHERE id=$1`,
          [sponsorWallet.rows[0].id, sponsorGas, sponsorNonCash],
        );
        await client.query(
          `INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description,metadata)
           VALUES($1,'CREDIT',$2,$3,$4,'REFERRAL_TOPUP_GAS','GAS_AUTO_REFILL',$5,$6,$7::jsonb)`,
          [sponsorWallet.rows[0].id, referralBonusUsdt, Number(sponsorWallet.rows[0].gas_reserve), sponsorGas, ledger.rows[0].id, '10% non-cash referral gas reward (auto-refill)', JSON.stringify({ sourceUserId: config.user_id, pct: FINANCIAL_CONFIG.referral.topupGasNonCashPct })],
        );
        await client.query(
          `INSERT INTO referral_events(sponsor_user_id,source_user_id,event_type,gross_amount,reward_amount,cashable,metadata)
           VALUES($1,$2,'TOPUP',$3,$4,false,$5)`,
          [sponsorId, config.user_id, amount, referralBonusUsdt, JSON.stringify({ gasTopupLedgerId: ledger.rows[0].id, isAutoRefill: true })],
        );
      }
    }

    await client.query(`UPDATE gas_auto_refill_configs SET daily_refilled_usdt=$2,daily_refill_date=CURRENT_DATE,last_refilled_at=now(),updated_at=now() WHERE user_id=$1`, [config.user_id, newDaily]);
      
    return { firebaseUid: config.firebase_uid, amount, bonusUsdt, referralBonusUsdt, gasReserve: gas, ledgerId: ledger.rows[0].id };
  });
}

export async function processGasAutoRefills() {
  const configs = await dbQuery<{ user_id: string }>(
    `SELECT g.user_id FROM gas_auto_refill_configs g WHERE g.enabled = true`
  );
  const results: any[] = [];
  for (const config of configs.rows) {
    try {
      const res = await processSingleGasAutoRefill(config.user_id);
      if (res) results.push(res);
    } catch (err) {
      console.error(`[GAS_AUTO_REFILL_ERROR] user ${config.user_id}:`, String((err as any)?.message || err));
    }
  }
  return results;
}

export async function settleWithdrawal(input: { withdrawalId: string; txHash: string; claimId:string; verifiedAt?: string; metadata?: Record<string, unknown> }) {
  return dbTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.txHash.toLowerCase()]);
    const reused = await client.query(`SELECT id FROM withdrawals WHERE lower(tx_hash)=lower($1) AND id<>$2 LIMIT 1`, [input.txHash,input.withdrawalId]);
    if (reused.rows[0]) throw Object.assign(new Error('This transaction hash is already assigned to another withdrawal.'),{code:'WITHDRAWAL_TX_HASH_REUSED',statusCode:409});
    const row=await client.query(`SELECT w.*,wa.id AS account_id,wa.locked_balance FROM withdrawals w JOIN wallet_accounts wa ON wa.user_id=w.user_id AND wa.currency=w.currency WHERE w.id=$1 FOR UPDATE`,[input.withdrawalId]);
    if(!row.rows[0]) throw Object.assign(new Error('Withdrawal not found.'),{code:'WITHDRAWAL_NOT_FOUND'});
    const w=row.rows[0];
    if(['CONFIRMED','SENT'].includes(w.status)) {
      if (String(w.tx_hash || '').toLowerCase() !== input.txHash.toLowerCase()) throw Object.assign(new Error('Withdrawal was already settled with a different transaction hash.'),{code:'WITHDRAWAL_SETTLEMENT_CONFLICT',statusCode:409});
      return {replayed:true,status:w.status,txHash:w.tx_hash};
    }
    if(String(w.status)!=='PROCESSING') throw Object.assign(new Error(`Withdrawal cannot be settled from status ${w.status}.`),{code:'WITHDRAWAL_STATE_CONFLICT',statusCode:409});
    if(String(w.screening_status)!=='CLEAR') throw Object.assign(new Error('Withdrawal screening must be CLEAR before settlement.'),{code:'WITHDRAWAL_SCREENING_NOT_CLEAR',statusCode:409});
    if(String(w.processor_claim_id)!==input.claimId||!w.provider_payout_id) throw Object.assign(new Error('A current payout claim and provider submission reference are required.'),{code:'PAYOUT_CLAIM_INVALID',statusCode:409});
    const approvals=await client.query(`SELECT COUNT(DISTINCT admin_uid)::int AS count FROM withdrawal_approvals WHERE withdrawal_id=$1 AND decision='APPROVE'`,[input.withdrawalId]);
    if(Number(approvals.rows[0]?.count||0)<2) throw Object.assign(new Error('Two distinct financial approvals are required before settlement.'),{code:'WITHDRAWAL_DUAL_APPROVAL_REQUIRED',statusCode:409});
    if(Number(w.locked_balance)<Number(w.amount)) throw Object.assign(new Error('Locked withdrawal balance is below the request amount.'),{code:'WITHDRAWAL_LOCK_INVARIANT_FAILED',statusCode:409});
    const locked=Number(w.locked_balance)-Number(w.amount);
    await client.query(`UPDATE wallet_accounts SET locked_balance=$2,version=version+1,updated_at=now() WHERE id=$1`,[w.account_id,locked]);
    await client.query(`UPDATE withdrawals SET status='SENT',tx_hash=$2,processed_at=now(),settlement_verified_at=$3,metadata=metadata || $4::jsonb WHERE id=$1`,[input.withdrawalId,input.txHash,input.verifiedAt || new Date().toISOString(),JSON.stringify(input.metadata || {})]);
    return {replayed:false,status:'SENT',txHash:input.txHash};
  });
}

export async function rejectWithdrawal(withdrawalId: string, reason: string) {
  return dbTransaction(async (client) => {
    const row=await client.query(`SELECT w.*,wa.id AS account_id,wa.available_balance,wa.locked_balance FROM withdrawals w JOIN wallet_accounts wa ON wa.user_id=w.user_id AND wa.currency=w.currency WHERE w.id=$1 FOR UPDATE`,[withdrawalId]);
    if(!row.rows[0]) throw Object.assign(new Error('Withdrawal not found.'),{code:'WITHDRAWAL_NOT_FOUND'});
    const w=row.rows[0]; if(['REJECTED','CANCELLED'].includes(w.status)) return {replayed:true,status:w.status};
    if(String(w.status)!=='REVIEW'||w.processor_claim_id||w.provider_payout_id) throw Object.assign(new Error(`Withdrawal cannot be refunded from status ${w.status} after payout approval or claim.`),{code:'WITHDRAWAL_STATE_CONFLICT',statusCode:409});
    if(Number(w.locked_balance)<Number(w.amount)) throw Object.assign(new Error('Locked withdrawal balance is below the request amount.'),{code:'WITHDRAWAL_LOCK_INVARIANT_FAILED',statusCode:409});
    const available=toLedgerAmount(Number(w.available_balance)+Number(w.amount));
    const locked=toLedgerAmount(Number(w.locked_balance)-Number(w.amount));
    await client.query(`UPDATE wallet_accounts SET available_balance=$2,locked_balance=$3,total_outflow=GREATEST(0,total_outflow-$4),version=version+1,updated_at=now() WHERE id=$1`,[w.account_id,available,locked,w.amount]);
    const reversal = await client.query(`INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description,metadata) VALUES($1,'CREDIT',$2,$3,$4,'WITHDRAWAL_REJECTED_REVERSAL','WITHDRAWAL',$5,$6,$7) RETURNING id`,[w.account_id,w.amount,Number(w.available_balance),available,withdrawalId,`Reversal of withdrawal hold: ${reason.slice(0,400)}`,JSON.stringify({originalEntryType:'WITHDRAWAL_HOLD'})]);
    await client.query(`UPDATE withdrawals SET status='REJECTED',failure_reason=$2,rejection_reversal_ledger_id=$3,processed_at=now() WHERE id=$1`,[withdrawalId,reason.slice(0,500),reversal.rows[0].id]);
    const userRes = await client.query(`SELECT firebase_uid FROM users WHERE id=$1 LIMIT 1`, [w.user_id]);
    if (userRes.rows[0]?.firebase_uid) {
    }
    return {replayed:false,status:'REJECTED',reversalLedgerId:reversal.rows[0].id};
  });
}

export async function getUserLedgerTransactions(input: { firebaseUid: string; limit?: number; offset?: number }): Promise<{ transactions: any[]; total: number; hasMore: boolean }> {
  const limit = Math.min(Math.max(Number(input.limit || 50), 1), 200);
  const offset = Math.max(Number(input.offset || 0), 0);

  return dbTransaction(async (client: any) => {
    const user = await client.query(`SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1`, [input.firebaseUid]);
    if (!user.rows[0]) return { transactions: [], total: 0, hasMore: false };

    const totalRes = await client.query(
      `SELECT COUNT(*)::int as count FROM wallet_ledger l JOIN wallet_accounts wa ON wa.id = l.account_id WHERE wa.user_id = $1 AND l.entry_type <> 'MANAGEMENT_PROFIT_SHARE'`,
      [user.rows[0].id]
    );
    const total = Number(totalRes.rows[0]?.count || 0);

    const rows = await client.query(
      `SELECT l.*, wa.currency, wa.user_id
         FROM wallet_ledger l
         JOIN wallet_accounts wa ON wa.id = l.account_id
        WHERE wa.user_id = $1
          AND l.entry_type <> 'MANAGEMENT_PROFIT_SHARE'
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $2 OFFSET $3`,
      [user.rows[0].id, limit, offset]
    );
    const transactions = rows.rows.map((r: any) => ({ id: r.id, userId: r.user_id, amount: Number(r.amount), currency: r.currency, type: r.entry_type, direction: r.direction, status: 'COMPLETED', createdAt: new Date(r.created_at).getTime(), metadata: r.metadata || {} }));

    return {
      transactions,
      total,
      hasMore: offset + rows.rows.length < total,
    };
  });
}

export async function deleteBotRuntime(firebaseUid: string, externalBotId: string) {
  const user = await getUserByFirebaseUid(firebaseUid);
  if (!user || !externalBotId) return;

  // Guard against deleting bots that still hold an active open position
  // Scoped strictly to the specific bot instance being deleted, NEVER across symbols or other bot instances!
  const activePos = await dbQuery<{ symbol: string; quantity: string }>(
    `SELECT p.symbol, p.quantity FROM positions p
     JOIN bots b ON b.id = p.bot_id
     WHERE b.user_id = $1
       AND (
         b.id::text = $2
         OR b.external_bot_id = $2
         OR b.external_bot_id LIKE $2 || '_%'
       )
       AND COALESCE(p.quantity, 0) > 0.00000001
     LIMIT 1`,
    [user.id, externalBotId]
  );
  if (activePos.rows.length > 0) {
    const err = new Error(`Cannot delete bot "${activePos.rows[0].symbol}" while it holds an active open position (${activePos.rows[0].quantity} coins).`);
    (err as any).code = 'BOT_HAS_ACTIVE_POSITION';
    throw err;
  }

  await dbQuery(
    `UPDATE bots
        SET status='DELETED', updated_at=now()
      WHERE user_id=$1
        AND (
          id::text = $2
          OR external_bot_id = $2
          OR external_bot_id LIKE $2 || '_%'
        )`,
    [user.id, externalBotId]
  );
  await dbQuery(
    `DELETE FROM positions
      WHERE bot_id IN (
        SELECT id FROM bots
         WHERE user_id = $1
           AND (id::text = $2 OR external_bot_id = $2 OR external_bot_id LIKE $2 || '_%')
           AND status = 'DELETED'
      )`,
    [user.id, externalBotId]
  ).catch(() => {});
}

export async function getActiveBotsFromDb() {
  const result = await dbQuery<any>(`
    SELECT 
      b.id,
      COALESCE(b.external_bot_id, b.id::text) as external_bot_id, 
      b.name, 
      b.symbol, 
      b.strategy_type, 
      b.status, 
      b.mode,
      u.firebase_uid,
      ea.exchange,
      ea.sandbox,
      ea.status as exchange_status,
      c.base_order_usd, 
      c.take_profit_pct, 
      c.trailing_tp_pct, 
      c.max_layers, 
      c.step_deviation_pct,
      c.max_capital_usd, 
      c.min_price, 
      c.max_price, 
      c.config,
      COALESCE(p.quantity, 0) as position_qty,
      COALESCE(p.average_entry, 0) as avg_entry_price,
      COALESCE(p.realized_pnl, 0) as realized_pnl_today,
      COALESCE((SELECT COUNT(*) FROM orders o WHERE o.bot_id = b.id), 0) as order_count
    FROM bots b
    JOIN users u ON u.id = b.user_id
    JOIN exchange_accounts ea ON ea.id = b.exchange_account_id
    LEFT JOIN bot_strategy_configs c ON c.bot_id = b.id
    LEFT JOIN positions p ON p.bot_id = b.id AND upper(p.symbol) = upper(b.symbol)
    WHERE b.status IN ('ACTIVE', 'STANDBY', 'ERROR')
  `);
  return result.rows;
}

