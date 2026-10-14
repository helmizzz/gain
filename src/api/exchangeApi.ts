import { postJson, getJson } from './httpClient';
import { SUPPORTED_COINS } from '../data/appData';



export const LIVE_TICKER_SYMBOLS = SUPPORTED_COINS.map((coin) => coin.pair) as readonly string[];

export interface ExchangeTicker {
  last: number;
  percentage: number;
  timestamp: number;
  source?: string;
  quoteCurrency?: string;
}

export interface BatchTickerResponse {
  success: true;
  exchange: string;
  source?: string;
  tickers: Record<string, ExchangeTicker>;
  degraded?: boolean;
  warning?: string;
}

export function fetchBatchTickers(exchange: string, symbols: readonly string[], isSandbox = false, signal?: AbortSignal) {
  return postJson<BatchTickerResponse>('/api/exchange/fetch-tickers-batch', { exchange, symbols, isSandbox }, signal);
}

export async function fetchExchangePortfolio(payload: Record<string, unknown>) {
  return postJson<Record<string, any>>('/api/exchange/fetch-portfolio', payload);
}

export async function fetchExchangeTrades(payload: Record<string, unknown>) {
  return postJson<Record<string, any>>('/api/exchange/fetch-trades', payload);
}

export async function fetchExchangeOpenOrders(payload: Record<string, unknown>) {
  return postJson<Record<string, any>>('/api/exchange/fetch-open-orders', payload);
}

export async function cancelExchangeOrder(payload: Record<string, unknown>) {
  return postJson<Record<string, any>>('/api/exchange/cancel-order', payload);
}

export async function placeExchangeOrder(payload: Record<string, unknown>) {
  return postJson<Record<string, any>>('/api/exchange/place-order', payload);
}

export async function testExchangeConnection(payload: Record<string, unknown>, signal?: AbortSignal) {
  return postJson<Record<string, any>>('/api/exchange/test-connection', payload, signal);
}

export async function testAllCoinsExecution(payload: Record<string, unknown>) {
  return postJson<{
    success: boolean;
    totalVerified: number;
    summary: string;
    executableCount: number;
    allExecutable: boolean;
    ordersSubmitted: number;
    environment: 'TESTNET' | 'LIVE';
    results: Array<{
      symbol: string;
      executable: boolean;
      executionStatus: string;
      isLiveConnected: boolean;
      price?: number;
      timestamp?: number;
      latencyMs: number;
      note: string;
    }>;
  }>('/api/exchange/test-all-coins-execution', payload);
}

export async function fetchExchangeMarkets(payload: Record<string, unknown>) {
  return postJson<Record<string, any>>('/api/exchange/markets', payload);
}

export async function certifyExchange(exchange: string, signal?: AbortSignal) {
  return postJson<{
    success: boolean;
    exchange: string;
    mode: string;
    certificationMode: string;
    checks?: Record<string, boolean>;
    sample?: { symbol: string; last: number; quoteCurrency: string; timestamp: number } | null;
    sampleSymbol?: string | null;
    latencyMs?: number;
    note?: string;
  }>('/api/exchange/certification', { exchange }, signal);
}


export type ExchangeCertificationStage = 'authenticated_readonly' | 'sandbox_demo_order' | 'micro_live_order' | 'reconcile' | 'recovery';

export interface ExchangeCertificationStageResponse {
  success: boolean;
  exchange: string;
  stage: ExchangeCertificationStage;
  mode: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'WARNING';
  orderId?: string;
  result?: Record<string, unknown>;
  error?: string;
  code?: string;
}

export async function runExchangeCertificationStage(
  exchange: string,
  stage: ExchangeCertificationStage,
  options: { confirmation?: string; otp2fa?: string } = {},
  signal?: AbortSignal,
) {
  return postJson<ExchangeCertificationStageResponse>(
    '/api/exchange/certification/stage',
    { exchange, stage, confirmation: options.confirmation, otp2fa: options.otp2fa },
    signal
  );
}

export async function getExchangeCertificationLatest(exchange: string, signal?: AbortSignal) {
  return getJson<{ success: boolean; exchange: string; stages: Record<string, unknown> }>(`/api/exchange/certification/latest?exchange=${encodeURIComponent(exchange)}`);
}
