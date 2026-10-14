import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PriceAlert } from '../types';
import {
  getLocalPriceAlerts,
  setLocalPriceAlerts,
  savePriceAlert,
  updatePriceAlert,
  deletePriceAlert,
  checkPriceAlerts,
  subscribeToPriceAlerts,
} from './priceAlertService';

// Mock localStorage for Node environment if absent
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, val: string) => store.set(key, val),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };
}

test('PriceAlertService - LocalStorage CRUD operations & fallback', async () => {
  localStorage.clear();

  const sampleAlert: PriceAlert = {
    id: 'alert-test-1',
    symbol: 'BTC/USDT',
    coin: 'BTC',
    targetPrice: 95000,
    condition: 'above',
    initialPrice: 90000,
    status: 'active',
    createdAt: Date.now(),
    isRepeating: false,
    notificationSent: false,
  };

  // 1. Save alert
  await savePriceAlert(null, sampleAlert);
  const alertsAfterSave = getLocalPriceAlerts();
  assert.equal(alertsAfterSave.length, 1);
  assert.equal(alertsAfterSave[0].symbol, 'BTC/USDT');
  assert.equal(alertsAfterSave[0].targetPrice, 95000);

  // 2. Update alert
  await updatePriceAlert(null, 'alert-test-1', { targetPrice: 96000, status: 'disabled' });
  const alertsAfterUpdate = getLocalPriceAlerts();
  assert.equal(alertsAfterUpdate[0].targetPrice, 96000);
  assert.equal(alertsAfterUpdate[0].status, 'disabled');

  // 3. Delete alert
  await deletePriceAlert(null, 'alert-test-1');
  const alertsAfterDelete = getLocalPriceAlerts();
  assert.equal(alertsAfterDelete.length, 0);
});

test('PriceAlertService - Price threshold check triggers alert correctly', () => {
  localStorage.clear();

  const activeAlert: PriceAlert = {
    id: 'alert-test-2',
    symbol: 'ETH/USDT',
    coin: 'ETH',
    targetPrice: 3000,
    condition: 'above',
    initialPrice: 2800,
    status: 'active',
    createdAt: Date.now(),
    isRepeating: false,
    notificationSent: false,
  };

  setLocalPriceAlerts([activeAlert]);

  // Market price is 2900 (not triggered)
  const result1 = checkPriceAlerts([activeAlert], { 'ETH/USDT': 2900 }, null);
  assert.equal(result1[0].status, 'active');
  assert.equal(result1[0].notificationSent, false);

  // Market price reaches 3050 (triggered!)
  let triggeredCount = 0;
  const result2 = checkPriceAlerts([activeAlert], { 'ETH/USDT': 3050 }, null, (alert) => {
    triggeredCount++;
    assert.equal(alert.symbol, 'ETH/USDT');
  });

  assert.equal(triggeredCount, 1);
  assert.equal(result2[0].status, 'triggered');
  assert.equal(result2[0].notificationSent, true);
  assert.equal(result2[0].triggeredPrice, 3050);
});

test('PriceAlertService - Subscribe to alerts notifies live updates immediately', async () => {
  localStorage.clear();

  let receivedAlerts: PriceAlert[] = [];
  const unsub = subscribeToPriceAlerts('test-user-sub', (alerts) => {
    receivedAlerts = alerts;
  });

  assert.equal(receivedAlerts.length, 0);

  // Save new alert
  const newAlert: PriceAlert = {
    id: 'alert-live-1',
    symbol: 'SOL/USDT',
    coin: 'SOL',
    targetPrice: 200,
    condition: 'above',
    initialPrice: 180,
    status: 'active',
    createdAt: Date.now(),
    isRepeating: false,
    notificationSent: false,
  };

  await savePriceAlert('test-user-sub', newAlert);

  assert.equal(receivedAlerts.length, 1);
  assert.equal(receivedAlerts[0].symbol, 'SOL/USDT');

  unsub();
});
