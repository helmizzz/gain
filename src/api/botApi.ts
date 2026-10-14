import { postJson, getJson } from './httpClient';



export async function registerBackgroundBot(payload: Record<string, unknown>) {
  return postJson<Record<string, any>>('/api/bot/register', payload);
}

export async function deleteBackgroundBot(botId: string) {
  return postJson<Record<string, any>>('/api/bot/delete', { botId });
}

export async function storeBotCredentials(credentials: {
  exchange: string;
  apiKey: string;
  secret: string;
  password?: string;
  isSandbox: boolean;
}) {
  return postJson<Record<string, any>>('/api/bot/credentials', credentials);
}

export async function getExchangeCredentialHistory(exchange?: string) {
  const query = exchange ? `?exchange=${encodeURIComponent(exchange)}` : '';
  return getJson<Record<string, any>>(`/api/bot/credentials/history${query}`);
}

export async function disconnectBotExchange(exchange: string) {
  return postJson<Record<string, any>>('/api/bot/disconnect-exchange', { exchange });
}

export async function activateBotKillSwitch() {
  return postJson<Record<string, any>>('/api/bot/kill-switch', {});
}

export async function getBotEngineStatus() {
  return getJson<Record<string, any>>('/api/bot/engine-status');
}

export async function setBotStatus(
  botId: string,
  status: 'active' | 'paused',
) {
  return postJson<Record<string, any>>(
    '/api/bot/status',
    { botId, status }
  );
}
export async function updateBotBounds(payload: {
  botId: string;
  pair?: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}) {
  return postJson<Record<string, any>>('/api/bot/update-bounds', payload);
}

export async function forceTakeProfit(botId: string, pair: string, quantity?: number, layerId?: string) {
  return postJson<Record<string, any>>(
    '/api/bot/force-take-profit',
    { botId, pair, quantity, layerId }
  );
}

export async function reconcileBot(botId: string) {
  return postJson<Record<string, any>>(
    '/api/bot/reconcile',
    { botId }
  );
}

export async function rebuildBotPositionFromFills(botId: string, pair?: string) {
  return postJson<Record<string, any>>(
    '/api/bot/rebuild-position-from-fills',
    { botId, pair }
  );
}

export async function pauseAllBots() {
  return postJson<Record<string, any>>(
    '/api/bot/pause-all',
    {}
  );
}

export async function resumeAllBots() {
  return postJson<Record<string, any>>(
    '/api/bot/resume-all',
    {}
  );
}
