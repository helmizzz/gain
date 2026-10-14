import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getExchangeFreeBalance } from './bot/botRunnerLoop';
import { classifyBotExecutionError, BotExecutionFailure } from '../services/botEngineCore';

test('classifyBotExecutionError recognizes INSUFFICIENT_BALANCE and POSITION_EXHAUSTED', () => {
  const err1 = classifyBotExecutionError(new Error('insufficient balance to sell'));
  assert.equal(err1.reasonCode, 'INSUFFICIENT_BALANCE');
  assert.equal(err1.retryable, false);

  const err2 = classifyBotExecutionError(new Error('insufficient funds in account'));
  assert.equal(err2.reasonCode, 'INSUFFICIENT_BALANCE');
  assert.equal(err2.retryable, false);

  const err3 = classifyBotExecutionError(new BotExecutionFailure('POSITION_EXHAUSTED_ON_EXCHANGE', false));
  assert.equal(err3.reasonCode, 'POSITION_EXHAUSTED_ON_EXCHANGE');
  assert.equal(err3.retryable, false);
});

test('getExchangeFreeBalance extracts free balance from standard exchange client', async () => {
  const mockClient = {
    id: 'binance',
    fetchBalance: async () => ({
      free: { UNI: 12.345, USDT: 100 },
      used: { UNI: 0, USDT: 0 },
      total: { UNI: 12.345, USDT: 100 },
    }),
  };

  const freeUni = await getExchangeFreeBalance(mockClient, 'UNI');
  assert.equal(freeUni, 12.345);

  const freeBtc = await getExchangeFreeBalance(mockClient, 'BTC');
  assert.equal(freeBtc, 0);
});

test('getExchangeFreeBalance falls back to OKX privateGetAccountBalance on error', async () => {
  const mockOkxClient = {
    id: 'okx',
    fetchBalance: async () => {
      throw new Error('fetch failed: read ECONNRESET');
    },
    privateGetAccountBalance: async () => ({
      data: [
        {
          details: [
            { ccy: 'UNI', availBal: '6.5278928', cashBal: '6.5278928' },
            { ccy: 'USDT', availBal: '1000', cashBal: '1000' },
          ],
        },
      ],
    }),
  };

  const freeUni = await getExchangeFreeBalance(mockOkxClient, 'UNI');
  assert.equal(freeUni, 6.5278928);
});

test('createBotExchangeOrderWithRecovery clamps sell amount to free exchange balance', async () => {
  const { createBotExchangeOrderWithRecovery } = await import('./bot/botRunnerLoop');
  let placedAmount = 0;
  const mockClient = {
    id: 'binance',
    fetchBalance: async () => ({
      free: { UNI: 127.71895 },
      used: { UNI: 0 },
      total: { UNI: 127.71895 },
    }),
    createOrder: async (_symbol: string, _type: string, _side: string, amount: number) => {
      placedAmount = amount;
      return { id: 'order-123', status: 'closed', filled: amount };
    },
  };

  const mockBot = {
    id: 'bot-1',
    uid: 'u-1',
    botId: 'bot-1',
    pair: 'UNI/USDT',
    mode: 'testnet',
  } as any;

  // Bot requests to sell 127.846798, but exchange only has 127.71895
  const result = await createBotExchangeOrderWithRecovery(
    mockClient,
    mockBot,
    'sell',
    127.846798,
    'client-order-1',
    Date.now(),
    true, // allowManualClose to bypass lease check
    7.5,
  );

  assert.equal(placedAmount, 127.71895);
  assert.equal(result.filled, 127.71895);
});

test('createBotExchangeOrderWithRecovery throws POSITION_EXHAUSTED_ON_EXCHANGE when free balance is zero', async () => {
  const { createBotExchangeOrderWithRecovery } = await import('./bot/botRunnerLoop');
  const mockClient = {
    id: 'binance',
    fetchBalance: async () => ({
      free: { UNI: 0 },
      used: { UNI: 0 },
      total: { UNI: 0 },
    }),
    createOrder: async () => {
      throw new Error('should not be called');
    },
  };

  const mockBot = {
    id: 'bot-1',
    uid: 'u-1',
    botId: 'bot-1',
    pair: 'UNI/USDT',
    mode: 'testnet',
  } as any;

  await assert.rejects(
    async () => {
      await createBotExchangeOrderWithRecovery(
        mockClient,
        mockBot,
        'sell',
        10.0,
        'client-order-1',
        Date.now(),
        true,
        7.5,
      );
    },
    (err: any) => {
      assert.equal(err.reasonCode, 'POSITION_EXHAUSTED_ON_EXCHANGE');
      return true;
    },
  );
});

test('createBotExchangeOrderWithRecovery retries sell on INSUFFICIENT_BALANCE with true free balance', async () => {
  const { createBotExchangeOrderWithRecovery } = await import('./bot/botRunnerLoop');
  let attempts = 0;
  let finalPlacedAmount = 0;
  let currentBalance = 100; // initially reported 100, but fails on exchange

  const mockClient = {
    id: 'binance',
    fetchBalance: async () => ({
      free: { UNI: currentBalance },
      used: { UNI: 0 },
      total: { UNI: currentBalance },
    }),
    createOrder: async (_symbol: string, _type: string, _side: string, amount: number) => {
      attempts += 1;
      if (attempts === 1) {
        // First order throws insufficient balance, and real balance is 95
        currentBalance = 95;
        throw new Error('insufficient balance to sell');
      }
      finalPlacedAmount = amount;
      return { id: 'order-retry-ok', status: 'closed', filled: amount };
    },
  };

  const mockBot = {
    id: 'bot-1',
    uid: 'u-1',
    botId: 'bot-1',
    pair: 'UNI/USDT',
    mode: 'testnet',
  } as any;

  const result = await createBotExchangeOrderWithRecovery(
    mockClient,
    mockBot,
    'sell',
    100,
    'client-order-1',
    Date.now(),
    true,
    7.5,
  );

  assert.equal(attempts, 2);
  assert.equal(finalPlacedAmount, 95);
  assert.equal(result.id, 'order-retry-ok');
});

