import { getExchangeDescriptor } from '../config/exchangeRegistry';
import type { ConnectedExchangeConfig, ExchangeName } from '../types';

export function normalizeExchangeName(value: unknown): string {
  const str = String(value || '').trim();
  const desc = getExchangeDescriptor(str);
  if (desc) return desc.id;
  return str.toLowerCase();
}

export function selectActiveExchangeConfig(
  configs: ConnectedExchangeConfig[] | undefined,
  activeExchange: ExchangeName | undefined,
): ConnectedExchangeConfig | null {
  const target = normalizeExchangeName(activeExchange);
  if (!target) return null;
  return (configs || []).find((item) => item.isConnected && normalizeExchangeName(item.exchange) === target) || null;
}

export function filterExchangeScoped<T extends { exchange?: string; isSandbox?: boolean }>(
  items: T[],
  activeExchange: ExchangeName,
  isSandbox?: boolean,
): T[] {
  const target = normalizeExchangeName(activeExchange);
  return items.filter((item) =>
    normalizeExchangeName(item.exchange) === target &&
    (isSandbox === undefined || item.isSandbox === isSandbox)
  );
}
