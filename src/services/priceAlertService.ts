import { PriceAlert } from '../types';
import { isDemoMode } from '../config/appMode';
import { sendBrowserNotification, playAlertChime } from './notificationService';
import { formatUsdt } from '../utils/formatters';

const LOCAL_STORAGE_KEY = 'gain_price_alerts_v1';

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;
}

function thresholdMet(alert: PriceAlert, currentPrice: number): boolean {
  return alert.condition === 'above'
    ? currentPrice >= alert.targetPrice
    : currentPrice <= alert.targetPrice;
}


/**
 * Get cached local alerts fallback
 */
export function getLocalPriceAlerts(): PriceAlert[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

type PriceAlertSubscriber = (alerts: PriceAlert[]) => void;
const subscribers = new Set<PriceAlertSubscriber>();

function broadcastPriceAlerts(): void {
  const current = getLocalPriceAlerts();
  subscribers.forEach((callback) => {
    try {
      callback(current);
    } catch (err) {
      console.error('[PRICE_ALERT_BROADCAST_ERROR]', err);
    }
  });
}

/**
 * Save cached local alerts and notify all live UI subscribers
 */
export function setLocalPriceAlerts(alerts: PriceAlert[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(alerts));
    broadcastPriceAlerts();
  } catch {
    // Ignore storage quota error
  }
}

function mergeAlerts(remote: PriceAlert[], local: PriceAlert[]): PriceAlert[] {
  const alertMap = new Map<string, PriceAlert>();
  for (const item of local) {
    if (item && item.id) alertMap.set(item.id, item);
  }
  for (const item of remote) {
    if (item && item.id) alertMap.set(item.id, item);
  }
  const merged = Array.from(alertMap.values());
  merged.sort((a, b) => b.createdAt - a.createdAt);
  return merged;
}

function getActiveCloudUid(): string | null {
  // Phase 3: Firebase removed. Backend sync to be implemented via API if needed.
  return null;
}

/**
 * Subscribe to real-time Price Alerts from Firestore & LocalStorage
 */
export function subscribeToPriceAlerts(
  userId: string | null | undefined,
  onUpdate: (alerts: PriceAlert[]) => void
): () => void {
  // 1. Always register subscriber & push current local projection immediately
  subscribers.add(onUpdate);
  onUpdate(getLocalPriceAlerts());

  return () => {
    subscribers.delete(onUpdate);
  };
}

/**
 * Add or update a price alert in Firestore & local cache
 */
export async function savePriceAlert(
  userId: string | null | undefined,
  alert: PriceAlert
): Promise<void> {
  // Always update LocalStorage projection immediately for zero latency
  const currentLocal = getLocalPriceAlerts().filter((item) => item.id !== alert.id);
  const updatedLocal = [alert, ...currentLocal];
  setLocalPriceAlerts(updatedLocal);
}

/**
 * Delete a price alert
 */
export async function deletePriceAlert(
  userId: string | null | undefined,
  alertId: string
): Promise<void> {
  const updatedLocal = getLocalPriceAlerts().filter((alert) => alert.id !== alertId);
  setLocalPriceAlerts(updatedLocal);
}

/**
 * Update a price alert status / properties
 */
export async function updatePriceAlert(
  userId: string | null | undefined,
  alertId: string,
  updates: Partial<PriceAlert>
): Promise<void> {
  const updatedLocal = getLocalPriceAlerts().map((alert) =>
    alert.id === alertId ? { ...alert, ...updates } : alert
  );
  setLocalPriceAlerts(updatedLocal);
}

/**
 * Evaluate price alerts against real-time tickers and trigger notifications
 */
export function checkPriceAlerts(
  alerts: PriceAlert[],
  currentPrices: Record<string, number>,
  userId: string | null | undefined,
  onTriggered?: (alert: PriceAlert, triggeredPrice: number) => void
): PriceAlert[] {
  let hasChanges = false;
  const updatedAlerts = alerts.map((alert) => {
    if (alert.status !== 'active') return alert;

    const currentPrice = currentPrices[alert.symbol];
    if (typeof currentPrice !== 'number' || currentPrice <= 0) return alert;

    const isTriggered = thresholdMet(alert, currentPrice);

    // Repeating alert is edge-triggered: fire once while inside the threshold,
    // then re-arm only after price moves back outside the threshold.
    if (alert.isRepeating && alert.notificationSent && isTriggered) {
      return alert;
    }

    if (!isTriggered) {
      if (alert.isRepeating && alert.notificationSent) {
        const rearmed: PriceAlert = { ...alert, notificationSent: false };
        updatePriceAlert(userId, alert.id, { notificationSent: false }).catch((error) =>
          console.error('[PRICE_ALERT_REARM_FAILED]', error)
        );
        return rearmed;
      }
      return alert;
    }

    if (isTriggered) {
      hasChanges = true;
      const triggeredAt = Date.now();
      const updated: PriceAlert = {
        ...alert,
        status: alert.isRepeating ? 'active' : 'triggered',
        triggeredAt,
        triggeredPrice: currentPrice,
        notificationSent: true,
      };

      // 1. Play pleasant audio chime
      playAlertChime();

      // 2. Send native browser notification
      const conditionText =
        alert.condition === 'above' ? 'naik melampaui' : 'turun menembus';
      const title = `🚨 Target Harga ${alert.symbol}: $${formatUsdt(currentPrice)}!`;
      const body = `Harga ${alert.symbol} telah ${conditionText} target Anda ($${formatUsdt(alert.targetPrice)}). Waktu: ${new Date(triggeredAt).toLocaleTimeString('id-ID')}.`;

      sendBrowserNotification(title, {
        body,
        tag: `price-alert-${alert.id}`,
      });

      // 3. Callback for in-app toast / banner
      if (onTriggered) {
        onTriggered(updated, currentPrice);
      }

      // 4. Update in Firestore / LocalStorage
      updatePriceAlert(userId, alert.id, {
        status: updated.status,
        triggeredAt,
        triggeredPrice: currentPrice,
        notificationSent: true,
      }).catch((error) => console.error('[PRICE_ALERT_UPDATE_FAILED]', error));

      return updated;
    }

    return alert;
  });

  return hasChanges ? updatedAlerts : alerts;
}
