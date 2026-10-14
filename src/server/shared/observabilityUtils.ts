import type { Request, Response } from 'express';

export const CLIENT_OBSERVABILITY_EVENTS = new Set([
  'auth.login.success',
  'auth.login.failed',
  'auth.logout.success',
  'auth.logout.failed',
  'auth.permission.changed',
  'auth.google.authenticated',
  'wallet.deposit.verified',
  'wallet.withdraw.submitted',
  'wallet.transfer.completed',
  'admin.action.attempted',
  'exchange.error',
  'client.render.error',
  'client.unhandled.rejection',
]);

export const WEB_VITAL_NAMES = new Set(['CLS', 'FCP', 'INP', 'LCP', 'TTFB']);

export const SAFE_OBSERVABILITY_ATTRIBUTES = new Set([
  'provider', 'enabled', 'target', 'network', 'exchange', 'symbol', 'side',
  'statusCode', 'errorName', 'errorCode', 'action', 'rating', 'metricName', 'metricId', 'value',
]);

export function getRequestId(res: Response): string {
  return String(res.getHeader('X-Request-Id') || 'unknown');
}

export function logAuditEvent(req: Request, res: Response, event: string, attributes: Record<string, string | number | boolean> = {}): void {
  console.info(JSON.stringify({
    level: 'info',
    event: 'audit',
    requestId: getRequestId(res),
    uid: res.locals?.botUid || 'anonymous',
    auditEvent: event,
    ...attributes,
  }));
}

export function sanitizeObservabilityAttributes(input: unknown): Record<string, string | number | boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const safeAttributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_OBSERVABILITY_ATTRIBUTES.has(key)) continue;
    if (typeof value === 'string' && value.length <= 64) safeAttributes[key] = value;
    else if (typeof value === 'boolean') safeAttributes[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) safeAttributes[key] = value;
  }
  return safeAttributes;
}

export function apiErrorHandler(err: any, req: Request, res: Response, _next: (err?: any) => void): void {
  const statusCode = Number.isInteger(err?.statusCode || err?.status) && Number(err?.statusCode || err?.status) >= 400 && Number(err?.statusCode || err?.status) <= 599
    ? Number(err.statusCode || err.status)
    : 500;
  const code = err?.code || (statusCode < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
  const userMessage = err?.userMessage || err?.message || 'Terjadi kendala pada sistem.';
  if (statusCode >= 500) {
    console.error(`[API_ERROR_5XX] ${req.method} ${req.path} (${statusCode}):`, err?.stack || err);
  }
  if (res.headersSent) return;
  res.status(statusCode).json({
    success: false,
    error: userMessage,
    code,
    requestId: getRequestId(res),
  });
}
