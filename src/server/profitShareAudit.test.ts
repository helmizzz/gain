import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINANCIAL_CONFIG, calculateProfitShareBreakdown } from '../config/financialConfig';
import { classifyBotExecutionError } from '../services/botEngineCore';

test('1. Financial Config - 80:20 Profit Sharing Ratios', () => {
  assert.equal(FINANCIAL_CONFIG.profitShare.traderNetProfitPct, 80);
  assert.equal(FINANCIAL_CONFIG.profitShare.platformProfitSharePct, 20);
  assert.equal(FINANCIAL_CONFIG.profitShare.managementShareOfPlatformPct, 80);
  assert.equal(FINANCIAL_CONFIG.profitShare.uplineCashShareOfPlatformPct, 20);

  // $100 Gross Trading Profit Example
  const breakdown100 = calculateProfitShareBreakdown(100);
  assert.equal(breakdown100.traderNetProfitUsdt, 80);
  assert.equal(breakdown100.platformFeeUsdt, 20);
  assert.equal(breakdown100.managementUsdt, 16);
  assert.equal(breakdown100.uplineCashUsdt, 4);

  // Exact Sum Reconciled
  assert.equal(breakdown100.traderNetProfitUsdt + breakdown100.platformFeeUsdt, 100);
  assert.equal(breakdown100.managementUsdt + breakdown100.uplineCashUsdt, breakdown100.platformFeeUsdt);

  // $250.50 Gross Trading Profit Example
  const breakdown250 = calculateProfitShareBreakdown(250.50);
  assert.equal(breakdown250.platformFeeUsdt, 50.10);
  assert.equal(breakdown250.traderNetProfitUsdt, 200.40);
  assert.equal(breakdown250.managementUsdt, 40.08);
  assert.equal(breakdown250.uplineCashUsdt, 10.02);
});

test('2. Error Classification - INSUFFICIENT_GAS_RESERVE is non-retryable', () => {
  const err = { code: 'INSUFFICIENT_GAS_RESERVE', message: 'Gas reserve is below critical threshold of 5 USDT.' };
  const classified = classifyBotExecutionError(err);
  assert.equal(classified.reasonCode, 'INSUFFICIENT_GAS_RESERVE');
  assert.equal(classified.retryable, false);
});

test('3. Mock Client Database Simulation - Profit Share Deduction from Gas Tank', async () => {
  let traderGasReserve = 50.0;
  let sponsorBalance = 100.0;
  let sponsorYield = 0.0;

  const ledgerEntries: any[] = [];
  const referralEvents: any[] = [];

  const mockClient = {
    async query(sql: string, params: any[]) {
      const normalizedSql = sql.trim().toLowerCase();

      if (normalizedSql.includes('select id, gas_reserve from wallet_accounts where user_id = $1')) {
        return { rows: [{ id: 101, gas_reserve: traderGasReserve }] };
      }

      if (normalizedSql.includes('update wallet_accounts') && normalizedSql.includes('gas_reserve = $2')) {
        traderGasReserve = params[1];
        return { rowCount: 1 };
      }

      if (normalizedSql.includes('select sponsor_user_id from users')) {
        return { rows: [{ sponsor_user_id: 202 }] };
      }

      if (normalizedSql.includes('select id, available_balance, withdrawable_trading_yield from wallet_accounts')) {
        return { rows: [{ id: 202, available_balance: sponsorBalance, withdrawable_trading_yield: sponsorYield }] };
      }

      if (normalizedSql.includes('update wallet_accounts') && normalizedSql.includes('withdrawable_trading_yield = withdrawable_trading_yield + $3')) {
        sponsorBalance = params[1];
        sponsorYield += params[2];
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

  // Import dynamic helper or run mock logic matching deductProfitShareFromGasPoolClient
  const { deductProfitShareFromGasPoolClient } = await import('./database');

  const result = await deductProfitShareFromGasPoolClient(mockClient, {
    userId: 101,
    realizedProfitUsdt: 100, // $100 profit
    orderId: 'order-tp-100',
    pair: 'BTC/USDT',
  });

  assert.equal(result.deducted, 20); // 20% platform fee deducted from gas pool
  assert.equal(result.newGasReserve, 30); // 50 - 20 = 30 USDT remaining gas
  assert.equal(result.managementUsdt, 16); // 80% of 20 = 16 USDT management share
  assert.equal(result.uplineCashUsdt, 4); // 20% of 20 = 4 USDT upline cash share

  assert.equal(traderGasReserve, 30);
  assert.equal(sponsorBalance, 104);
  assert.equal(sponsorYield, 4);

  // Check ledger entries: 1 DEBIT (PROFIT_SHARE_DEDUCTION), 1 CREDIT (REFERRAL_PROFIT_SHARE), 1 CREDIT (MANAGEMENT_PROFIT_SHARE)
  assert.equal(ledgerEntries.length, 3);
  assert.equal(ledgerEntries[0].params[4], 'ORDER'); // reference_type
  assert.equal(ledgerEntries[0].params[5], 'order-tp-100'); // reference_id
  assert.equal(ledgerEntries[1].params[5], 'order-tp-100');
  assert.equal(ledgerEntries[2].params[3], 'order-tp-100');

  // Check referral event
  assert.equal(referralEvents.length, 1);
  assert.equal(referralEvents[0].params[2], 20); // Gross platform fee
  assert.equal(referralEvents[0].params[3], 4); // Sponsor reward
});

test('4. Partial Deduction Solvency - Payouts match actual deducted amount when gas reserve is low', async () => {
  let traderGasReserve = 5.0; // Low gas reserve ($5 remaining)
  let sponsorBalance = 100.0;
  let sponsorYield = 0.0;

  const ledgerEntries: any[] = [];
  const referralEvents: any[] = [];

  const mockClient = {
    async query(sql: string, params: any[]) {
      const normalizedSql = sql.trim().toLowerCase();

      if (normalizedSql.includes('select id, gas_reserve from wallet_accounts where user_id = $1')) {
        return { rows: [{ id: 101, gas_reserve: traderGasReserve }] };
      }

      if (normalizedSql.includes('update wallet_accounts') && normalizedSql.includes('gas_reserve = $2')) {
        traderGasReserve = params[1];
        return { rowCount: 1 };
      }

      if (normalizedSql.includes('select sponsor_user_id from users')) {
        return { rows: [{ sponsor_user_id: 202 }] };
      }

      if (normalizedSql.includes('select id, available_balance, withdrawable_trading_yield from wallet_accounts')) {
        return { rows: [{ id: 202, available_balance: sponsorBalance, withdrawable_trading_yield: sponsorYield }] };
      }

      if (normalizedSql.includes('update wallet_accounts') && normalizedSql.includes('withdrawable_trading_yield = withdrawable_trading_yield + $3')) {
        sponsorBalance = params[1];
        sponsorYield += params[2];
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

  const { deductProfitShareFromGasPoolClient } = await import('./database');

  // $100 profit would normally require $20 platform fee, but trader only has $5 gas
  const result = await deductProfitShareFromGasPoolClient(mockClient, {
    userId: 101,
    realizedProfitUsdt: 100,
    orderId: 'order-tp-low-gas',
    pair: 'ETH/USDT',
  });

  assert.equal(result.deducted, 5); // Only $5 actually deducted
  assert.equal(result.newGasReserve, 0); // Remaining gas is 0
  assert.equal(result.managementUsdt, 4); // 80% of $5 = $4 management share
  assert.equal(result.uplineCashUsdt, 1); // 20% of $5 = $1 upline cash share

  // SOLVENCY CHECK: Total credited payouts (management + upline) must EXACTLY match total debited ($5)
  assert.equal(result.managementUsdt + result.uplineCashUsdt, result.deducted);
  assert.equal(sponsorBalance, 101); // 100 + 1 = 101 USDT
  assert.equal(sponsorYield, 1);
});

