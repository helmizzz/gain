import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../shared/apiError';
import {
  CLIENT_OBSERVABILITY_EVENTS,
  WEB_VITAL_NAMES,
  getRequestId,
  sanitizeObservabilityAttributes,
} from '../shared/observabilityUtils';
import {
  SERVER_STARTED_AT,
  serverState,
  getHealthSnapshot,
} from '../shared/serverState';
import { redisAvailable } from '../redis';

const router = Router();

router.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000) });
});

router.get('/readyz', async (_req: Request, res: Response) => {
  const isDev = process.env.NODE_ENV !== 'production';
  const redisRequired = process.env.REDIS_REQUIRED === 'true' && !isDev;
  const redisReady = !redisRequired || await redisAvailable();
  const dbRequired = (process.env.DATABASE_REQUIRED === 'true' || !isDev) && serverState.databaseFailureCode !== undefined;
  const ready = serverState.persistenceReady && (!dbRequired || serverState.databaseReady) && redisReady;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    persistenceReady: serverState.persistenceReady,
    databaseReady: serverState.databaseReady,
    redisReady,
    failureCode: ready ? undefined : (serverState.databaseFailureCode || serverState.persistenceFailureCode || (!redisReady ? 'REDIS_UNAVAILABLE' : undefined)),
  });
});

router.get('/api/health', (_req: Request, res: Response) => {
  res.json(getHealthSnapshot());
});

router.post('/api/observability/client-event', (req: Request, res: Response, next: NextFunction) => {
  const event = typeof req.body?.event === 'string' ? req.body.event : '';
  if (!CLIENT_OBSERVABILITY_EVENTS.has(event)) {
    return next(new ApiError(400, 'OBSERVABILITY_EVENT_INVALID', 'validation', 'Client event is not allowlisted.'));
  }

  console.info('[CLIENT_REPORTED_EVENT]', {
    requestId: getRequestId(res),
    source: 'untrusted_client_report',
    event,
    attributes: sanitizeObservabilityAttributes(req.body?.attributes),
  });
  res.status(202).json({ success: true });
});

router.post('/api/observability/web-vital', (req: Request, res: Response, next: NextFunction) => {
  const { name, value, rating, id } = req.body || {};
  if (!WEB_VITAL_NAMES.has(name) || !Number.isFinite(value) || value < 0 || value > 120000
    || !['good', 'needs-improvement', 'poor'].includes(rating)
    || typeof id !== 'string' || id.length > 64) {
    return next(new ApiError(400, 'WEB_VITAL_INVALID', 'validation', 'Web Vital payload is invalid.'));
  }

  console.info('[WEB_VITAL]', {
    requestId: getRequestId(res),
    name,
    value: Number(value.toFixed(3)),
    rating,
  });
  res.status(202).json({ success: true });
});

export default router;
