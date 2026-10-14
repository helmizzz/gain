import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINANCIAL_CONFIG, getGasTopupBonus, calculateProfitShareBreakdown } from './financialConfig';

test('financial config keeps referral semantics explicit', () => {
  assert.equal(FINANCIAL_CONFIG.profitShare.traderNetProfitPct, 80);
  assert.equal(FINANCIAL_CONFIG.profitShare.platformProfitSharePct, 20);
  assert.equal(FINANCIAL_CONFIG.profitShare.managementShareOfPlatformPct, 80);
  assert.equal(FINANCIAL_CONFIG.profitShare.uplineCashShareOfPlatformPct, 20);
  assert.equal(FINANCIAL_CONFIG.referral.activationCashPct, 20);
  assert.equal(FINANCIAL_CONFIG.referral.tradingFeeCashPct, 20);
  assert.equal(FINANCIAL_CONFIG.referral.topupGasNonCashPct, 10);
});

test('gas topup promo is deterministic', () => {
  assert.deepEqual(getGasTopupBonus(49), { pct: 0, bonusUsdt: 0 });
  assert.deepEqual(getGasTopupBonus(50), { pct: 10, bonusUsdt: 5 });
  assert.deepEqual(getGasTopupBonus(150), { pct: 20, bonusUsdt: 30 });
  assert.deepEqual(getGasTopupBonus(300), { pct: 25, bonusUsdt: 75 });
  assert.deepEqual(getGasTopupBonus(500), { pct: 35, bonusUsdt: 175 });
});

test('calculateProfitShareBreakdown accurately splits 80% net trader, 20% platform (80% mgmt : 20% upline)', () => {
  const result = calculateProfitShareBreakdown(100);
  assert.equal(result.traderNetProfitUsdt, 80);
  assert.equal(result.platformFeeUsdt, 20);
  assert.equal(result.managementUsdt, 16);
  assert.equal(result.uplineCashUsdt, 4);
  assert.equal(result.managementUsdt + result.uplineCashUsdt, result.platformFeeUsdt);
  assert.equal(result.traderNetProfitUsdt + result.platformFeeUsdt, 100);

  const zeroResult = calculateProfitShareBreakdown(0);
  assert.deepEqual(zeroResult, { traderNetProfitUsdt: 0, platformFeeUsdt: 0, managementUsdt: 0, uplineCashUsdt: 0 });
});

