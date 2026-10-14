import 'dotenv/config';
import dotenv from 'dotenv';
if (process.env.BINANCE_TESTNET_ALLOW_INSECURE_TLS === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
import { randomUUID } from 'crypto';
import { ApiError } from './src/server/shared/apiError';
import { apiErrorHandler } from './src/server/shared/observabilityUtils';
import {
  serverState,
  activeBotsRegistry,
  apiRequestMetrics,
} from './src/server/shared/serverState';
import { isStartupAutoResumeEnabled } from './src/services/botRecovery';
import v2EngineApi from './src/v2/api/v2EngineApi';
import observabilityRoutes from './src/server/routes/observabilityRoutes';
import authRoutes from './src/server/routes/authRoutes';
import accountRoutes from './src/server/routes/accountRoutes';
import walletRoutes from './src/server/routes/walletRoutes';
import exchangeRoutes from './src/server/routes/exchangeRoutes';
import botRoutes from './src/server/routes/botRoutes';
import { createServer as createViteServer } from 'vite';
import { SERVER_INSTANCE_ID, startBotEngineLoop, stopBotEngineLoop, restoreBotRunners, releaseBotLease } from './src/server/bot/botRunnerLoop';
import {
  dbQuery,
  checkDatabase,
  createAuditEvent,
  getSystemSetting,
  processGasAutoRefills,
  listNativeBscWithdrawalCandidates,
  claimNativeBscWithdrawal,
  recordNativeBscWithdrawalSent,
  settleNativeBscWithdrawal,
  failNativeBscWithdrawal,
} from './src/server/database';
import {
  scanNativeBscDeposits,
  getNativeWalletStatus,
  processNativeWithdrawal,
  waitForNativeBscReceipt,
} from './src/server/nativeBscWallet';
import { setRuntimeLiveTradingEnabled, backfillExchangeAccountIdentityMetadata } from './src/server/shared/exchangeUtils';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import { requireFirebaseIdentity, checkRedisRateLimit } from './src/server/shared/authUtils';
import { SUPPORTED_COINS } from './src/data/appData';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const requestRateLimitMap = new Map<string, { count: number; resetTime: number }>();
const IS_DEVELOPMENT = process.env.NODE_ENV !== 'production';
const ALLOWED_CORS_ORIGINS = new Set(
  (
    process.env.CORS_ALLOWED_ORIGINS ||
    (IS_DEVELOPMENT ? 'http://localhost:3000,http://127.0.0.1:3000,https://localhost:3000,https://127.0.0.1:3000' : '')
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const BOT_STARTUP_AUTO_RESUME = isStartupAutoResumeEnabled(
  process.env.BOT_STARTUP_AUTO_RESUME,
  process.env.BOT_STARTUP_AUTO_RESUME_CONFIRM,
);
const SECURITY_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
  `script-src 'self' https://apis.google.com https://accounts.google.com${IS_DEVELOPMENT ? " 'unsafe-inline' 'unsafe-eval'" : ''}`,
  "img-src 'self' data: https:",
  `connect-src 'self' https: wss://stream.binance.com:9443 wss://stream.testnet.binance.vision wss://data-stream.binance.vision https://accounts.google.com${IS_DEVELOPMENT ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
  "font-src 'self' data: https://fonts.gstatic.com",
  "frame-src 'self' https://accounts.google.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self' https://*.google.com https://*.googleusercontent.com https://*.run.app",
  "form-action 'self'",
].join('; ');

let httpServer: ReturnType<typeof app.listen> | undefined;
let viteServer: any;
let financialWorkerInterval: NodeJS.Timeout | undefined;
let nativeCustodyInterval: NodeJS.Timeout | undefined;
let nativeCustodyCycleRunning = false;

async function checkGlobalRequestRateLimit(key: string, maxRequests: number = 120, windowMs: number = 60000): Promise<boolean> {
  const isDev = process.env.NODE_ENV !== 'production' || key.includes('127.0.0.1') || key.includes('::1') || key.includes('localhost') || key.includes('::ffff:');
  if (isDev) {
    const now = Date.now();
    const entry = requestRateLimitMap.get(key);
    if (!entry || now > entry.resetTime) {
      requestRateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
      return true;
    }
    if (entry.count >= 10000) return false;
    entry.count += 1;
    return true;
  }
  const effectiveMax = maxRequests;
  const redisAllowed = await checkRedisRateLimit(`global:${key}`, effectiveMax, Math.ceil(windowMs / 1000));
  if (!redisAllowed) return false;
  const now = Date.now();
  const entry = requestRateLimitMap.get(key);
  if (!entry || now > entry.resetTime) {
    requestRateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }
  if (entry.count >= effectiveMax) return false;
  entry.count += 1;
  return true;
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (ALLOWED_CORS_ORIGINS.has(parsed.origin)) return true;
    if (parsed.hostname.endsWith('.run.app') || parsed.hostname.endsWith('.google.com') || parsed.hostname.endsWith('.googleusercontent.com')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

app.disable('x-powered-by');
app.set('trust proxy', true); // Trust proxy to get the real client IP for rate limiting
app.options('*', (req: Request, res: Response) => {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
  res.sendStatus(204);
});

app.use(async (req: Request, res: Response, next: NextFunction) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  const requestStartedAt = performance.now();
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', SECURITY_CSP);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');

  res.on('finish', () => {
    if (!req.path.startsWith('/api/')) return;
    const durationMs = Math.max(0, performance.now() - requestStartedAt);
    const routePath = req.route?.path ? `${req.baseUrl}${req.route.path}` : '/api/unmatched';
    const metricKey = `${req.method} ${routePath}`;
    const previous = apiRequestMetrics.get(metricKey) || { count: 0, failures: 0, totalDurationMs: 0, slowRequests: 0 };
    previous.count += 1;
    previous.failures += res.statusCode >= 500 ? 1 : 0;
    previous.totalDurationMs += durationMs;
    previous.slowRequests += durationMs >= 1500 ? 1 : 0;
    apiRequestMetrics.set(metricKey, previous);

    if (res.statusCode >= 500 || durationMs >= 1500) {
      console.warn('[API_METRIC]', {
        requestId,
        method: req.method,
        route: routePath,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
      });
    }
  });

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const referer = typeof req.headers.referer === 'string' ? req.headers.referer : '';
    const sameOrigin = !origin || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
    let validReferer = !referer;
    if (referer) {
      try {
        const refererOrigin = new URL(referer).origin;
        validReferer = refererOrigin === origin || isAllowedOrigin(refererOrigin);
      } catch {
        validReferer = false;
      }
    }

    if (origin && !sameOrigin && !isAllowedOrigin(origin)) {
      return next(
        new ApiError(
          403,
          'CROSS_ORIGIN_FORBIDDEN',
          'security',
          'Cross-origin requests are not allowed for state-changing operations.',
          'Permintaan lintas origin tidak diizinkan untuk operasi berbahaya.',
        ),
      );
    }

    if (origin && !sameOrigin && !validReferer) {
      return next(
        new ApiError(403, 'INVALID_REFERER', 'security', 'Missing or invalid referer for state-changing request.', 'Referer tidak valid untuk permintaan yang mengubah state.'),
      );
    }
  }

  if (!req.path.startsWith('/api/')) return next();

  const rateLimitScope =
    req.path === '/api/account/state'
      ? 'account-state'
      : req.path === '/api/bot/engine-status'
        ? 'bot-status'
        : req.path === '/api/exchange/fetch-tickers-batch'
          ? 'market-ticker'
          : 'general';

  const rateLimitMax =
    rateLimitScope === 'market-ticker'
      ? 1200
      : rateLimitScope === 'bot-status'
        ? 600
        : rateLimitScope === 'account-state'
          ? 300
          : 600;

  const rateLimitKey = `${clientIp}:${rateLimitScope}`;

  if (!(await checkGlobalRequestRateLimit(rateLimitKey, rateLimitMax, 60000))) {
    const error = new ApiError(429, 'RATE_LIMITED', 'rate_limit', 'Request rate limit exceeded.', 'Terlalu banyak permintaan. Silakan tunggu sebentar.');
    console.warn('[SECURITY] Rate limit exceeded', { clientIp, rateLimitScope, rateLimitMax, requestId });
    return next(error);
  }

  next();
});

app.use('/api/exchange', (req: Request, _res: Response, next: NextFunction) => {
  if (req.method === 'GET' && (req.query.apiKey || req.query.secret || req.query.password)) {
    return next(
      new ApiError(
        400,
        'CREDENTIALS_IN_URL',
        'validation',
        'Exchange credentials must not be sent in URL query parameters.',
        'Kredensial API tidak diizinkan dikirim melalui URL.',
      ),
    );
  }
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use('/api/v2/engine', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    if (!(await checkRedisRateLimit(`v2:${identity.uid}`, 120, 60))) {
      return next(new ApiError(429, 'V2_RATE_LIMITED', 'rate_limit', 'V2 engine rate limit exceeded.', 'Rate limit V2 engine terlampaui.'));
    }
    res.locals.v2Uid = identity.uid;
    next();
  } catch (error) {
    next(error);
  }
}, v2EngineApi);

app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.body === undefined || req.body === null) return next();
  if (typeof req.body !== 'object' || Array.isArray(req.body)) {
    return next(new ApiError(400, 'INVALID_JSON_BODY', 'validation', 'Request body must be a JSON object.', 'Format body request tidak valid.'));
  }
  const payloadSize = Buffer.byteLength(JSON.stringify(req.body), 'utf8');
  if (payloadSize > 100000) {
    return next(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'validation', 'Request body is too large.', 'Payload terlalu besar.'));
  }
  next();
});

app.use(express.static(path.join(process.cwd(), 'public')));

app.use(observabilityRoutes);
app.use(authRoutes);
app.use(accountRoutes);
app.use(walletRoutes);
app.use(exchangeRoutes);
app.use(botRoutes);

app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
  next(new ApiError(404, 'API_ROUTE_NOT_FOUND', 'not_found', `API route not found: ${req.method} ${req.path}`, 'Endpoint tidak ditemukan.'));
});

async function syncConfiguredAdminClaims(): Promise<void> {}

async function runNativeCustodyCycle(): Promise<void> {
  if (nativeCustodyCycleRunning || !serverState.databaseReady || serverState.shutdownRequested) return;
  nativeCustodyCycleRunning = true;
  try {
    const minConfirmations = Math.max(1, Number(process.env.BSC_MIN_CONFIRMATIONS || 12));
    if (process.env.BSC_NATIVE_DEPOSIT_SCANNER_ENABLED !== 'false') {
      try {
        const scan = await scanNativeBscDeposits(minConfirmations);
        if (scan.matched > 0) console.log(JSON.stringify({ event: 'native_bsc.deposit_scan', ...scan }));
      } catch (error) {
        console.warn('[NATIVE_BSC_DEPOSIT_SCAN_FAILED]', String((error as any)?.message || error));
      }
    }

    const native = await getNativeWalletStatus();
    if (process.env.BSC_NATIVE_WITHDRAWAL_ENABLED === 'false' || !native.autoWithdrawalEnabled) return;
    const candidates = await listNativeBscWithdrawalCandidates(5);
    for (const candidate of candidates) {
      const claim = await claimNativeBscWithdrawal(String(candidate.id), `native-bsc:${SERVER_INSTANCE_ID}`);
      if (!claim) continue;
      
      let txHash = claim.tx_hash ? String(claim.tx_hash).toLowerCase() : '';
      let hotWalletAddress = '';

      try {
        if (!txHash) {
          const sent = await processNativeWithdrawal({
            id: String(claim.id),
            destinationAddress: String(claim.destination_address),
            netAmount: String(claim.net_amount),
          });
          txHash = sent.txHash.toLowerCase();
          hotWalletAddress = sent.hotWalletAddress;
          await recordNativeBscWithdrawalSent({
            withdrawalId: String(claim.id),
            claimId: String(claim.claimId),
            txHash,
            hotWalletAddress,
          });
        }

        const receipt = await waitForNativeBscReceipt(txHash);
        if (!receipt) {
          // Transaction was broadcast and txHash is recorded, but receipt timed out.
          // CRITICAL: NEVER fail or refund on timeout! The transaction is already in the BSC mempool.
          // Leaving status as 'SENT' allows the next worker cycle to re-query the receipt safely.
          console.warn(`[NATIVE_BSC_WITHDRAWAL_IN_FLIGHT] Withdrawal ${claim.id} (tx: ${txHash}) waiting for block confirmation.`);
          continue;
        }

        if (String(receipt.status || '0x1').toLowerCase() !== '0x1') {
          throw new Error('BSC transaction reverted on-chain (status 0x0).');
        }

        const result = await settleNativeBscWithdrawal({
          withdrawalId: String(claim.id),
          claimId: String(claim.claimId),
          txHash,
          metadata: {
            sourceAddress: hotWalletAddress || candidate.source_address,
            destinationAddress: candidate.destination_address,
            amount: candidate.net_amount,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            nativeBsc: true,
          },
        });
        await createAuditEvent({
          eventType: 'financial.native_bsc.withdrawal.sent',
          payload: {
            withdrawalId: String(claim.id),
            txHash,
            destinationAddress: candidate.destination_address,
            amount: candidate.net_amount,
            status: result.status,
          },
        });
      } catch (error) {
        const reason = String((error as any)?.message || error).slice(0, 500);
        const isRevert = reason.includes('reverted on-chain');
        if (!txHash || isRevert) {
          try {
            await failNativeBscWithdrawal(String(claim.id), String(claim.claimId), reason);
          } catch (rollbackError) {
            console.error('[NATIVE_BSC_WITHDRAWAL_ROLLBACK_FAILED]', String((rollbackError as any)?.message || rollbackError));
          }
          await createAuditEvent({
            eventType: 'financial.native_bsc.withdrawal.failed',
            payload: { withdrawalId: String(claim.id), reason, txHash: txHash || undefined },
          }).catch(() => {});
        } else {
          console.error(`[NATIVE_BSC_WITHDRAWAL_UNCONFIRMED_ERROR] Withdrawal ${claim.id} (tx: ${txHash}): ${reason}. Holding in-flight.`);
        }
      }
    }
  } finally {
    nativeCustodyCycleRunning = false;
  }
}

async function startServer() {
  await syncConfiguredAdminClaims();
  const dbHealth = await checkDatabase();
  serverState.databaseReady = dbHealth.ok;
  serverState.databaseFailureCode = dbHealth.ok ? undefined : dbHealth.error || 'DATABASE_UNAVAILABLE';
  if (serverState.databaseReady) {
    try {
      await dbQuery(`ALTER TABLE exchange_accounts ADD COLUMN IF NOT EXISTS identity_key text`);
      await dbQuery(`ALTER TABLE exchange_accounts ADD COLUMN IF NOT EXISTS identity_type text`);
      await dbQuery(`ALTER TABLE exchange_accounts ADD COLUMN IF NOT EXISTS identity_hint text`);
      await dbQuery(`ALTER TABLE exchange_accounts ADD COLUMN IF NOT EXISTS credential_fingerprint text`);
      await dbQuery(`ALTER TABLE exchange_accounts ADD COLUMN IF NOT EXISTS reported_identity_key text`);
      await dbQuery(`ALTER TABLE exchange_accounts ADD COLUMN IF NOT EXISTS credential_version integer NOT NULL DEFAULT 1`);
      await dbQuery(`CREATE TABLE IF NOT EXISTS exchange_credential_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, exchange text NOT NULL, sandbox boolean NOT NULL DEFAULT true, action text NOT NULL, previous_version integer, new_version integer NOT NULL, previous_credential_fingerprint text, new_credential_fingerprint text NOT NULL, previous_identity_key text, new_identity_key text NOT NULL, previous_reported_identity_key text, new_reported_identity_key text, previous_identity_type text, new_identity_type text, created_at timestamptz NOT NULL DEFAULT now())`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_exchange_credential_history_user_time ON exchange_credential_history(user_id, created_at DESC)`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_exchange_accounts_identity_lookup ON exchange_accounts(lower(exchange), sandbox, identity_key) WHERE status='ACTIVE' AND identity_key IS NOT NULL`);
      await dbQuery(`CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_accounts_active_identity ON exchange_accounts(lower(exchange), sandbox, identity_key) WHERE status='ACTIVE' AND identity_key IS NOT NULL`);
      await dbQuery(`CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_accounts_active_credential_fingerprint ON exchange_accounts(lower(exchange), sandbox, credential_fingerprint) WHERE status='ACTIVE' AND credential_fingerprint IS NOT NULL`);
      await dbQuery(`CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_accounts_active_reported_identity ON exchange_accounts(lower(exchange), sandbox, reported_identity_key) WHERE status='ACTIVE' AND reported_identity_key IS NOT NULL`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_exchange_accounts_user_status ON exchange_accounts(user_id, status, updated_at DESC)`);
      await backfillExchangeAccountIdentityMetadata();
    } catch (error) {
      console.warn('[EXCHANGE_IDENTITY_SCHEMA_INIT_FAILED]', String((error as any)?.message || error));
    }
    try {
      await dbQuery(`CREATE TABLE IF NOT EXISTS auth_verification_challenges (
        firebase_uid TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('login', 'email')),
        code_hash BYTEA NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        sent_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (firebase_uid, kind)
      )`);
      await dbQuery(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='auth_verification_challenges' AND column_name='code_hash' AND data_type <> 'bytea') THEN
            ALTER TABLE auth_verification_challenges
              ALTER COLUMN code_hash TYPE BYTEA USING decode(code_hash::text, 'hex');
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='auth_verification_challenges' AND column_name='expires_at' AND data_type <> 'timestamp with time zone') THEN
            ALTER TABLE auth_verification_challenges
              ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING to_timestamp((expires_at::double precision) / 1000.0);
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='auth_verification_challenges' AND column_name='sent_at' AND data_type <> 'timestamp with time zone') THEN
            ALTER TABLE auth_verification_challenges
              ALTER COLUMN sent_at TYPE TIMESTAMPTZ USING to_timestamp((sent_at::double precision) / 1000.0);
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='auth_verification_challenges' AND column_name='updated_at' AND data_type <> 'timestamp with time zone') THEN
            ALTER TABLE auth_verification_challenges
              ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING to_timestamp((updated_at::double precision) / 1000.0);
          END IF;
        END $$;
      `);
      await dbQuery(`CREATE TABLE IF NOT EXISTS auth_session_elevations (
        token_hash TEXT PRIMARY KEY,
        firebase_uid TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await dbQuery(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_name='auth_session_elevations'
               AND column_name='expires_at'
               AND data_type <> 'timestamp with time zone'
          ) THEN
            ALTER TABLE auth_session_elevations
              ALTER COLUMN expires_at TYPE TIMESTAMPTZ
              USING to_timestamp((expires_at::double precision) / 1000.0);
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_name='auth_session_elevations'
               AND column_name='created_at'
               AND data_type <> 'timestamp with time zone'
          ) THEN
            ALTER TABLE auth_session_elevations
              ALTER COLUMN created_at TYPE TIMESTAMPTZ
              USING to_timestamp((created_at::double precision) / 1000.0);
          END IF;
        END $$;
      `);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_auth_session_elevations_uid_expires
        ON auth_session_elevations (firebase_uid, expires_at)`);
    } catch (error) {
      console.warn('[OTP_DURABLE_SCHEMA_INIT_FAILED]', String((error as any)?.message || error));
    }
    try {
      const persisted = await getSystemSetting<{enabled?:boolean}>('live_trading_enabled');
      if (typeof persisted?.enabled === 'boolean') setRuntimeLiveTradingEnabled(process.env.LIVE_TRADING_ENABLED === 'true' && persisted.enabled);
    } catch (error) {
      console.warn('[LIVE_GATE_LOAD_FAILED]', String((error as any)?.message || error));
    }
  }

  try {
    if (!serverState.databaseReady) throw Object.assign(new Error(serverState.databaseFailureCode), { code: serverState.databaseFailureCode });
    try {
      await restoreBotRunners();
    } catch (restoreErr) {
      console.warn('[BOT_STATE_RESTORE_NOTICE]', String((restoreErr as any)?.message || restoreErr));
    }
    serverState.persistenceReady = true;
    serverState.persistenceFailureCode = undefined;
  } catch (error) {
    const errorCode = typeof (error as { code?: unknown })?.code === 'string'
      ? String((error as { code: string }).code).slice(0, 64)
      : 'BOT_STATE_RESTORE_FAILED';
    serverState.persistenceFailureCode = errorCode;
    console.error(
      JSON.stringify({
        event: 'bot.state.restore_failed',
        errorCode,
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      }),
    );
  }

  if (process.env.NODE_ENV !== 'production') {
    viteServer = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(viteServer.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.use(apiErrorHandler);

  httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`GAIN Server listening on 0.0.0.0:${PORT}; open http://localhost:${PORT}`);
    // Bot startup resume policy: MANUAL_RESUME_REQUIRED | BOT_STARTUP_AUTO_RESUME_DISABLED | STARTUP_RESUME_REQUIRED
    console.log(
      `[GAIN] Bot auto-resume: ${BOT_STARTUP_AUTO_RESUME ? 'ENABLED (bots will auto-resume after reconciliation)' : 'DISABLED (manual resume required after restart)'}`,
    );
    if (serverState.persistenceReady) startBotEngineLoop();
    if (serverState.databaseReady) {
      financialWorkerInterval = setInterval(() => {
        void processGasAutoRefills()
          .then(async (results) => {
            for (const item of results || []) {
              await createAuditEvent({
                firebaseUid: String(item.firebaseUid),
                eventType: 'wallet.gas_auto_refill.completed',
                payload: { amount: item.amount, gasReserve: item.gasReserve },
              }).catch(() => {});
            }
          })
          .catch((error) => console.warn('[GAS_AUTO_REFILL_FAILED]', String((error as any)?.message || error)));
      }, 60_000);
      nativeCustodyInterval = setInterval(() => {
        void runNativeCustodyCycle();
      }, 15_000);
      void runNativeCustodyCycle();
    }
  });
}

let serverStopping = false;
async function shutdownServer(): Promise<void> {
  if (serverStopping) return;
  serverStopping = true;
  serverState.shutdownRequested = true;
  if (financialWorkerInterval) clearInterval(financialWorkerInterval);
  if (nativeCustodyInterval) clearInterval(nativeCustodyInterval);
  stopBotEngineLoop();
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  }
  await Promise.allSettled(Array.from(activeBotsRegistry.values()).map(releaseBotLease));
  await viteServer?.close();
}

process.once('SIGTERM', () => {
  void shutdownServer();
});
process.once('SIGINT', () => {
  void shutdownServer();
});

startServer().catch(() => {
  console.error(JSON.stringify({ event: 'server.start_failed' }));
  process.exitCode = 1;
});
