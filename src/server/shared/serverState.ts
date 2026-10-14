import { redisAvailable } from '../redis';

export const SERVER_STARTED_AT = Date.now();

export interface ServerState {
  persistenceReady: boolean;
  persistenceFailureCode?: string;
  databaseReady: boolean;
  databaseFailureCode?: string;
  shutdownRequested: boolean;
}

export const serverState: ServerState = {
  persistenceReady: false,
  persistenceFailureCode: undefined,
  databaseReady: false,
  databaseFailureCode: undefined,
  shutdownRequested: false,
};

export const apiRequestMetrics = new Map<string, { count: number; failures: number; totalDurationMs: number; slowRequests: number }>();
export const activeBotsRegistry = new Map<string, any>();
export const tickerMemoryCache = new Map<string, { last: number; percentage: number; timestamp: number; source?: string; quoteCurrency?: string }>();
export const marketsMemoryCache = new Map<string, { timestamp: number; markets: any[] }>();
export const botExecutionMetrics = { confirmedOrders: 0, failedOrders: 0, tickerRequests: 0, tickerFailures: 0, tickerTotalLatencyMs: 0 };

export function getHealthSnapshot() {
  const totals = Array.from(apiRequestMetrics.values()).reduce((summary, metric) => ({
    requests: summary.requests + metric.count,
    failures: summary.failures + metric.failures,
    slowRequests: summary.slowRequests + metric.slowRequests,
    totalDurationMs: summary.totalDurationMs + metric.totalDurationMs,
  }), { requests: 0, failures: 0, slowRequests: 0, totalDurationMs: 0 });

  const bots = Array.from(activeBotsRegistry.values());
  const exchangeTickers = Array.from(tickerMemoryCache.entries())
    .filter(([key, ticker]) => key.startsWith(`${String(ticker.source || '').toLowerCase()}:`) && ticker.source !== 'coingecko');
  const newestExchangeTicker = exchangeTickers.reduce((newest, [, ticker]) => Math.max(newest, ticker.timestamp), 0);

  return {
    success: true,
    status: serverState.persistenceReady ? 'ok' : 'not_ready',
    uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    requests: {
      total: totals.requests,
      failures: totals.failures,
      slow: totals.slowRequests,
      averageDurationMs: totals.requests ? Number((totals.totalDurationMs / totals.requests).toFixed(1)) : 0,
    },
    bots: {
      active: bots.filter((bot) => bot.status === 'active').length,
      paused: bots.filter((bot) => bot.status === 'paused').length,
      error: bots.filter((bot) => bot.status === 'error').length,
      total: bots.length,
    },
    orders: {
      confirmed: botExecutionMetrics.confirmedOrders,
      failed: botExecutionMetrics.failedOrders,
      errorRate: botExecutionMetrics.confirmedOrders + botExecutionMetrics.failedOrders
        ? Number((botExecutionMetrics.failedOrders / (botExecutionMetrics.confirmedOrders + botExecutionMetrics.failedOrders)).toFixed(4))
        : 0,
    },
    ticker: {
      requests: botExecutionMetrics.tickerRequests,
      failures: botExecutionMetrics.tickerFailures,
      averageLatencyMs: botExecutionMetrics.tickerRequests
        ? Number((botExecutionMetrics.tickerTotalLatencyMs / botExecutionMetrics.tickerRequests).toFixed(1))
        : 0,
      latestAgeSeconds: newestExchangeTicker ? Math.max(0, Math.floor((Date.now() - newestExchangeTicker) / 1000)) : null,
    },
    timestamp: new Date().toISOString(),
    database: { ready: serverState.databaseReady, failureCode: serverState.databaseFailureCode },
    redis: { configured: Boolean(process.env.REDIS_URL) },
  };
}
