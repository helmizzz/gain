export const FINANCIAL_CONFIG = {
  version: 1,
  effectiveFrom: '2026-10-02T00:00:00.000Z',
  profitShare: {
    traderNetProfitPct: 80,
    platformProfitSharePct: 20,
    managementShareOfPlatformPct: 80,
    uplineCashShareOfPlatformPct: 20,
  },
  referral: {
    activationCashPct: 20,
    tradingFeeCashPct: 20,
    topupGasNonCashPct: 10,
  },
  gasTopupPromo: [
    { minUsdt: 500, bonusPct: 35 },
    { minUsdt: 300, bonusPct: 25 },
    { minUsdt: 150, bonusPct: 20 },
    { minUsdt: 50, bonusPct: 10 },
  ],
  gasTankRules: {
    minUsdt: 10,
    toleranceUsdt: 5,
    criticalPauseUsdt: 5,
  },
  withdrawal: {
    network: 'BEP-20',
    feeUsdt: 2,
    minUsdt: 10,
  },
  autoRefill: {
    defaultEnabled: false,
    thresholdUsdt: 3,
    refillUsdt: 10,
    maxDailyUsdt: 50,
  },
} as const;

export function getGasTopupBonus(amount: number): { pct: number; bonusUsdt: number } {
  const tier = FINANCIAL_CONFIG.gasTopupPromo.find((item) => amount >= item.minUsdt);
  if (!tier) return { pct: 0, bonusUsdt: 0 };
  return { pct: tier.bonusPct, bonusUsdt: Number((amount * tier.bonusPct / 100).toFixed(10)) };
}

export function calculateProfitShareBreakdown(grossProfitUsdt: number): {
  traderNetProfitUsdt: number;
  platformFeeUsdt: number;
  managementUsdt: number;
  uplineCashUsdt: number;
} {
  if (!Number.isFinite(grossProfitUsdt) || grossProfitUsdt <= 0) {
    return {
      traderNetProfitUsdt: 0,
      platformFeeUsdt: 0,
      managementUsdt: 0,
      uplineCashUsdt: 0,
    };
  }
  const platformFeeUsdt = Number((grossProfitUsdt * FINANCIAL_CONFIG.profitShare.platformProfitSharePct / 100).toFixed(10));
  const traderNetProfitUsdt = Number((grossProfitUsdt - platformFeeUsdt).toFixed(10));
  const managementUsdt = Number((platformFeeUsdt * FINANCIAL_CONFIG.profitShare.managementShareOfPlatformPct / 100).toFixed(10));
  const uplineCashUsdt = Number((platformFeeUsdt * FINANCIAL_CONFIG.profitShare.uplineCashShareOfPlatformPct / 100).toFixed(10));

  return {
    traderNetProfitUsdt,
    platformFeeUsdt,
    managementUsdt,
    uplineCashUsdt,
  };
}

