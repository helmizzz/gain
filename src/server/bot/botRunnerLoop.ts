import { randomUUID, randomInt } from 'crypto';
import { performance } from 'perf_hooks';
import { ApiError } from '../shared/apiError';
import { logAuditEvent } from '../shared/observabilityUtils';
import { requireDatabase, requireActiveLicense } from '../shared/authUtils';
import {
  serverState,
  activeBotsRegistry,
  tickerMemoryCache,
  botExecutionMetrics,
} from '../shared/serverState';
import {
  loadBotCredential,
  assertBotCredentialContext,
  createExchangeInstance,
  isFreshPrice,
  tickerCacheKey,
  withExchangeRetry,
  withBotExchangeRetry,
  findBotExchangeOrderByClientOrderId,
  isSupportedExchangeSymbol,
  classifyBotExecutionError,
  getRunnerFailureState,
  BotExecutionFailure,
  EXCHANGE_TIMEOUT_MS,
  BOT_ORDER_RETRY_ATTEMPTS,
  BOT_PRICE_MAX_AGE_MS,
  V2_MARKET_DATA_MAX_AGE_MS,
  BOT_FAILURE_PAUSE_THRESHOLD,
  BOT_RECONCILIATION_INTERVAL_MS,
  GAIN_V2_ENABLED,
  runtimeLiveTradingEnabled,
  MAX_USER_DAILY_LOSS_USDT,
  V2_MAX_COMMITTED_CAPITAL_USDT,
  MAX_BOT_EXPOSURE_USDT,
  sanitizeExchangeInput,
  fetchBinancePublicSpotPrices,
  buildClientOrderId,
  ensureExchangeMarkets,
} from '../shared/exchangeUtils';
import {
  dbQuery,
  getUserByFirebaseUid,
  updateBotRuntimeStatus,
  upsertBotRuntime, deleteBotRuntime, getActiveBotsFromDb,
  getDurableBotPosition,
  createOrderRecord,
  finalizeOrderWithFill,
  releaseOrderExecution,
  createAuditEvent,
  checkUserGasReserveStatus,
} from '../database';
import { MarketDataEngine } from '../../v2/engines/marketData/MarketDataEngine';
import { WebSocketManager } from '../../v2/engines/marketData/WebSocketManager';
import {
  nativeStrategyTimeframe,
  aggregateOhlcv,
  normalizeOhlcvRows,
  selectLastTwoClosedCandles,
  toClosedStrategyCandle,
} from '../../v2/engines/strategy/candleDriven';
import { generateDcaLayers } from '../../v2/engines/strategy/DcaEngine';
import { generateGridLevels, pairGridLevel } from '../../v2/engines/strategy/GridEngine';
import type { DcaLayer, GridLevel } from '../../v2/domain/strategy/types';
import { assessStrategyRisk, assessRegisteredBotRisk } from '../../utils/strategyRiskGuardrails';
import { isStartupAutoResumeEnabled, STARTUP_AUTO_RESUME_CONFIRM } from '../../services/botRecovery';
import { redisAvailable, redisSetNxEx, redisDel, redisGet } from '../redis';

export interface ActiveBotRunner {
  id: string;
  uid: string;
  botId: string;
  mode: 'testnet' | 'live';
  botName?: string;
  pair: string;
  pairedCoins?: string[];
  botMode: 'Avarage Only' | 'Grid Only' | 'Avarage+Grid';
  baseAmount: number;
  baseTp: number;
  useMoneyManagement: boolean;
  averagingLayers: number;
  gridLayers?: number;
  averageDownPct: number;
  uptrendFilter?: boolean;
  uptrendThresholdPct?: number;
  uptrendStatus?: 'Uptrend' | 'Bullish' | 'Sideways' | 'Downtrend';
  tpCallbackPct?: number;
  layerCallbackPct?: number;
  gridTp?: number;
  minPrice?: number;
  maxPrice?: number;
  priceBoundaryStatus?: 'IN_RANGE' | 'ABOVE_MAX' | 'BELOW_MIN';
  stepLayer: number;
  entryPrice: number;
  positionQty: number;
  positionVersion: number;
  closedLayerIds?: string[];
  executedLayers?: Array<{
    id: string;
    orderId: string;
    symbol: string;
    layerNo: number;
    layerType: 'average' | 'grid';
    amount: number;
    costUsdt: number;
    buyPrice: number;
    timestamp: number;
    status: 'filled' | 'closed';
    label: string;
    currentPrice: number;
    estimatedTpPrice: number;
    estimatedTpPct: number;
    estimatedTpUsdt: number;
    floatingPnlUsdt: number;
    floatingPnlPct: number;
    fee: number;
    feeAsset: string;
    date: string;
  }>;
  avgEntryPrice: number;
  realizedPnlToday: number;
  pnlDate: string;
  peakPrice?: number;
  troughPrice?: number;
  lastEvaluatedPrice: number;
  status: 'active' | 'paused' | 'error';
  failureStreak: number;
  priceFailureStreak: number;
  lastErrorReason?: string;
  orderSequence: number;
  lastReconciledAt?: number;
  resumeAfterReconciliation?: boolean;
  pendingOrder?: {
    clientOrderId: string;
    side: 'buy' | 'sell';
    requestedQty: number;
    createdAt: number;
    status: 'submitting' | 'reconciling' | 'unknown' | 'filled';
    filledQty?: number;
    fillPrice?: number;
    orderId?: string;
  };
  exchange: string;
  isSandbox: boolean;
  timeframe: '3m' | '5m' | '10m' | '15m' | '30m' | '1h';
  lastStrategyCandleTimestamp?: number;
  lastStrategySignalPrice?: number;
  dcaLayers?: DcaLayer[];
  gridLevels?: GridLevel[];
  committedCapitalUsd?: number;
  steps?: any[];
}

export interface BotEngineLog {
  id: string;
  uid: string;
  timestamp: number;
  pair: string;
  botId?: string;
  botName?: string;
  action: 'AVERAGING_ORDER' | 'TAKE_PROFIT' | 'MONITOR_TICK' | 'GRID_TP' | 'ORDER_ERROR' | 'RUNNER_ERROR' | 'RECONCILIATION';
  details: string;
  price: number;
  stepLayer: number;
}

export type BotLifecycleReason =
  | 'USER_REQUEST'
  | 'USER_PAUSE_ALL'
  | 'EXCHANGE_DISCONNECTED'
  | 'KILL_SWITCH'
  | 'GLOBAL_LIVE_TRADING_KILL_SWITCH'
  | 'BOT_DELETED'
  | 'RISK_DAILY_LOSS_LIMIT'
  | 'FRESH_PRICE_UNAVAILABLE'
  | 'STARTUP_RECONCILIATION_PENDING'
  | 'ORDER_STATUS_UNCERTAIN'
  | 'EXCHANGE_TRANSIENT_FAILURE'
  | 'EXCHANGE_ORDER_REJECTED'
  | 'EXCHANGE_CREDENTIAL_REPLACED'
  | 'OTHER';

export type PendingOrderResolution =
  | { state: 'filled'; order: any; financialOrderId: string }
  | { state: 'canceled'; order: any; financialOrderId?: string }
  | { state: 'open'; order: any; financialOrderId?: string }
  | { state: 'unknown'; reason: string };

export const userBotOrderTimestamps = new Map<string, number[]>();
export const botEngineLogs: BotEngineLog[] = [];
export const SERVER_INSTANCE_ID = randomUUID();

export const v2MarketDataEngine = new MarketDataEngine();
export const v2WebSocketManager = new WebSocketManager(v2MarketDataEngine);

const BOT_STARTUP_AUTO_RESUME = isStartupAutoResumeEnabled(
  process.env.BOT_STARTUP_AUTO_RESUME,
  process.env.BOT_STARTUP_AUTO_RESUME_CONFIRM,
);

let isEngineRunning = true;
let isCycleRunning = false;
let botWorkerInterval: ReturnType<typeof setInterval> | undefined;

export function botRegistryKey(uid: string, runnerId: string): string {
  return `${uid}:${runnerId}`;
}

export function deriveBotRunnerId(botId: string, symbol: string, isMultiPair: boolean): string {
  if (!isMultiPair) return botId;
  const sanitizedSymbol = symbol.replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
  return `${botId}-${sanitizedSymbol}`;
}

export function botRunnerDocument(uid: string, runnerId: string) {
  return null;
}

export function botLeaseDocument(uid: string, runnerId: string) {
  return null;
}

export function recordBotExecutionMetricsOrder(uid: string) {
  botExecutionMetrics.confirmedOrders += 1;
  const now = Date.now();
  const recentOrders = (userBotOrderTimestamps.get(uid) || []).filter((timestamp) => now - timestamp < 60_000);
  recentOrders.push(now);
  userBotOrderTimestamps.set(uid, recentOrders);
}

export function applyBotRealizedPnl(
  bot: ActiveBotRunner,
  soldQty: number,
  fillPrice: number,
): ActiveBotRunner[] {
  const today = new Date().toISOString().slice(0, 10);
  if (bot.pnlDate !== today) {
    bot.pnlDate = today;
    bot.realizedPnlToday = 0;
  }
  bot.realizedPnlToday += (fillPrice - bot.avgEntryPrice) * soldQty;

  const userDailyPnl = Array.from(activeBotsRegistry.values())
    .filter((candidate) => candidate.uid === bot.uid && candidate.pnlDate === today)
    .reduce((total, candidate) => total + candidate.realizedPnlToday, 0);

  if (userDailyPnl > -MAX_USER_DAILY_LOSS_USDT) {
    return [];
  }

  const pausedBots: ActiveBotRunner[] = [];

  for (const candidate of activeBotsRegistry.values()) {
    if (candidate.uid === bot.uid && candidate.status === 'active') {
      candidate.status = 'paused';
      candidate.lastErrorReason = 'RISK_DAILY_LOSS_LIMIT';
      pausedBots.push(candidate);
    }
  }

  return pausedBots;
}

export async function transitionBotLifecycle(
  bot: ActiveBotRunner,
  nextStatus: ActiveBotRunner['status'],
  reason: BotLifecycleReason,
): Promise<void> {
  if (nextStatus === 'active' && reason === 'USER_REQUEST') {
    const pending = bot.pendingOrder;
    const pendingStatus = String(pending?.status || '').trim().toLowerCase();
    const recoveryReason = String(bot.lastErrorReason || '').trim().toUpperCase();

    const recoveryGateActive =
      Boolean(pending) &&
      ['submitting', 'unknown', 'open', 'new', 'pending', 'partially_filled'].includes(pendingStatus);

    const financialRecoveryBlocked =
      recoveryReason === 'POSITION_LEDGER_MISMATCH' ||
      recoveryReason === 'ORDER_STATUS_UNCERTAIN' ||
      recoveryReason === 'STARTUP_RECONCILIATION_PENDING';

    if (recoveryGateActive || financialRecoveryBlocked) {
      console.warn('[BOT_RECOVERY_RESUME_BLOCKED]', {
        uid: bot.uid,
        runnerId: bot.id,
        botId: bot.botId,
        exchange: bot.exchange,
        pair: bot.pair,
        requestedStatus: nextStatus,
        reason,
        pendingStatus: pendingStatus || null,
        pendingClientOrderId: pending?.clientOrderId || null,
        pendingExchangeOrderId: pending?.orderId || null,
        recoveryReason: recoveryReason || null,
      });

      throw new ApiError(
        409,
        'BOT_RECOVERY_REQUIRED',
        'conflict',
        'Bot cannot be resumed while financial reconciliation is incomplete.',
        'Bot tidak dapat diaktifkan sebelum rekonsiliasi order dan posisi selesai.'
      );
    }
  }

  const previousStatus = bot.status;
  const previousFailureStreak = bot.failureStreak;
  const previousPriceFailureStreak = bot.priceFailureStreak;
  const previousLastErrorReason = bot.lastErrorReason;
  const previousResumeAfterReconciliation = bot.resumeAfterReconciliation;

  const runtimeStatus =
    nextStatus === 'error'
      ? 'ERROR'
      : nextStatus === 'active'
        ? 'ACTIVE'
        : 'STANDBY';

  try {
    await updateBotRuntimeStatus({
      firebaseUid: bot.uid,
      externalBotId: (bot as any).dbId || bot.id,
      exchange: bot.exchange,
      symbol: bot.pair,
      status: runtimeStatus,
    });
  } catch (err: any) {
    if (nextStatus === 'paused' || nextStatus === 'error') {
      console.warn('[BOT_LIFECYCLE_DB_NON_FATAL]', `Could not update runtime status for bot ${bot.id} to ${runtimeStatus}:`, err?.message || err);
    } else {
      throw err;
    }
  }

  bot.status = nextStatus;

  if (nextStatus === 'active') {
    bot.failureStreak = 0;
    bot.priceFailureStreak = 0;
    bot.lastErrorReason = undefined;
    bot.resumeAfterReconciliation = false;
  } else {
    bot.lastErrorReason = reason;
  }

  try {
    await persistBotRunner(bot);
  } catch (error) {
    bot.status = previousStatus;
    bot.failureStreak = previousFailureStreak;
    bot.priceFailureStreak = previousPriceFailureStreak;
    bot.lastErrorReason = previousLastErrorReason;
    bot.resumeAfterReconciliation = previousResumeAfterReconciliation;

    let firestoreRestored = false;
    let postgresRestored = false;
    try {
      await persistBotRunner(bot);
      firestoreRestored = true;
    } catch (restoreError) {
      console.error('[BOT_LIFECYCLE_FIRESTORE_ROLLBACK_FAILED]', {
        uid: bot.uid,
        runnerId: bot.id,
        error: String((restoreError as any)?.message || restoreError),
      });
    }
    try {
      await updateBotRuntimeStatus({
        firebaseUid: bot.uid,
        externalBotId: bot.id,
        exchange: bot.exchange,
        symbol: bot.pair,
        status: previousStatus === 'error' ? 'ERROR' : previousStatus === 'active' ? 'ACTIVE' : 'STANDBY',
      });
      postgresRestored = true;
    } catch (restoreError) {
      console.error('[BOT_LIFECYCLE_POSTGRES_ROLLBACK_FAILED]', {
        uid: bot.uid,
        runnerId: bot.id,
        error: String((restoreError as any)?.message || restoreError),
      });
    }

    if (!firestoreRestored || !postgresRestored) {
      throw new Error('BOT_LIFECYCLE_COMPENSATION_FAILED');
    }
    throw error;
  }

  logBotExecutionEvent(bot, 'bot.lifecycle.transition', {
    previousStatus,
    status: nextStatus,
    reason,
  });
}

export async function persistBotRunner(bot: ActiveBotRunner): Promise<void> {
  try {
    const dbStatus = bot.status === 'active' ? 'ACTIVE' : bot.status === 'error' ? 'ERROR' : 'STANDBY';
    await updateBotRuntimeStatus({
      firebaseUid: bot.uid,
      externalBotId: bot.id,
      exchange: bot.exchange,
      symbol: bot.pair,
      status: dbStatus,
    }).catch(() => {});
  } catch (err) {
    console.error('[PERSIST_BOT_RUNNER_ERROR]', err);
  }
}

export async function deletePersistedBotRunner(uid: string, runnerId: string): Promise<void> {
  try {
    await deleteBotRuntime(uid, runnerId);
  } catch (err: any) {
    if (err?.code === 'BOT_HAS_ACTIVE_POSITION') throw err;
    console.error('[SSOT_DELETE_ERROR]', err);
  }
}

export async function persistBotLog(log: BotEngineLog): Promise<void> {
  botEngineLogs.unshift(log);
  if (botEngineLogs.length > 200) botEngineLogs.pop();
  try {
    await createAuditEvent({
      firebaseUid: log.uid,
      botId: log.botId,
      eventType: `bot.${log.action.toLowerCase()}`,
      correlationId: log.id,
      payload: {
        pair: log.pair,
        botName: log.botName,
        details: log.details,
        price: log.price,
        stepLayer: log.stepLayer,
        timestamp: log.timestamp,
      },
    }).catch(() => {});
  } catch (err) {
    console.error('[PERSIST_BOT_LOG_ERROR]', err);
  }
}

export async function acquireBotLease(bot: ActiveBotRunner): Promise<boolean> {
  const leaseKey = `bot:lease:${bot.uid}:${bot.id}`;
  try {
    if (await redisAvailable()) {
      return await redisSetNxEx(leaseKey, SERVER_INSTANCE_ID, 30);
    }
  } catch {}
  return true;
}

export async function acquireBotLeaseForManualClose(bot: ActiveBotRunner): Promise<boolean> {
  return true;
}

export async function releaseBotLease(bot: ActiveBotRunner): Promise<void> {
  const leaseKey = `bot:lease:${bot.uid}:${bot.id}`;
  try {
    if (await redisAvailable()) {
      const owner = await redisGet(leaseKey);
      if (owner === SERVER_INSTANCE_ID) {
        await redisDel(leaseKey);
      }
    }
  } catch {}
}

export async function assertBotLeaseActive(bot: ActiveBotRunner, allowManualClose = false): Promise<void> {
  if (allowManualClose) return;
  const leaseKey = `bot:lease:${bot.uid}:${bot.id}`;
  try {
    if (await redisAvailable()) {
      const owner = await redisGet(leaseKey);
      if (owner && owner !== SERVER_INSTANCE_ID) {
        throw new BotExecutionFailure('LEASE_LOST', false);
      }
    }
  } catch (err: any) {
    if (err instanceof BotExecutionFailure) throw err;
  }
}

export function logBotExecutionEvent(
  bot: ActiveBotRunner,
  event: string,
  attributes: Record<string, string | number | boolean> = {}
): void {
  console.info(JSON.stringify({
    level: 'info',
    event,
    uid: bot.uid,
    botId: bot.botId,
    runnerId: bot.id,
    correlationId: randomUUID(),
    ...attributes,
  }));
}

export async function recordBotFailure(bot: ActiveBotRunner, error: unknown, action: 'ORDER_ERROR' | 'RUNNER_ERROR' | 'RECONCILIATION' = 'ORDER_ERROR'): Promise<void> {
  const failure = classifyBotExecutionError(error);
  const nextState = getRunnerFailureState(error, bot.failureStreak, BOT_FAILURE_PAUSE_THRESHOLD);
  if (action === 'ORDER_ERROR') botExecutionMetrics.failedOrders += 1;
  console.warn(JSON.stringify({
    level: 'warn',
    event: 'bot.runner.failure',
    uid: bot.uid,
    botId: bot.botId,
    runnerId: bot.id,
    correlationId: randomUUID(),
    reasonCode: failure.reasonCode,
    retryable: failure.retryable,
  }));
  bot.failureStreak = nextState.failureStreak;
  bot.lastErrorReason = nextState.reasonCode;
  if (bot.pendingOrder?.status === 'submitting') {
    bot.pendingOrder = { ...bot.pendingOrder, status: 'unknown' as const };
  }
  const uncertainClientOrderId = bot.pendingOrder?.status === 'unknown' ? bot.pendingOrder.clientOrderId : undefined;
  bot.status = nextState.status;
  botEngineLogs.unshift({
    id: `log-error-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
    uid: bot.uid,
    timestamp: Date.now(),
    pair: bot.pair,
    botId: bot.id,
    botName: bot.botName,
    action,
    details: `Runner failure ${failure.reasonCode}; current status ${bot.status}.`,
    price: bot.lastEvaluatedPrice,
    stepLayer: bot.stepLayer,
  });
  if (botEngineLogs.length > 50) botEngineLogs.pop();
  await persistBotRunner(bot);
  if (uncertainClientOrderId) {
  }

  try {
    await updateBotRuntimeStatus({
      firebaseUid: bot.uid,
      externalBotId: bot.id,
      exchange: bot.exchange,
      symbol: bot.pair,
      status: bot.status === 'error' ? 'ERROR' : bot.status === 'active' ? 'ACTIVE' : 'STANDBY',
    });
  } catch (statusSyncError) {
    console.error('[BOT_RUNTIME_STATUS_SYNC_FAILED]', {
      uid: bot.uid,
      runnerId: bot.id,
      runtimeStatus: bot.status,
      code: (statusSyncError as any)?.code || 'BOT_RUNTIME_STATUS_SYNC_FAILED',
      message: String((statusSyncError as any)?.message || statusSyncError),
    });
  }

  await persistBotLog(botEngineLogs[0]);
}

export async function resolveBotPendingOrder(bot: ActiveBotRunner): Promise<PendingOrderResolution> {
  const pending = bot.pendingOrder;
  if (!pending?.clientOrderId) return { state: 'canceled', order: null };

  const credential = await loadBotCredential(bot.uid, bot.exchange);
  if (!credential) throw new BotExecutionFailure('BOT_CREDENTIALS_MISSING', false);
  assertBotCredentialContext(bot, credential);
  const client = createExchangeInstance(bot.exchange, {
    apiKey: credential.apiKey,
    secret: credential.secret,
    password: credential.password,
    isSandbox: credential.isSandbox,
    binanceSandboxEnv: credential.binanceSandboxEnv,
  });

  await withBotExchangeRetry(() => client.loadMarkets(), EXCHANGE_TIMEOUT_MS, 'exchange_market_load_timeout');

  let financialOrder: any;
  try {
    const result = await dbQuery<any>(
      `SELECT id, status, exchange_order_id, requested_qty, requested_price, side, symbol
         FROM orders
        WHERE client_order_id = $1
        LIMIT 1`,
      [pending.clientOrderId],
    );
    financialOrder = result.rows[0];
  } catch (error) {
    throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
  }

  if (!financialOrder?.id) {
    try {
      const requestedPrice = Number(
        pending.fillPrice
        || bot.lastStrategySignalPrice
        || bot.lastEvaluatedPrice
        || bot.entryPrice
        || bot.avgEntryPrice
        || 0
      );
      const requestedQty = Number(pending.requestedQty || 0);
      const recoveredFinancialOrder = await createOrderRecord({
        firebaseUid: bot.uid,
        botId: bot.id,
        exchange: bot.exchange,
        symbol: bot.pair,
        side: pending.side,
        orderType: 'market',
        clientOrderId: pending.clientOrderId,
        idempotencyKey: pending.clientOrderId,
        requestedQty,
        requestedPrice: requestedPrice > 0 ? requestedPrice : undefined,
        expectedNotional: requestedPrice > 0 && requestedQty > 0 ? requestedQty * requestedPrice : undefined,
        status: 'SUBMITTED',
      });
      financialOrder = {
        id: recoveredFinancialOrder.id,
        status: recoveredFinancialOrder.status,
        exchange_order_id: null,
        requested_qty: requestedQty,
        requested_price: requestedPrice,
        side: pending.side,
        symbol: bot.pair,
      };
    } catch (error) {
      throw new BotExecutionFailure('FINANCIAL_ORDER_RECONSTRUCTION_FAILED', false);
    }
  }

  const candidateOrderId = String(pending.orderId || financialOrder?.exchange_order_id || '').trim();
  let exchangeOrder: any = null;

  if (candidateOrderId) {
    try {
      exchangeOrder = await Promise.race([
        client.fetchOrder(candidateOrderId, bot.pair),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('exchange_order_status_timeout')), EXCHANGE_TIMEOUT_MS)),
      ]);
    } catch (error) {
      const message = String((error as any)?.message || error).toLowerCase();
      if (!/order.*not.*found|unknown order|notfound/.test(message)) {
        throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
      }
    }
  }

  if (!exchangeOrder) {
    const lookup = await findBotExchangeOrderByClientOrderId(client, bot.pair, pending.clientOrderId);
    if (lookup.found) exchangeOrder = lookup.order;
  }

  if (!exchangeOrder && financialOrder?.id) {
    const durableStatus = String(financialOrder.status || '').toLowerCase();
    if (['filled', 'partially_filled'].includes(durableStatus)) {
      try {
        const fillsResult = await dbQuery<any>(
          `SELECT
             COALESCE(SUM(quantity), 0) AS filled_qty,
             COALESCE(SUM(quote_amount), 0) AS quote_amount,
             COALESCE(SUM(COALESCE(fee_amount, 0)), 0) AS fee_amount,
             MAX(exchange_trade_id) AS exchange_trade_id
            FROM fills
           WHERE order_id = $1`,
          [String(financialOrder.id)],
        );
        const durableFill = fillsResult.rows[0] || {};
        const durableQty = Number(durableFill.filled_qty || 0);
        const durableQuote = Number(durableFill.quote_amount || 0);
        const durableAverage = durableQty > 0 ? durableQuote / durableQty : 0;
        if (durableQty > 0 && durableAverage > 0) {
          exchangeOrder = {
            id: String(financialOrder.exchange_order_id || durableFill.exchange_trade_id || pending.orderId || pending.clientOrderId),
            status: durableStatus,
            filled: durableQty,
            average: durableAverage,
            price: durableAverage,
            fee: { cost: Number(durableFill.fee_amount || 0) },
          };
        }
      } catch {
        throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
      }
    } else if (durableStatus === 'canceled') {
      return { state: 'canceled', order: null, financialOrderId: String(financialOrder.id) };
    }
  }

  if (!exchangeOrder) {
    const pendingAgeMs = Date.now() - (Number(pending.createdAt) || 0);
    if (pendingAgeMs > 8000) {
      return {
        state: 'canceled',
        order: null,
        financialOrderId: financialOrder?.id ? String(financialOrder.id) : undefined,
      };
    }
    return { state: 'unknown', reason: 'Exchange has not provided a definitive order record.' };
  }

  const status = String(exchangeOrder.status || '').toLowerCase();
  const filledQty = Number(exchangeOrder.filled || 0);
  const fillPrice = Number(exchangeOrder.average || exchangeOrder.price || 0);
  const terminalCanceled = new Set(['canceled', 'cancelled', 'expired', 'rejected', 'closed_canceled']);
  const terminalFilled = new Set(['closed', 'filled']);

  if (filledQty > 0 && fillPrice > 0 && terminalFilled.has(status)) {
    const financialOrderId = String(financialOrder?.id || '').trim();
    if (!financialOrderId) throw new BotExecutionFailure('FINANCIAL_ORDER_NOT_FOUND', false);
    return { state: 'filled', order: exchangeOrder, financialOrderId };
  }

  if (terminalCanceled.has(status)) {
    return { state: 'canceled', order: exchangeOrder, financialOrderId: financialOrder?.id ? String(financialOrder.id) : undefined };
  }

  if (['open', 'new', 'pending', 'partially_filled'].includes(status)) {
    return { state: 'open', order: exchangeOrder, financialOrderId: financialOrder?.id ? String(financialOrder.id) : undefined };
  }

  return { state: 'unknown', reason: `Exchange returned non-terminal status: ${status || 'empty'}.` };
}

export async function applyResolvedBotOrder(bot: ActiveBotRunner, resolution: PendingOrderResolution): Promise<void> {
  const pending = bot.pendingOrder;
  if (!pending) return;

  if (resolution.state === 'unknown' || resolution.state === 'open') {
    bot.pendingOrder = {
      ...pending,
      status: resolution.state === 'open' ? 'reconciling' : 'unknown',
      orderId: (resolution as any).order?.id ? String((resolution as any).order.id) : pending.orderId,
      filledQty: Number((resolution as any).order?.filled || pending.filledQty || 0) || undefined,
      fillPrice: Number((resolution as any).order?.average || (resolution as any).order?.price || pending.fillPrice || 0) || undefined,
    };
    bot.status = 'paused';
    bot.lastErrorReason = 'ORDER_STATUS_UNCERTAIN';
    bot.resumeAfterReconciliation = false;
    await persistBotRunner(bot);
    throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
  }

  if (resolution.state === 'canceled') {
    if (resolution.financialOrderId) {
      await dbQuery(
        `UPDATE orders SET status = $2, exchange_order_id = COALESCE(exchange_order_id, $3), updated_at = now() WHERE id = $1`,
        [resolution.financialOrderId, 'canceled', resolution.order?.id ? String(resolution.order.id) : null],
      );
      await releaseOrderExecution(resolution.financialOrderId, 'RELEASED').catch(() => {});
    }

    bot.pendingOrder = undefined;
    bot.lastErrorReason = undefined;
    bot.resumeAfterReconciliation = false;
    bot.failureStreak = 0;
    await persistBotRunner(bot);
    return;
  }

  const order = resolution.order;
  const filledQty = Number(order?.filled || order?.amount || order?.info?.accFillSz || order?.info?.fillSz || 0);
  const fillPrice = Number(order?.average || order?.price || order?.info?.fillPx || order?.info?.avgPx || 0);
  if (!resolution.financialOrderId || filledQty <= 0 || fillPrice <= 0) {
    throw new BotExecutionFailure('ORDER_NOT_CONFIRMED_FILLED', false);
  }

  const settledForOrder = await dbQuery<any>(
    `SELECT COALESCE(SUM(quantity),0) AS settled_qty FROM fills WHERE order_id=$1`,
    [resolution.financialOrderId],
  );
  const settledQtyForOrder = Number(settledForOrder.rows[0]?.settled_qty || 0);
  const deltaQtyForOrder = Math.max(0, filledQty - settledQtyForOrder);

  if (String(pending.side || '').toLowerCase() === 'sell' && deltaQtyForOrder > 1e-10) {
    const durablePosition = await getDurableBotPosition(bot.uid, bot.id, bot.pair, bot.exchange, bot.isSandbox);
    const durableQty = Number(durablePosition?.quantity || 0);
    const durableExchange = String(durablePosition?.exchange || '').toLowerCase();

    if (!durablePosition || durableExchange !== String(bot.exchange || '').toLowerCase() || !Number.isFinite(durableQty) || durableQty <= 1e-12 || durableQty + 1e-12 < deltaQtyForOrder) {
      bot.pendingOrder = { ...pending, status: 'unknown', orderId: order?.id ? String(order.id) : pending.orderId };
      bot.status = 'paused';
      bot.lastErrorReason = 'POSITION_LEDGER_MISMATCH';
      bot.resumeAfterReconciliation = false;
      await persistBotRunner(bot);
      return;
    }
  }

  if (settledQtyForOrder + 1e-10 >= filledQty) {
    await releaseOrderExecution(resolution.financialOrderId, 'SETTLED').catch(() => {});
    const durablePosition = await getDurableBotPosition(bot.uid, bot.id, bot.pair, bot.exchange, bot.isSandbox);
    if (durablePosition) {
      bot.positionQty = Number(durablePosition.quantity || 0);
      bot.avgEntryPrice = Number(durablePosition.average_entry || 0);
      bot.realizedPnlToday = Number(durablePosition.realized_pnl || 0);
    }
    bot.pendingOrder = undefined;
    bot.lastErrorReason = undefined;
    bot.resumeAfterReconciliation = false;
    bot.failureStreak = 0;
    await persistBotRunner(bot);
    return;
  }

  const settlement = await finalizeOrderWithFill({
    orderId: resolution.financialOrderId,
    exchangeOrderId: String(order.id),
    quantity: filledQty,
    price: fillPrice,
    quoteAmount: Number((filledQty * fillPrice).toFixed(10)),
    feeAmount: Number(order.fee?.cost || 0),
    feeAsset: order.fee?.currency ? String(order.fee.currency) : undefined,
  });

  await releaseOrderExecution(resolution.financialOrderId, 'SETTLED').catch(() => {});

  try {
    const positionResult = await dbQuery<any>(
      `SELECT p.quantity, p.average_entry, p.realized_pnl
         FROM positions p
         JOIN bots b ON b.id = p.bot_id
         JOIN exchange_accounts ea ON ea.id = b.exchange_account_id
        WHERE b.external_bot_id = $1 AND b.symbol = $2 AND lower(ea.exchange) = lower($3) AND ea.sandbox = $4
        LIMIT 1`,
      [bot.id, bot.pair, bot.exchange, bot.isSandbox],
    );
    const durablePosition = positionResult.rows[0];
    if (durablePosition) {
      bot.positionQty = Number(durablePosition.quantity || 0);
      bot.avgEntryPrice = Number(durablePosition.average_entry || 0);
      bot.realizedPnlToday = Number(durablePosition.realized_pnl || 0);
    }
  } catch {
    throw new BotExecutionFailure('POSITION_RECONCILIATION_FAILED', false);
  }

  bot.positionVersion = Number((bot as any).positionVersion || 0) + (settlement.replayed ? 0 : 1);
  if (pending.side === 'buy') {
    bot.stepLayer = Math.max(Number(bot.stepLayer || 1), Number(bot.stepLayer || 1) + (settlement.replayed ? 0 : 1));
  } else if (bot.positionQty <= 1e-12) {
    bot.positionQty = 0;
    bot.avgEntryPrice = 0;
    bot.stepLayer = 1;
    bot.entryPrice = fillPrice;
  }



  bot.pendingOrder = undefined;
  bot.lastErrorReason = undefined;
  bot.resumeAfterReconciliation = false;
  bot.failureStreak = 0;
  await persistBotRunner(bot);
}

export async function getExchangeFreeBalance(client: any, coin: string): Promise<number> {
  const targetCoin = coin.trim().toUpperCase();
  try {
    const balance = await Promise.race([
      client.fetchBalance(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('balance_timeout')), 5000)),
    ]);
    if (balance && typeof balance === 'object' && balance.free) {
      const free = Number(balance.free[targetCoin] ?? 0);
      if (Number.isFinite(free) && free >= 0) return free;
    }
  } catch (err: any) {
    if (client?.id === 'okx' && typeof client?.privateGetAccountBalance === 'function') {
      try {
        const raw = await Promise.race([
          client.privateGetAccountBalance(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('balance_timeout')), 5000)),
        ]);
        const details = raw?.data?.[0]?.details || [];
        const item = details.find((d: any) => String(d?.ccy || '').toUpperCase() === targetCoin);
        if (item) {
          const avail = Number(item.availBal ?? item.cashBal ?? item.eq ?? 0);
          if (Number.isFinite(avail) && avail >= 0) return avail;
        } else if (raw?.data?.[0]) {
          return 0;
        }
      } catch {}
    }
  }
  return -1;
}

export async function executeBotMarketOrder(
  bot: ActiveBotRunner,
  side: 'buy' | 'sell',
  requestedQty: number,
  referencePrice: number,
  priceTimestamp: number,
  allowManualClose = false,
): Promise<{ filledQty: number; fillPrice: number; orderId: string }> {
  if (bot.mode === 'live' && !runtimeLiveTradingEnabled) throw new BotExecutionFailure('LIVE_TRADING_DISABLED', false);

  const credential = await loadBotCredential(bot.uid, bot.exchange);
  if (!credential) throw new BotExecutionFailure('BOT_CREDENTIALS_MISSING', false);
  assertBotCredentialContext(bot, credential);

  const client = createExchangeInstance(bot.exchange, {
    apiKey: credential.apiKey,
    secret: credential.secret,
    password: credential.password,
    isSandbox: credential.isSandbox,
    binanceSandboxEnv: credential.binanceSandboxEnv,
  });

  let effectiveQty = requestedQty;
  if (side === 'sell') {
    const baseCoin = bot.pair.split('/')[0].toUpperCase();
    const free = await getExchangeFreeBalance(client, baseCoin);
    if (free >= 0) {
      if (free <= 1e-8 || (referencePrice > 0 && free * referencePrice < 0.2)) {
        console.log(`[BOT_EXEC_ZERO_BALANCE] ${bot.pair} exchange available balance is ${free}. Resetting position.`);
        bot.pendingOrder = undefined;
        bot.positionQty = 0;
        bot.avgEntryPrice = 0;
        bot.stepLayer = 0;
        bot.executedLayers = [];
        await dbQuery(
          `UPDATE positions SET quantity = 0, average_entry = 0, reserved_quantity = 0, updated_at = now()
           WHERE bot_id = (SELECT id FROM bots WHERE external_bot_id = $1 LIMIT 1) AND symbol = $2`,
          [bot.id, bot.pair],
        ).catch(() => {});
        await persistBotRunner(bot).catch(() => {});
        return { filledQty: 0, fillPrice: referencePrice, orderId: `exhausted-${Date.now()}` };
      }
      if (effectiveQty > free) {
        console.log(`[BOT_EXEC_CLAMP] Clamping sell quantity for ${bot.pair} from ${effectiveQty} to exchange free balance ${free}`);
        effectiveQty = free;
      }
    }
  }

  const riskQty = effectiveQty;
  validateBotOrderRisk(bot, side, riskQty, referencePrice);

  let nextSequence = Math.max((Number(bot.orderSequence) || 0) + 1, 1);
  let clientOrderId = buildClientOrderId(
    bot.uid,
    bot.botId,
    bot.id,
    side,
    nextSequence,
    bot.exchange,
    bot.isSandbox,
  );

  // Guarantee that this new market order gets a fresh, unused client_order_id in orders
  try {
    let existingCheck = await dbQuery<any>(
      `SELECT id FROM orders WHERE client_order_id = $1 OR idempotency_key = $1 LIMIT 1`,
      [clientOrderId],
    );
    while (existingCheck.rows.length > 0) {
      nextSequence += 1;
      clientOrderId = buildClientOrderId(
        bot.uid,
        bot.botId,
        bot.id,
        side,
        nextSequence,
        bot.exchange,
        bot.isSandbox,
      );
      existingCheck = await dbQuery<any>(
        `SELECT id FROM orders WHERE client_order_id = $1 OR idempotency_key = $1 LIMIT 1`,
        [clientOrderId],
      );
    }
  } catch {}

  bot.orderSequence = nextSequence;

  bot.pendingOrder = {
    clientOrderId,
    side,
    requestedQty: effectiveQty,
    createdAt: Date.now(),
    status: 'submitting',
  };
  await persistBotRunner(bot);

  let financialOrder;
  try {
    financialOrder = await createOrderRecord({
      firebaseUid: bot.uid,
      botId: bot.id,
      exchange: bot.exchange,
      symbol: bot.pair,
      side,
      orderType: 'market',
      clientOrderId,
      idempotencyKey: clientOrderId,
      requestedQty: effectiveQty,
      requestedPrice: referencePrice > 0 ? referencePrice : undefined,
      expectedNotional: referencePrice > 0 && effectiveQty > 0 ? effectiveQty * referencePrice : undefined,
      status: 'SUBMITTED',
    });
  } catch (error) {
    bot.pendingOrder = undefined;
    await persistBotRunner(bot).catch(() => {});
    throw error;
  }

  if (financialOrder?.replayed) {
    // If order was already replayed from a previous run, do not execute a new order on exchange to avoid EXCHANGE_ORDER_ID_MISMATCH
    bot.pendingOrder = undefined;
    await persistBotRunner(bot).catch(() => {});
    return { filledQty: 0, fillPrice: referencePrice, orderId: financialOrder.id };
  }

  let exchangeOrder: any;
  try {
    exchangeOrder = await createBotExchangeOrderWithRecovery(
      client,
      bot,
      side,
      effectiveQty,
      clientOrderId,
      priceTimestamp,
      allowManualClose,
      referencePrice,
    );
  } catch (error) {
    const failure = classifyBotExecutionError(error);
    if (failure.reasonCode === 'POSITION_EXHAUSTED_ON_EXCHANGE') {
      bot.pendingOrder = undefined;
      bot.positionQty = 0;
      bot.avgEntryPrice = 0;
      bot.stepLayer = 0;
      bot.executedLayers = [];
      await persistBotRunner(bot).catch(() => {});
      if (financialOrder?.id) {
        await releaseOrderExecution(financialOrder.id, 'SETTLED').catch(() => {});
        await dbQuery(
          `UPDATE orders SET status = $2, rejection_reason = $3, updated_at = now() WHERE id = $1`,
          [financialOrder.id, 'CANCELLED', 'POSITION_EXHAUSTED_ON_EXCHANGE'],
        ).catch(() => {});
      }
      await dbQuery(
        `UPDATE positions SET quantity = 0, average_entry = 0, reserved_quantity = 0, updated_at = now()
         WHERE bot_id = (SELECT id FROM bots WHERE external_bot_id = $1 LIMIT 1) AND symbol = $2`,
        [bot.id, bot.pair],
      ).catch(() => {});
      return { filledQty: 0, fillPrice: referencePrice, orderId: `exhausted-${Date.now()}` };
    }
    if (!failure.retryable && failure.reasonCode !== 'ORDER_STATUS_UNCERTAIN') {
      bot.pendingOrder = undefined;
      await persistBotRunner(bot).catch(() => {});
      if (financialOrder?.id) {
        await dbQuery(
          `UPDATE orders SET status = $2, rejection_reason = $3, updated_at = now() WHERE id = $1`,
          [financialOrder.id, 'REJECTED', failure.reasonCode],
        ).catch(() => {});
      }
    }
    throw error;
  }

  const filledQty = Number(exchangeOrder.filled || effectiveQty);
  const fillPrice = Number(exchangeOrder.average || exchangeOrder.price || referencePrice);
  const rawOrderId = String(exchangeOrder.id || clientOrderId).trim();

  if (!(filledQty > 0 && fillPrice > 0)) {
    throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
  }

  await applyResolvedBotOrder(bot, {
    state: 'filled',
    order: exchangeOrder,
    financialOrderId: financialOrder.id,
  });

  recordBotExecutionMetricsOrder(bot.uid);

  return { filledQty, fillPrice, orderId: rawOrderId };
}

export async function createBotExchangeOrderWithRecovery(
  client: any,
  bot: ActiveBotRunner,
  side: 'buy' | 'sell',
  amount: number,
  clientOrderId: string,
  priceTimestamp: number,
  allowManualClose = false,
  referencePrice?: number,
): Promise<any> {
  try {
    await ensureExchangeMarkets(client);
  } catch {}

  let orderAmount = amount;
  if (side === 'sell') {
    const baseCoin = bot.pair.split('/')[0].toUpperCase();
    const free = await getExchangeFreeBalance(client, baseCoin);
    if (free >= 0) {
      if (free <= 1e-8 || (referencePrice && referencePrice > 0 && free * referencePrice < 0.2)) {
        throw new BotExecutionFailure('POSITION_EXHAUSTED_ON_EXCHANGE', false);
      }
      if (orderAmount > free) {
        orderAmount = free;
      }
    }
    try {
      if (client?.markets?.[bot.pair] && typeof client?.amountToPrecision === 'function') {
        const formatted = client.amountToPrecision(bot.pair, orderAmount);
        if (formatted && Number(formatted) > 0) {
          orderAmount = Number(formatted);
          if (free >= 0 && orderAmount > free) {
            const prec = client.markets[bot.pair]?.precision?.amount;
            if (typeof prec === 'number') {
              const factor = Math.pow(10, prec);
              orderAmount = Math.floor(free * factor) / factor;
            } else {
              orderAmount = free;
            }
          }
        }
      }
    } catch {}
  } else {
    try {
      if (client?.markets?.[bot.pair] && typeof client?.amountToPrecision === 'function') {
        const formatted = client.amountToPrecision(bot.pair, orderAmount);
        if (formatted && Number(formatted) > 0) {
          orderAmount = Number(formatted);
        }
      }
    } catch {}
  }

  const orderPrice = (side === 'buy' && ['indodax', 'bitget', 'bybit', 'okx'].includes(String(client?.id).toLowerCase()))
    ? (referencePrice && referencePrice > 0 ? referencePrice : undefined)
    : undefined;

  for (let attempt = 1; attempt <= BOT_ORDER_RETRY_ATTEMPTS; attempt += 1) {
    try {
      if (side === 'buy' && bot.mode !== 'testnet') {
        const gasStatus = await checkUserGasReserveStatus(bot.uid).catch(() => ({ hasEnoughGas: true }));
        if (!gasStatus.hasEnoughGas) {
          throw new BotExecutionFailure('INSUFFICIENT_GAS_RESERVE', false);
        }
      }
      await assertBotLeaseActive(bot, allowManualClose);

      return await Promise.race([
        client.createOrder(bot.pair, 'market', side, orderAmount, orderPrice, { clientOrderId }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('exchange_order_timeout')), EXCHANGE_TIMEOUT_MS)),
      ]);
    } catch (error) {
      const failure = classifyBotExecutionError(error);
      if (side === 'sell' && failure.reasonCode === 'INSUFFICIENT_BALANCE') {
        const baseCoin = bot.pair.split('/')[0].toUpperCase();
        const freeNow = await getExchangeFreeBalance(client, baseCoin);
        if (freeNow > 0 && freeNow < orderAmount) {
          let retryAmount = freeNow;
          try {
            if (client?.markets?.[bot.pair] && typeof client?.amountToPrecision === 'function') {
              const formatted = client.amountToPrecision(bot.pair, retryAmount);
              if (formatted && Number(formatted) > 0) retryAmount = Number(formatted);
              if (retryAmount > freeNow) {
                const prec = client.markets[bot.pair]?.precision?.amount;
                if (typeof prec === 'number') {
                  const factor = Math.pow(10, prec);
                  retryAmount = Math.floor(freeNow * factor) / factor;
                }
              }
            }
          } catch {}
          if (retryAmount > 0 && (!referencePrice || retryAmount * referencePrice >= 0.5)) {
            console.log(`[BOT_SELL_RETRY_ADJUSTED] Retrying sell order with actual available exchange balance: ${retryAmount} ${baseCoin}`);
            try {
              return await Promise.race([
                client.createOrder(bot.pair, 'market', side, retryAmount, orderPrice, { clientOrderId: `${clientOrderId.slice(0, 30)}r` }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('exchange_order_timeout')), EXCHANGE_TIMEOUT_MS)),
              ]);
            } catch (retryErr) {
              const retryFailure = classifyBotExecutionError(retryErr);
              if (retryFailure.reasonCode === 'INSUFFICIENT_BALANCE') {
                throw new BotExecutionFailure('POSITION_EXHAUSTED_ON_EXCHANGE', false);
              }
              throw retryFailure;
            }
          }
        }
        if (freeNow === 0 || (referencePrice && freeNow * referencePrice < 0.5)) {
          throw new BotExecutionFailure('POSITION_EXHAUSTED_ON_EXCHANGE', false);
        }
      }
      if (failure.reasonCode === 'FRESH_PRICE_UNAVAILABLE') {
        if (attempt >= BOT_ORDER_RETRY_ATTEMPTS) throw failure;
        await new Promise((resolve) => setTimeout(resolve, 400 * (2 ** (attempt - 1))));
        continue;
      }
      if (!failure.retryable || attempt >= BOT_ORDER_RETRY_ATTEMPTS) throw failure;

      const recovered = await findBotExchangeOrderByClientOrderId(client, bot.pair, clientOrderId);
      if (recovered.found) return recovered.order;

      // Fail-closed under Architecture 4.2: do not auto-resend order on timeout/network error
      throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
    }
  }

  throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
}

export async function getPrice(exchange: string, symbol: string, isSandbox = false) {
  const cacheKey = tickerCacheKey(exchange, symbol, isSandbox);
  if (GAIN_V2_ENABLED) {
    const streamSnapshot = v2MarketDataEngine.get(exchange.trim().toLowerCase(), symbol.trim().toUpperCase());
    if (streamSnapshot && isFreshPrice(streamSnapshot.timestamp, Date.now(), V2_MARKET_DATA_MAX_AGE_MS)) {
      const streamed = { last: streamSnapshot.last, percentage: streamSnapshot.volatilityPct || 0, timestamp: streamSnapshot.timestamp, source: exchange.trim().toLowerCase(), quoteCurrency: symbol.split('/')[1]?.toUpperCase() };
      tickerMemoryCache.set(cacheKey, streamed);
      return streamed;
    }
  }
  const cached = tickerMemoryCache.get(cacheKey);
  if (cached && isFreshPrice(cached.timestamp, Date.now(), BOT_PRICE_MAX_AGE_MS) && Number.isFinite(cached.last) && cached.last > 0) {
    return cached;
  }

  const normalizedExchange = exchange.trim().toLowerCase();
  const client = createExchangeInstance(normalizedExchange, { isSandbox });
  const startedAt = performance.now();
  botExecutionMetrics.tickerRequests += 1;
  let ticker: any;
  try {
    ticker = await Promise.race([
      client.fetchTicker(symbol),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ticker_timeout')), EXCHANGE_TIMEOUT_MS)),
    ]);
  } catch (error) {
    // If sandbox/testnet market ticker fails (e.g. altcoins like ZEC not listed on testnet endpoints), fallback to live public market ticker
    if (isSandbox) {
      try {
        const liveClient = createExchangeInstance(normalizedExchange, { isSandbox: false });
        ticker = await Promise.race([
          liveClient.fetchTicker(symbol),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ticker_timeout')), EXCHANGE_TIMEOUT_MS)),
        ]);
      } catch (fallbackError) {
        try {
          const publicTickers = await fetchBinancePublicSpotPrices([symbol], isSandbox);
          const pub = publicTickers[symbol];
          if (pub && Number(pub.last) > 0) {
            ticker = pub;
          } else {
            botExecutionMetrics.tickerFailures += 1;
            throw error;
          }
        } catch {
          botExecutionMetrics.tickerFailures += 1;
          throw error;
        }
      }
    } else {
      try {
        const publicTickers = await fetchBinancePublicSpotPrices([symbol], false);
        const pub = publicTickers[symbol];
        if (pub && Number(pub.last) > 0) {
          ticker = pub;
        } else {
          botExecutionMetrics.tickerFailures += 1;
          throw error;
        }
      } catch {
        botExecutionMetrics.tickerFailures += 1;
        throw error;
      }
    }
  } finally {
    botExecutionMetrics.tickerTotalLatencyMs += performance.now() - startedAt;
  }
  const last = Number(ticker?.last ?? ticker?.close ?? 0);
  if (!Number.isFinite(last) || last <= 0) {
    botExecutionMetrics.tickerFailures += 1;
    throw new Error('ticker_unavailable');
  }

  const price = {
    last,
    percentage: Number(ticker?.percentage) || 0,
    timestamp: Date.now(),
    source: normalizedExchange,
    quoteCurrency: symbol.split('/')[1]?.toUpperCase(),
  };
  tickerMemoryCache.set(cacheKey, price);
  return price;
}

const strategyCandleCache = new Map<string, { fetchedAt: number; snapshot: any }>();
const STRATEGY_CANDLE_POLL_MS = 10_000;

export async function getClosedCandleMarketSnapshot(bot: ActiveBotRunner): Promise<{
  market: any;
  candle: ReturnType<typeof toClosedStrategyCandle>;
  previousCandleClose: number;
}> {
  const timeframe = bot.timeframe || '5m';
  const cacheKey = `${bot.exchange.toLowerCase()}:${bot.isSandbox ? 'sandbox' : 'live'}:${bot.pair}:${timeframe}`;
  const cached = strategyCandleCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < STRATEGY_CANDLE_POLL_MS) return cached.snapshot;

  const nativeTimeframe = nativeStrategyTimeframe(timeframe);
  const client = createExchangeInstance(bot.exchange, { isSandbox: bot.isSandbox });
  if (!client.has?.fetchOHLCV) throw new BotExecutionFailure('CANDLE_DATA_UNAVAILABLE', true);
  
  let rowsRaw: unknown[];
  try {
    rowsRaw = await withExchangeRetry(bot.exchange.toLowerCase(), 'fetchOHLCV', () => client.fetchOHLCV(bot.pair, nativeTimeframe, undefined, 120));
  } catch (err) {
    if (bot.isSandbox) {
      const liveClient = createExchangeInstance(bot.exchange, { isSandbox: false });
      rowsRaw = await withExchangeRetry(bot.exchange.toLowerCase(), 'fetchOHLCV_fallback', () => liveClient.fetchOHLCV(bot.pair, nativeTimeframe, undefined, 120));
    } else if (bot.exchange.toLowerCase() === 'indodax' && (nativeTimeframe === '5m' || nativeTimeframe === '3m')) {
      try {
        rowsRaw = await withExchangeRetry(bot.exchange.toLowerCase(), 'fetchOHLCV_indodax_fallback', () => client.fetchOHLCV(bot.pair, '15m', undefined, 120));
      } catch {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const rows = aggregateOhlcv(normalizeOhlcvRows(rowsRaw as unknown[]), timeframe);
  if (rows.length < 3) throw new BotExecutionFailure('CANDLE_DATA_INSUFFICIENT', true);

  const selected = selectLastTwoClosedCandles(rows, timeframe, now);
  if (!selected) throw new BotExecutionFailure('CANDLE_NOT_CLOSED', true);
  const [previous, current] = selected;
  const candle = toClosedStrategyCandle(current, timeframe);
  const candlePct = candle.open > 0 ? ((candle.close - candle.open) / candle.open) * 100 : 0;
  const market = {
    exchange: bot.exchange, symbol: bot.pair, bid: candle.close, ask: candle.close, last: candle.close,
    timestamp: now, spreadPct: 0, volatilityPct: Math.abs(candlePct), timeframe, candle, previousCandleClose: previous[4],
  };
  const snapshot = { market, candle, previousCandleClose: previous[4] };
  strategyCandleCache.set(cacheKey, { fetchedAt: now, snapshot });
  return snapshot;
}

export async function reconcilePendingBotOrderOnStartup(bot: ActiveBotRunner): Promise<void> {
  if (!bot.pendingOrder) return;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const resolution = await resolveBotPendingOrder(bot);
    if (resolution.state === 'open') {
      const orderId = String(resolution.order?.id || bot.pendingOrder?.orderId || '').trim();
      if (!orderId) throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);

      const credential = await loadBotCredential(bot.uid, bot.exchange);
      if (!credential) throw new BotExecutionFailure('BOT_CREDENTIALS_MISSING', false);
      const client = createExchangeInstance(bot.exchange, {
        apiKey: credential.apiKey, secret: credential.secret, password: credential.password, isSandbox: credential.isSandbox,
        binanceSandboxEnv: credential.binanceSandboxEnv,
      });

      if (typeof client.cancelOrder === 'function') {
        try {
          await withBotExchangeRetry(() => client.cancelOrder(orderId, bot.pair), EXCHANGE_TIMEOUT_MS, 'startup_pending_order_cancel_timeout');
        } catch {
          throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
        }
      } else {
        throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
      const afterCancel = await resolveBotPendingOrder(bot);
      if (afterCancel.state === 'open') {
        if (attempt < 3) continue;
        throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
      }
      await applyResolvedBotOrder(bot, afterCancel);
      return;
    }

    if (resolution.state === 'unknown') {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        continue;
      }
      throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
    }

    await applyResolvedBotOrder(bot, resolution);
    return;
  }
  throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
}

export async function reconcileLiveBotPosition(bot: ActiveBotRunner): Promise<void> {
  if (bot.pendingOrder) {
    await reconcilePendingBotOrderOnStartup(bot);
    if (bot.pendingOrder) return;
  }
  const durablePosition = await getDurableBotPosition(bot.uid, bot.id, bot.pair, bot.exchange, bot.isSandbox);
  if (durablePosition) {
    bot.positionQty = Number(durablePosition.quantity || 0);
    bot.avgEntryPrice = Number(durablePosition.average_entry || 0);
    bot.realizedPnlToday = Number(durablePosition.realized_pnl || 0);
  }
  bot.lastReconciledAt = Date.now();
  await persistBotRunner(bot);
}

export function validateBotOrderRisk(bot: ActiveBotRunner, side: 'buy' | 'sell', quantity: number, price: number): void {
  const notionalUsd = quantity * price;
  if (side === 'buy') {
    const activeRisk = assessRegisteredBotRisk({
      strategy: bot.botMode, averagingLayers: bot.averagingLayers, gridLayers: bot.gridLayers,
      baseAmount: bot.baseAmount, baseTp: bot.baseTp, averageDownPct: bot.averageDownPct,
      gridProfitPct: bot.gridTp, tpCallbackPct: bot.tpCallbackPct, layerCallbackPct: bot.layerCallbackPct,
      pairedCoinsCount: bot.pairedCoins?.length || 1, currentUserExposureUsdt: notionalUsd,
      useMoneyManagement: false, // Bypass full balance check at runtime
    });
    if (activeRisk.status === 'BLOCKED') {
      throw new BotExecutionFailure(activeRisk.blockers[0]?.code || 'RISK_GUARDRAIL_VIOLATION', false);
    }
  }
}

export function getBotsInRiskState(
  uid: string,
  userBots: ActiveBotRunner[],
): ActiveBotRunner[] {
  const userOrderTimestamps = userBotOrderTimestamps.get(uid) || [];
  const now = Date.now();
  const recentOrdersCount = userOrderTimestamps.filter((t) => now - t < 60_000).length;

  if (recentOrdersCount >= 20) return userBots;

  const pausedBots: ActiveBotRunner[] = [];
  for (const bot of userBots) {
    if (bot.status !== 'active') continue;
    if (bot.failureStreak >= BOT_FAILURE_PAUSE_THRESHOLD || bot.priceFailureStreak >= BOT_FAILURE_PAUSE_THRESHOLD) {
      pausedBots.push(bot);
    }
  }
  return pausedBots;
}

export async function cancelBotOpenOrders(uid: string, bots: ActiveBotRunner[]): Promise<{ cancelled: number; failures: number }> {
  const targets = new Map<string, ActiveBotRunner[]>();
  for (const bot of bots) {
    if (bot.mode !== 'testnet' && bot.mode !== 'live') continue;
    const key = `${bot.exchange}:${bot.pair}`;
    targets.set(key, [...(targets.get(key) || []), bot]);
  }

  let cancelled = 0;
  let failures = 0;
  for (const groupedBots of targets.values()) {
    const [firstBot] = groupedBots;
    const pendingClientOrderIds = new Set(groupedBots
      .map((bot) => bot.pendingOrder?.status && bot.pendingOrder.status !== 'filled' ? bot.pendingOrder.clientOrderId : '')
      .filter(Boolean));
    if (pendingClientOrderIds.size === 0) {
      continue;
    }
    try {
      const credential = await loadBotCredential(uid, firstBot.exchange);
      if (!credential) {
        failures += 1;
        continue;
      }
      const client = createExchangeInstance(firstBot.exchange, {
        apiKey: credential.apiKey,
        secret: credential.secret,
        password: credential.password,
        isSandbox: credential.isSandbox,
        binanceSandboxEnv: credential.binanceSandboxEnv,
      });
      const openOrders = await withTimeout(client.fetchOpenOrders(firstBot.pair), EXCHANGE_TIMEOUT_MS, 'cancel_open_orders_timeout') as Array<{
        id?: string;
        clientOrderId?: string;
        clientOrderID?: string;
        info?: { clientOrderId?: string; origClientOrderId?: string };
      }>;
      for (const order of openOrders) {
        const clientOrderId = String(order.clientOrderId || order.clientOrderID || order.info?.clientOrderId || order.info?.origClientOrderId || '');
        if (!order.id || !pendingClientOrderIds.has(clientOrderId)) continue;
        await withTimeout(client.cancelOrder(order.id, firstBot.pair), EXCHANGE_TIMEOUT_MS, 'cancel_order_timeout');
        pendingClientOrderIds.delete(clientOrderId);
        cancelled += 1;
      }
      failures += pendingClientOrderIds.size;
    } catch {
      failures += 1;
    }
  }

  return { cancelled, failures };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

export async function restoreBotRunners(): Promise<void> {
  try {
    const pgBots = await getActiveBotsFromDb();

    for (const pgBot of pgBots) {
      if (pgBot.exchange_status !== 'ACTIVE') continue;

      const runnerId = pgBot.external_bot_id || pgBot.id;
      const cfg = typeof pgBot.config === 'string' ? JSON.parse(pgBot.config) : (pgBot.config || {});
      const cfgAvg = Number(cfg.averagingLayers);
      const cfgGrid = Number(cfg.gridLayers);
      const dbMaxLayers = Number(pgBot.max_layers || 0);

      const resolvedAvg = Number.isFinite(cfgAvg) && cfgAvg > 0
        ? cfgAvg
        : (pgBot.strategy_type === 'Grid Only' ? 0 : Math.max(1, dbMaxLayers || 8));

      const resolvedGrid = Number.isFinite(cfgGrid) && cfgGrid > 0
        ? cfgGrid
        : (pgBot.strategy_type === 'Avarage Only' ? 0 : Math.max(1, dbMaxLayers || 10));

      const stored: any = {
        id: runnerId,
        botId: runnerId,
        dbId: pgBot.id,
        uid: pgBot.firebase_uid,
        mode: pgBot.sandbox ? 'testnet' : 'live',
        botName: pgBot.name,
        pair: pgBot.symbol,
        status: pgBot.status === 'ERROR' ? 'error' : pgBot.status === 'STANDBY' ? 'paused' : (BOT_STARTUP_AUTO_RESUME ? 'active' : 'paused'),
        lastErrorReason: (!BOT_STARTUP_AUTO_RESUME && pgBot.status === 'ACTIVE') ? 'STARTUP_RESUME_REQUIRED' : undefined,
        entryPrice: Number(pgBot.entry_price || 0),
        useMoneyManagement: true,
        positionQty: Number(pgBot.position_qty || 0),
        positionVersion: 0,
        avgEntryPrice: Number(pgBot.avg_entry_price || 0),
        realizedPnlToday: Number(pgBot.realized_pnl_today || 0),
        failureStreak: 0,
        priceFailureStreak: 0,
        orderSequence: Number(pgBot.order_count || 0),
        timeframe: pgBot.timeframe || '5m',
        botMode: pgBot.strategy_type,
        exchange: pgBot.exchange,
        isSandbox: pgBot.sandbox,
        baseAmount: Number(pgBot.base_order_usd || 0),
        baseTp: Number(pgBot.take_profit_pct || 1),
        averageDownPct: Number(pgBot.step_deviation_pct || 1),
        gridTp: Number(pgBot.take_profit_pct || 1),
        tpCallbackPct: Number(pgBot.trailing_tp_pct || 0.1),
        layerCallbackPct: 0.1,
        averagingLayers: resolvedAvg,
        gridLayers: resolvedGrid,
        minPrice: pgBot.min_price ? Number(pgBot.min_price) : undefined,
        maxPrice: pgBot.max_price ? Number(pgBot.max_price) : undefined,
      };

      stored.uptrendFilter = cfg.uptrendFilter !== undefined ? Boolean(cfg.uptrendFilter) : true;
      stored.uptrendThresholdPct = Number(cfg.uptrendThresholdPct ?? 0.1);
      stored.uptrendStatus = 'Sideways';

      if (!['testnet', 'live'].includes(String(stored.mode)) || !['active', 'paused', 'error'].includes(String(stored.status))) {
        console.log('[RESTORE_BOT_SKIPPED_STATE]', stored.id, stored.mode, stored.status);
        continue;
      }
      if (typeof stored.pair !== 'string' || !stored.pair.toUpperCase().includes('USDT')) {
        console.log('[RESTORE_BOT_SKIPPED_PAIR]', stored.id, stored.pair);
        continue;
      }

      const bot = stored as ActiveBotRunner;

      if (GAIN_V2_ENABLED && (!bot.dcaLayers || bot.dcaLayers.length === 0) && (bot.botMode === 'Avarage Only' || bot.botMode === 'Avarage+Grid')) {
        try {
          bot.dcaLayers = generateDcaLayers({
            baseOrderUsd: bot.baseAmount,
            stepDeviationPct: bot.averageDownPct,
            stepScale: 1.25,
            volumeMultiplier: 1.3,
            maxLayers: Math.max(1, bot.averagingLayers),
            maxCapitalUsd: bot.useMoneyManagement !== false ? Math.min(V2_MAX_COMMITTED_CAPITAL_USDT, MAX_BOT_EXPOSURE_USDT) : Number.POSITIVE_INFINITY,
            takeProfitPct: bot.baseTp,
            trailingTpPct: bot.tpCallbackPct || 0.2,
            callbackPct: bot.layerCallbackPct || 0.2,
            minPrice: bot.minPrice || undefined,
            maxPrice: bot.maxPrice || undefined,
          });
        } catch {}
      }
      if (GAIN_V2_ENABLED && (!bot.gridLevels || bot.gridLevels.length === 0) && (bot.botMode === 'Grid Only' || bot.botMode === 'Avarage+Grid') && bot.minPrice && bot.maxPrice && bot.maxPrice > bot.minPrice) {
        try {
          bot.gridLevels = generateGridLevels({
            lowerPrice: bot.minPrice,
            upperPrice: bot.maxPrice,
            gridCount: Math.max(1, Math.min(100, bot.gridLayers || 10)),
            orderSizeUsd: bot.baseAmount,
            takeProfitPct: bot.gridTp || 1.2,
            maxCapitalUsd: bot.useMoneyManagement !== false ? V2_MAX_COMMITTED_CAPITAL_USDT : Number.POSITIVE_INFINITY,
          });
        } catch {}
      }

      const wasActive = bot.status === 'active';

      if (bot.pendingOrder) {
        try {
          await reconcilePendingBotOrderOnStartup(bot);
        } catch (error) {
          bot.status = 'paused';
          const recoveryCode = String((error as any)?.code || '').trim().toUpperCase();
          const recoveryMessage = String((error as any)?.message || '').trim().toUpperCase();
          const isPositionLedgerMismatch = recoveryCode === 'POSITION_LEDGER_MISMATCH' || recoveryMessage.includes('POSITION_LEDGER_MISMATCH');
          bot.lastErrorReason = isPositionLedgerMismatch ? 'POSITION_LEDGER_MISMATCH' : 'ORDER_STATUS_UNCERTAIN';
          bot.resumeAfterReconciliation = false;
        }
      }

      if (bot.status === 'active') {
        const lockAcquired = await acquireBotLease(bot);
        if (!lockAcquired) {
          console.warn('[SSOT_RESTORE_SKIPPED]', "Lock failed for runner ${bot.id}");
          bot.status = 'paused';
          bot.lastErrorReason = 'LEASE_LOST';
        }
      }

      activeBotsRegistry.set(botRegistryKey(bot.uid, bot.id), bot);

      if (GAIN_V2_ENABLED && ['active', 'paused', 'standby'].includes(String(bot.status).toLowerCase())) {
        try {
          v2WebSocketManager.connect(bot.exchange.toLowerCase(), bot.pair, bot.mode === 'testnet');
        } catch {}
      }

      if (wasActive && bot.status !== 'active') {
        await persistBotRunner(bot);
      }
    }
  } catch (error) {
    console.error('[RESTORE_BOT_RUNNERS_ERROR]', error);
  }
}

export async function runBotCycle(): Promise<void> {
  if (!isEngineRunning || activeBotsRegistry.size === 0 || isCycleRunning) return;
  isCycleRunning = true;
  try {
    for (const [botId, bot] of activeBotsRegistry.entries()) {
    if (bot.status !== 'active' && bot.resumeAfterReconciliation !== true) continue;

    let leased = false;
    try {
      if (!(await acquireBotLease(bot))) continue;
      leased = true;
      if (bot.pendingOrder) {
        try {
          await reconcilePendingBotOrderOnStartup(bot);
        } catch (error) {
          await recordBotFailure(bot, error, 'RECONCILIATION');
        }
        continue;
      }
      if (bot.resumeAfterReconciliation) {
        try {
          await reconcileLiveBotPosition(bot);

          if (BOT_STARTUP_AUTO_RESUME) {
            if (bot.mode === 'live') {
              try {
                await requireActiveLicense(bot.uid);
              } catch (error) {
                bot.resumeAfterReconciliation = false;
                bot.status = 'paused';
                bot.lastErrorReason = String((error as any)?.code || 'LICENSE_REQUIRED');
                await updateBotRuntimeStatus({
                  firebaseUid: bot.uid, externalBotId: bot.id, exchange: bot.exchange, symbol: bot.pair, status: 'STANDBY',
                });
                await persistBotRunner(bot);
                continue;
              }
            }

            await updateBotRuntimeStatus({
              firebaseUid: bot.uid, externalBotId: bot.id, exchange: bot.exchange, symbol: bot.pair, status: 'ACTIVE',
            });
            bot.resumeAfterReconciliation = false;
            bot.status = 'active';
            bot.lastErrorReason = undefined;
          } else {
            await updateBotRuntimeStatus({
              firebaseUid: bot.uid, externalBotId: bot.id, exchange: bot.exchange, symbol: bot.pair, status: 'STANDBY',
            });
            bot.resumeAfterReconciliation = false;
            bot.status = 'paused';
            bot.lastErrorReason = 'STARTUP_RESUME_REQUIRED';
          }
          await persistBotRunner(bot);
        } catch (error) {
          await recordBotFailure(bot, error, 'RECONCILIATION');
        }
        continue;
      }

      if ((bot.mode === 'testnet' || bot.mode === 'live') && Date.now() - (bot.lastReconciledAt || 0) >= BOT_RECONCILIATION_INTERVAL_MS) {
        try {
          await reconcileLiveBotPosition(bot);
        } catch (error) {
          await recordBotFailure(bot, error, 'RECONCILIATION');
          continue;
        }
      }

      let cached: Awaited<ReturnType<typeof getPrice>> | undefined;
      try {
        cached = await getPrice(bot.exchange, bot.pair, bot.isSandbox);
      } catch {
        cached = undefined;
      }

      let candleSnapshot: Awaited<ReturnType<typeof getClosedCandleMarketSnapshot>>;
      try {
        candleSnapshot = await getClosedCandleMarketSnapshot(bot);
      } catch (error) {
        bot.priceFailureStreak += 1;
        if (bot.priceFailureStreak >= BOT_FAILURE_PAUSE_THRESHOLD) {
          await transitionBotLifecycle(bot, 'paused', (error as any)?.code || 'CANDLE_DATA_UNAVAILABLE');
        }
        continue;
      }

      bot.priceFailureStreak = 0;
      bot.lastEvaluatedPrice = candleSnapshot.candle.close;

      // Check configured price boundary guardrails
      if (bot.maxPrice && bot.lastEvaluatedPrice > bot.maxPrice) {
        bot.priceBoundaryStatus = 'ABOVE_MAX';
      } else if (bot.minPrice && bot.lastEvaluatedPrice < bot.minPrice) {
        bot.priceBoundaryStatus = 'BELOW_MIN';
      } else {
        bot.priceBoundaryStatus = 'IN_RANGE';
      }

      // --- UPTREND / BULLISH EVALUATION ---
      const candle = candleSnapshot.candle;
      const candleChangePct = candle.open > 0 ? ((candle.close - candle.open) / candle.open) * 100 : 0;
      const prevCloseChangePct = candleSnapshot.previousCandleClose > 0 ? ((candle.close - candleSnapshot.previousCandleClose) / candleSnapshot.previousCandleClose) * 100 : candleChangePct;
      const thresholdPct = Number.isFinite(bot.uptrendThresholdPct) && (bot.uptrendThresholdPct as number) > 0 ? (bot.uptrendThresholdPct as number) : 0.1;

      // Closed candle gain must meet or exceed the threshold percentage to qualify as an uptrend
      const effectiveGainPct = Math.max(candleChangePct, prevCloseChangePct);
      const isUptrend = candle.close >= candle.open && effectiveGainPct >= thresholdPct;

      bot.uptrendStatus = isUptrend
        ? 'Bullish'
        : (candle.close < candle.open && candleChangePct <= -thresholdPct ? 'Downtrend' : 'Sideways');

      // --- INITIAL ENTRY ORDER ---
      if ((bot.positionQty || 0) <= 0 && bot.status === 'active' && !bot.pendingOrder) {
        if (bot.priceBoundaryStatus !== 'IN_RANGE') {
          // Gated by price boundaries: do not accumulate initial position if BELOW_MIN or ABOVE_MAX
          continue;
        }
        if (bot.uptrendFilter !== false && !isUptrend) {
          // Gated by Filter Uptrend Bullish: wait for market uptrend confirmation (gain >= thresholdPct) before initial accumulation
          continue;
        }

        const isGridOnlyBot = bot.botMode === 'Grid Only';
        const firstEntryQty = Number(bot.baseAmount || 20) / bot.lastEvaluatedPrice;
        if (firstEntryQty > 0) {
          try {
            const executed = await executeBotMarketOrder(bot, 'buy', firstEntryQty, bot.lastEvaluatedPrice, Date.now(), false);
            bot.stepLayer = 1;
            bot.entryPrice = executed.fillPrice;
            bot.avgEntryPrice = executed.fillPrice;
            bot.positionQty = executed.filledQty;
            bot.peakPrice = executed.fillPrice;
            bot.troughPrice = executed.fillPrice;

            const baseCoin = bot.pair.split('/')[0] || bot.pair;
            const firstLayerItem = {
              id: `layer-${bot.id}-1`,
              orderId: executed.orderId,
              symbol: bot.pair,
              coin: baseCoin,
              side: 'buy' as const,
              layerNo: 1,
              layerStep: 1,
              layerType: isGridOnlyBot ? ('grid' as const) : ('average' as const),
              amount: executed.filledQty,
              costUsdt: Number((executed.filledQty * executed.fillPrice).toFixed(4)),
              buyPrice: executed.fillPrice,
              timestamp: Date.now(),
              status: 'filled' as const,
              label: isGridOnlyBot ? `GRID INITIAL BUY -> ${executed.filledQty.toFixed(4)} ${baseCoin}` : `BUY -> ${executed.filledQty.toFixed(4)} ${baseCoin}`,
              currentPrice: executed.fillPrice,
              estimatedTpPrice: Number((executed.fillPrice * (1 + (bot.baseTp || 1) / 100)).toFixed(4)),
              estimatedTpPct: Number(bot.baseTp || 1),
              estimatedTpUsdt: Number((executed.filledQty * executed.fillPrice * ((bot.baseTp || 1) / 100)).toFixed(4)),
              floatingPnlUsdt: 0,
              floatingPnlPct: 0,
              fee: 0,
              feeAsset: 'USDT',
              date: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
              isInitialEntry: true,
            };
            bot.executedLayers = [firstLayerItem as any];

            if ((bot.botMode === 'Grid Only' || bot.botMode === 'Avarage+Grid') && bot.minPrice && bot.maxPrice && bot.maxPrice > bot.minPrice) {
              bot.gridLevels = generateGridLevels({
                lowerPrice: bot.minPrice,
                upperPrice: bot.maxPrice,
                gridCount: Math.max(1, Math.min(100, bot.gridLayers || 20)),
                orderSizeUsd: Number(bot.baseAmount),
                takeProfitPct: Number(bot.gridTp) || 1.2,
                maxCapitalUsd: bot.useMoneyManagement !== false ? V2_MAX_COMMITTED_CAPITAL_USDT : Number.POSITIVE_INFINITY,
              }, executed.fillPrice);
            }

            await persistBotRunner(bot);
          } catch (e) {
            console.error('[FIRST_ENTRY_FAILED]', e);
          }
        }
        continue;
      }

      // --- POSITION MANAGEMENT: TAKE PROFIT, DCA AVERAGING & GRID ---
      if ((bot.positionQty || 0) > 0 && bot.status === 'active' && !bot.pendingOrder) {
        const currentPrice = bot.lastEvaluatedPrice;
        const avgEntry = bot.avgEntryPrice || bot.entryPrice || currentPrice;
        const baseTp = Number(bot.baseTp || 1.0);
        const tpCallbackPct = Number(bot.tpCallbackPct || 0);
        const profitPct = avgEntry > 0 ? ((currentPrice - avgEntry) / avgEntry) * 100 : 0;

        // Ensure executedLayers is populated if bot has an active position
        if (!Array.isArray(bot.executedLayers) || bot.executedLayers.length === 0) {
          const baseCoin = bot.pair.split('/')[0] || bot.pair;
          const fillPrice = avgEntry > 0 ? avgEntry : currentPrice;
          bot.executedLayers = [{
            id: `layer-${bot.id}-1`,
            orderId: bot.botId || bot.id,
            symbol: bot.pair,
            coin: baseCoin,
            side: 'buy',
            layerNo: 1,
            layerStep: 1,
            layerType: 'average',
            amount: Number(bot.positionQty || 0),
            costUsdt: Number((Number(bot.positionQty || 0) * fillPrice).toFixed(4)),
            buyPrice: fillPrice,
            timestamp: Date.now(),
            status: 'filled',
            label: `BUY -> ${Number(bot.positionQty || 0).toFixed(4)} ${baseCoin}`,
            currentPrice,
            estimatedTpPrice: Number((fillPrice * (1 + baseTp / 100)).toFixed(4)),
            estimatedTpPct: baseTp,
            estimatedTpUsdt: Number((Number(bot.positionQty || 0) * fillPrice * (baseTp / 100)).toFixed(4)),
            floatingPnlUsdt: Number(((currentPrice - fillPrice) * Number(bot.positionQty || 0)).toFixed(4)),
            floatingPnlPct: fillPrice > 0 ? Number((((currentPrice - fillPrice) / fillPrice) * 100).toFixed(2)) : 0,
            fee: 0,
            feeAsset: 'USDT',
            date: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
            isInitialEntry: true,
          } as any];
        }

        // Realtime dynamic updates to executedLayers floating PnL
        if (Array.isArray(bot.executedLayers) && bot.executedLayers.length > 0) {
          bot.executedLayers = bot.executedLayers.map((l: any) => {
            if (l.status === 'filled' && l.buyPrice > 0 && l.amount > 0) {
              const pnlPct = ((currentPrice - l.buyPrice) / l.buyPrice) * 100;
              const pnlUsdt = (currentPrice - l.buyPrice) * l.amount;
              return {
                ...l,
                currentPrice,
                floatingPnlUsdt: Number(pnlUsdt.toFixed(4)),
                floatingPnlPct: Number(pnlPct.toFixed(2)),
              };
            }
            return l;
          });
        }

        // Take Profit Check (with Trailing Callback)
        const isAveragingMode = bot.botMode === 'Avarage Only' || bot.botMode === 'Avarage+Grid';
        const isGridOnly = bot.botMode === 'Grid Only';

        const isTrailingArmed = bot.peakPrice !== undefined && profitPct > 0;
        const hasReachedTp = isAveragingMode && (
          profitPct >= baseTp ||
          isTrailingArmed
        );

        if (hasReachedTp) {
          bot.peakPrice = Math.max(bot.peakPrice || currentPrice, currentPrice);
          const pullBackPct = bot.peakPrice > 0 ? ((bot.peakPrice - currentPrice) / bot.peakPrice) * 100 : 0;

          if (tpCallbackPct <= 0 || pullBackPct >= tpCallbackPct) {
            try {
              await executeBotMarketOrder(bot, 'sell', bot.positionQty, currentPrice, Date.now(), false);
              bot.stepLayer = 0;
              bot.peakPrice = undefined;
              bot.troughPrice = undefined;
              bot.positionQty = 0;
              bot.avgEntryPrice = 0;
              bot.executedLayers = [];
              bot.closedLayerIds = [];
              if (GAIN_V2_ENABLED && bot.dcaLayers) {
                bot.dcaLayers = generateDcaLayers({
                  baseOrderUsd: bot.baseAmount,
                  stepDeviationPct: bot.averageDownPct,
                  stepScale: 1.25,
                  volumeMultiplier: 1.3,
                  maxLayers: Math.max(1, bot.averagingLayers),
                  maxCapitalUsd: bot.useMoneyManagement !== false ? Math.min(V2_MAX_COMMITTED_CAPITAL_USDT, MAX_BOT_EXPOSURE_USDT) : Number.POSITIVE_INFINITY,
                  takeProfitPct: bot.baseTp,
                  trailingTpPct: bot.tpCallbackPct || 0.2,
                  callbackPct: bot.layerCallbackPct || 0.2,
                  minPrice: bot.minPrice || undefined,
                  maxPrice: bot.maxPrice || undefined,
                  steps: (bot as any).steps,
                });
              }
              if (GAIN_V2_ENABLED && bot.gridLevels && bot.minPrice && bot.maxPrice && bot.maxPrice > bot.minPrice) {
                bot.gridLevels = generateGridLevels({
                  lowerPrice: bot.minPrice,
                  upperPrice: bot.maxPrice,
                  gridCount: Math.max(1, Math.min(100, bot.gridLayers || 20)),
                  orderSizeUsd: Number(bot.baseAmount),
                  takeProfitPct: Number(bot.gridTp) || 1.2,
                  maxCapitalUsd: bot.useMoneyManagement !== false ? V2_MAX_COMMITTED_CAPITAL_USDT : Number.POSITIVE_INFINITY,
                }, currentPrice);
              }
            } catch (e: any) {
              console.error('[TP_EXECUTION_FAILED]', e);
              const failure = classifyBotExecutionError(e);
              if (failure.reasonCode === 'INSUFFICIENT_BALANCE' || failure.reasonCode === 'POSITION_EXHAUSTED_ON_EXCHANGE') {
                try {
                  const credential = await loadBotCredential(bot.uid, bot.exchange);
                  if (credential) {
                    const client = createExchangeInstance(bot.exchange, credential);
                    const baseCoin = bot.pair.split('/')[0].toUpperCase();
                    const free = await getExchangeFreeBalance(client, baseCoin);
                    if (free <= 1e-8 || (currentPrice > 0 && free * currentPrice < 0.2)) {
                      console.log(`[TP_AUTO_RECONCILED] Bot ${bot.id} ${bot.pair} exchange balance is zero/dust (${free}). Resetting position.`);
                      bot.positionQty = 0;
                      bot.avgEntryPrice = 0;
                      bot.stepLayer = 0;
                      bot.peakPrice = undefined;
                      bot.troughPrice = undefined;
                      bot.executedLayers = [];
                      bot.closedLayerIds = [];
                      await dbQuery(
                        `UPDATE positions SET quantity = 0, average_entry = 0, reserved_quantity = 0, updated_at = now()
                         WHERE bot_id = (SELECT id FROM bots WHERE external_bot_id = $1 LIMIT 1) AND symbol = $2`,
                        [bot.id, bot.pair],
                      ).catch(() => {});
                      await persistBotRunner(bot);
                    } else if (free > 0 && free < bot.positionQty) {
                      console.log(`[TP_AUTO_RECONCILED] Bot ${bot.id} ${bot.pair} adjusting positionQty from ${bot.positionQty} to ${free}.`);
                      bot.positionQty = free;
                      await dbQuery(
                        `UPDATE positions SET quantity = $3, updated_at = now()
                         WHERE bot_id = (SELECT id FROM bots WHERE external_bot_id = $1 LIMIT 1) AND symbol = $2`,
                        [bot.id, bot.pair, free],
                      ).catch(() => {});
                      await persistBotRunner(bot);
                    }
                  }
                } catch (recErr) {
                  console.error('[TP_RECONCILE_FAILED]', recErr);
                }
              }
            }
            continue;
          }
        } else {
          bot.peakPrice = undefined;
        }

        // Averaging Down (DCA) Check
        const maxLayers = Math.max(
          Number(bot.averagingLayers || 0),
          Array.isArray(bot.dcaLayers) ? bot.dcaLayers.length : 0,
          isAveragingMode ? 8 : 0
        );
        const currentLayer = Number.isFinite(bot.stepLayer) ? bot.stepLayer : 1;
        const stepDevPct = Number(bot.averageDownPct || 1.0);

        if (isAveragingMode && maxLayers > 0 && currentLayer < maxLayers && stepDevPct > 0 && bot.priceBoundaryStatus === 'IN_RANGE') {
          const dropFromAvgPct = avgEntry > 0 ? ((avgEntry - currentPrice) / avgEntry) * 100 : 0;
          const dcaConfigLayer = bot.dcaLayers?.[currentLayer];
          const targetDropPct = dcaConfigLayer ? dcaConfigLayer.deviationPct : (currentLayer * stepDevPct);
          const nextLayerAmount = dcaConfigLayer ? dcaConfigLayer.amountUsd : Number(bot.baseAmount || 20);

          if (dropFromAvgPct >= targetDropPct) {
            const layerQty = currentPrice > 0 ? nextLayerAmount / currentPrice : 0;

            if (layerQty > 0) {
              try {
                const executed = await executeBotMarketOrder(bot, 'buy', layerQty, currentPrice, Date.now(), false);
                const nextLayerNo = currentLayer + 1;
                bot.stepLayer = nextLayerNo;
                bot.troughPrice = executed.fillPrice;

                // Mark executed DCA layer status as FILLED
                if (Array.isArray(bot.dcaLayers) && bot.dcaLayers[currentLayer]) {
                  bot.dcaLayers[currentLayer].status = 'FILLED';
                }

                const baseCoin = bot.pair.split('/')[0] || bot.pair;
                const dcaLayerItem = {
                  id: `layer-${bot.id}-${nextLayerNo}`,
                  orderId: executed.orderId,
                  symbol: bot.pair,
                  coin: baseCoin,
                  side: 'buy' as const,
                  layerNo: nextLayerNo,
                  layerStep: nextLayerNo,
                  layerType: 'average' as const,
                  amount: executed.filledQty,
                  costUsdt: Number((executed.filledQty * executed.fillPrice).toFixed(4)),
                  buyPrice: executed.fillPrice,
                  timestamp: Date.now(),
                  status: 'filled' as const,
                  label: `DCA ${nextLayerNo} -> ${executed.filledQty.toFixed(4)} ${baseCoin}`,
                  currentPrice: executed.fillPrice,
                  estimatedTpPrice: Number((executed.fillPrice * (1 + (bot.baseTp || 1) / 100)).toFixed(4)),
                  estimatedTpPct: Number(bot.baseTp || 1),
                  estimatedTpUsdt: Number((executed.filledQty * executed.fillPrice * ((bot.baseTp || 1) / 100)).toFixed(4)),
                  floatingPnlUsdt: 0,
                  floatingPnlPct: 0,
                  fee: 0,
                  feeAsset: 'USDT',
                  date: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                  isInitialEntry: false,
                };
                bot.executedLayers = [...(bot.executedLayers || []), dcaLayerItem as any];
                await persistBotRunner(bot);
              } catch (e) {
                console.error('[DCA_LAYER_FAILED]', e);
              }
              continue;
            }
          }
        }

        // Grid Order Execution Check
        const isGridMode = bot.botMode === 'Grid Only' || bot.botMode === 'Avarage+Grid';
        if (isGridMode && Array.isArray(bot.gridLevels) && bot.gridLevels.length > 0 && !bot.pendingOrder) {
          const previousPrice = bot.lastStrategySignalPrice || avgEntry || currentPrice;
          const gridOrderSizeUsd = Number(bot.baseAmount || 20);

          const levels = bot.gridLevels as GridLevel[];
          // Check crossed BUY grid levels
          const crossedBuyLevel = levels
            .filter((l: GridLevel) => l.status === 'WAITING' && l.side === 'BUY' && (previousPrice >= l.price || l.price >= currentPrice) && currentPrice <= l.price)
            .sort((a: GridLevel, b: GridLevel) => b.price - a.price)[0];

          if (crossedBuyLevel && bot.priceBoundaryStatus === 'IN_RANGE') {
            const buyQty = currentPrice > 0 ? gridOrderSizeUsd / currentPrice : 0;
            if (buyQty > 0) {
              try {
                const executed = await executeBotMarketOrder(bot, 'buy', buyQty, currentPrice, Date.now(), false);
                bot.gridLevels = pairGridLevel(levels, crossedBuyLevel.id, executed.fillPrice, 'buy', executed.filledQty);
                const baseCoin = bot.pair.split('/')[0] || bot.pair;
                const gridStepIndex = bot.botMode === 'Avarage+Grid'
                  ? (Number(bot.averagingLayers || 0) + crossedBuyLevel.index)
                  : crossedBuyLevel.index;

                const gridLayerItem = {
                  id: `grid-${bot.id}-${crossedBuyLevel.id}-${Date.now()}`,
                  orderId: executed.orderId,
                  symbol: bot.pair,
                  coin: baseCoin,
                  side: 'buy' as const,
                  layerNo: gridStepIndex,
                  layerStep: gridStepIndex,
                  layerType: 'grid' as const,
                  amount: executed.filledQty,
                  costUsdt: Number((executed.filledQty * executed.fillPrice).toFixed(4)),
                  buyPrice: executed.fillPrice,
                  timestamp: Date.now(),
                  status: 'filled' as const,
                  label: `GRID BUY #${gridStepIndex} -> ${executed.filledQty.toFixed(4)} ${baseCoin}`,
                  currentPrice: executed.fillPrice,
                  estimatedTpPrice: Number((executed.fillPrice * (1 + (bot.gridTp || 1.2) / 100)).toFixed(4)),
                  estimatedTpPct: Number(bot.gridTp || 1.2),
                  estimatedTpUsdt: Number((executed.filledQty * executed.fillPrice * ((bot.gridTp || 1.2) / 100)).toFixed(4)),
                  floatingPnlUsdt: 0,
                  floatingPnlPct: 0,
                  fee: 0,
                  feeAsset: 'USDT',
                  date: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                  isInitialEntry: false,
                };
                bot.executedLayers = [...(bot.executedLayers || []), gridLayerItem as any];

                const activeBuyLayers = (bot.executedLayers || []).filter((l: any) => l.side === 'buy' && l.status !== 'closed').length;
                bot.stepLayer = Math.max(1, activeBuyLayers);

                await persistBotRunner(bot);
              } catch (e) {
                console.error('[GRID_BUY_FAILED]', e);
              }
              continue;
            }
          }

          // Check crossed SELL grid levels
          if ((bot.positionQty || 0) > 0) {
            const crossedSellLevel = levels
              .filter((l: GridLevel) => (l.status === 'WAITING' || l.status === 'COOLDOWN') && l.side === 'SELL' && (previousPrice <= l.price || currentPrice >= l.price) && currentPrice >= l.price)
              .sort((a: GridLevel, b: GridLevel) => a.price - b.price)[0];

            if (crossedSellLevel) {
              const sellQty = Math.min(bot.positionQty, gridOrderSizeUsd / currentPrice);
              if (sellQty > 0) {
                try {
                  const executed = await executeBotMarketOrder(bot, 'sell', sellQty, currentPrice, Date.now(), false);
                  bot.gridLevels = pairGridLevel(levels, crossedSellLevel.id, executed.fillPrice, 'sell', executed.filledQty);
                  const baseCoin = bot.pair.split('/')[0] || bot.pair;
                  const gridStepIndex = bot.botMode === 'Avarage+Grid'
                    ? (Number(bot.averagingLayers || 0) + crossedSellLevel.index)
                    : crossedSellLevel.index;

                  const gridSellItem = {
                    id: `grid-${bot.id}-${crossedSellLevel.id}-${Date.now()}`,
                    orderId: executed.orderId,
                    symbol: bot.pair,
                    coin: baseCoin,
                    side: 'sell' as const,
                    layerNo: gridStepIndex,
                    layerStep: gridStepIndex,
                    layerType: 'grid' as const,
                    amount: executed.filledQty,
                    costUsdt: Number((executed.filledQty * executed.fillPrice).toFixed(4)),
                    buyPrice: executed.fillPrice,
                    timestamp: Date.now(),
                    status: 'closed' as const,
                    label: `GRID SELL #${gridStepIndex} -> ${executed.filledQty.toFixed(4)} ${baseCoin}`,
                    currentPrice: executed.fillPrice,
                    estimatedTpPrice: executed.fillPrice,
                    estimatedTpPct: 0,
                    estimatedTpUsdt: 0,
                    floatingPnlUsdt: 0,
                    floatingPnlPct: 0,
                    fee: 0,
                    feeAsset: 'USDT',
                    date: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                    isInitialEntry: false,
                  };
                  bot.executedLayers = [...(bot.executedLayers || []), gridSellItem as any];

                  // Mark paired buy layer as closed if available
                  if (crossedSellLevel.pairedLevelId) {
                    bot.executedLayers = bot.executedLayers.map((l: any) =>
                      l.id.includes(crossedSellLevel.pairedLevelId!) ? { ...l, status: 'closed' } : l
                    );
                  }

                  const activeBuyLayers = (bot.executedLayers || []).filter((l: any) => l.side === 'buy' && l.status !== 'closed').length;
                  bot.stepLayer = Math.max(1, activeBuyLayers);

                  await persistBotRunner(bot);
                } catch (e) {
                  console.error('[GRID_SELL_FAILED]', e);
                }
                continue;
              }
            }
          }
        }

        bot.lastStrategySignalPrice = currentPrice;
      }

    } catch (error) {
      await recordBotFailure(bot, error, 'RUNNER_ERROR');
    } finally {
      if (leased) {
        await releaseBotLease(bot).catch(() => {});
      }
    }
  }
} finally {
  isCycleRunning = false;
}
}

export function startBotEngineLoop(intervalMs = 5000): void {
  if (botWorkerInterval) return;
  isEngineRunning = true;
  botWorkerInterval = setInterval(() => {
    runBotCycle().catch((err) => {
      console.error('[BOT_CYCLE_UNHANDLED_ERROR]', String((err as any)?.message || err));
    });
  }, intervalMs);
}

export function stopBotEngineLoop(): void {
  if (botWorkerInterval) {
    clearInterval(botWorkerInterval);
    botWorkerInterval = undefined;
  }
  isEngineRunning = false;
}
