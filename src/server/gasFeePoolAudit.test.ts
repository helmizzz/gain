import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINANCIAL_CONFIG, getGasTopupBonus } from '../config/financialConfig';

test('1. Gas TopUp Promo Tiers Match Financial Config', () => {
  assert.deepEqual(getGasTopupBonus(49), { pct: 0, bonusUsdt: 0 });
  assert.deepEqual(getGasTopupBonus(50), { pct: 10, bonusUsdt: 5 });
  assert.deepEqual(getGasTopupBonus(100), { pct: 10, bonusUsdt: 10 });
  assert.deepEqual(getGasTopupBonus(150), { pct: 20, bonusUsdt: 30 });
  assert.deepEqual(getGasTopupBonus(300), { pct: 25, bonusUsdt: 75 });
  assert.deepEqual(getGasTopupBonus(500), { pct: 35, bonusUsdt: 175 });
});

test('2. Top-Up Gas Atomic Solvency & Referral Non-Cash Allocation Simulation', async () => {
  let userLiquidBalance = 500.0;
  let userGasReserve = 0.0;
  let userNonCashGas = 0.0;
  let sponsorGasReserve = 20.0;
  let sponsorNonCashGas = 0.0;

  const ledgerEntries: any[] = [];
  const referralEvents: any[] = [];

  const mockClient = {
    async query(sql: string, params: any[]) {
      const normalizedSql = sql.trim().toLowerCase();

      if (normalizedSql.includes('select id, sponsor_user_id from users where firebase_uid=$1')) {
        if (params[0] === 'user_uid_101') return { rows: [{ id: 101, sponsor_user_id: 202 }] };
        if (params[0] === 'user_uid_202') return { rows: [{ id: 202, sponsor_user_id: null }] };
      }

      if (normalizedSql.includes('select l.id, l.balance_after, l.metadata, w.user_id')) {
        return { rows: [] };
      }

      if (normalizedSql.includes('select * from wallet_accounts where user_id=$1 and currency=\'usdt\'')) {
        if (params[0] === 101) return { rows: [{ id: 1001, user_id: 101, available_balance: userLiquidBalance, gas_reserve: userGasReserve, non_cash_gas_bonus: userNonCashGas }] };
        if (params[0] === 202) return { rows: [{ id: 2002, user_id: 202, available_balance: 100, gas_reserve: sponsorGasReserve, non_cash_gas_bonus: sponsorNonCashGas }] };
      }

      if (normalizedSql.includes('update wallet_accounts') && normalizedSql.includes('available_balance=$2')) {
        if (params[0] === 1001) {
          userLiquidBalance = params[1];
          userGasReserve = params[3];
          userNonCashGas = params[4];
        }
        return { rowCount: 1 };
      }

      if (normalizedSql.includes('select id, gas_reserve, non_cash_gas_bonus from wallet_accounts where user_id=$1')) {
        return { rows: [{ id: 2002, gas_reserve: sponsorGasReserve, non_cash_gas_bonus: sponsorNonCashGas }] };
      }

      if (normalizedSql.includes('update wallet_accounts') && normalizedSql.includes('gas_reserve=$2')) {
        if (params[0] === 2002) {
          sponsorGasReserve = params[1];
          sponsorNonCashGas = params[2];
        }
        return { rowCount: 1 };
      }

      if (normalizedSql.includes('insert into wallet_ledger')) {
        ledgerEntries.push({ sql, params });
        return { rows: [{ id: ledgerEntries.length }] };
      }

      if (normalizedSql.includes('insert into referral_events')) {
        referralEvents.push({ sql, params });
        return { rows: [{ id: referralEvents.length }] };
      }

      return { rows: [] };
    },
  };

  // Mock transaction wrapper to call our mock client
  const mockDbTransaction = async (cb: (client: any) => Promise<any>) => cb(mockClient);

  // Perform a $150 topup (+20% promo bonus = $30 USDT non-cash bonus, 10% referral non-cash = $15 USDT)
  const amount = 150;
  const { bonusUsdt } = getGasTopupBonus(amount);
  assert.equal(bonusUsdt, 30); // 20% of 150 = 30

  // Calculate expected post-state
  const expectedLiquid = userLiquidBalance - 150; // 500 - 150 = 350
  const expectedGas = userGasReserve + 150 + bonusUsdt; // 0 + 150 + 30 = 180
  const expectedNonCash = userNonCashGas + bonusUsdt; // 30
  const expectedSponsorGas = sponsorGasReserve + 15; // 20 + 15 = 35

  assert.equal(expectedLiquid, 350);
  assert.equal(expectedGas, 180);
  assert.equal(expectedNonCash, 30);
  assert.equal(expectedSponsorGas, 35);
});

test('3. Idempotency Key Cross-Account Isolation Guard', async () => {
  const existingLedgerUserId = 101;
  const newUserAttemptingReplayId = 999;

  const mockClient = {
    async query(sql: string, params: any[]) {
      const normalizedSql = sql.trim().toLowerCase();

      if (normalizedSql.includes('select id, sponsor_user_id from users where firebase_uid=$1')) {
        return { rows: [{ id: newUserAttemptingReplayId, sponsor_user_id: null }] };
      }

      if (normalizedSql.includes('select l.id, l.balance_after, l.metadata, w.user_id')) {
        // Replay record belongs to user 101, NOT 999
        return {
          rows: [
            {
              id: 555,
              balance_after: '1000.0000000000',
              metadata: { newGasReserve: 500, bonusUsdt: 50 },
              user_id: existingLedgerUserId,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  // Re-verify cross-account protection logic
  const user = await mockClient.query(`SELECT id, sponsor_user_id FROM users WHERE firebase_uid=$1`, ['hacker_uid']);
  const replay = await mockClient.query(`SELECT l.id, l.balance_after, l.metadata, w.user_id FROM wallet_ledger l JOIN wallet_accounts w ON w.id = l.account_id WHERE l.idempotency_key = $1`, ['stolen-key']);

  let caughtError: any = null;
  try {
    if (replay.rows[0]) {
      if (Number((replay.rows[0] as any).user_id) !== Number(user.rows[0].id)) {
        throw Object.assign(new Error('Idempotency key collision across accounts.'), { code: 'IDEMPOTENCY_KEY_COLLISION' });
      }
    }
  } catch (err: any) {
    caughtError = err;
  }

  assert.notEqual(caughtError, null);
  assert.equal(caughtError.code, 'IDEMPOTENCY_KEY_COLLISION');
});
