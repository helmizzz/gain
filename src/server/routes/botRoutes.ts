import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiError } from '../shared/apiError';
import { logAuditEvent } from '../shared/observabilityUtils';
import { requireFirebaseIdentity, requireSecuritySession, requireAdmin, requireDatabase, requireActiveLicense } from '../shared/authUtils';
import { getExchangeDescriptor } from '../../config/exchangeRegistry';
import { activeBotsRegistry } from '../shared/serverState';
import {
  BotCredentialSchema,
  loadBotCredential,
  encryptBotCredential,
  createExchangeInstance,
  sanitizeExchangeInput,
  resolveExchangeAccountIdentity,
  normalizeExchangeCredentialConflict,
  selectOwnedBotEntries,
  LIVE_TRADING_TESTNET_ONLY,
  runtimeLiveTradingEnabled,
  setRuntimeLiveTradingEnabled,
  V2_MAX_COMMITTED_CAPITAL_USDT,
  MAX_BOT_EXPOSURE_USDT,
  withExchangeRetry,
  classifyBotExecutionError,
  GAIN_V2_ENABLED,
} from '../shared/exchangeUtils';
import {
  getExchangeCredentialHistory,
  getExchangeConnection,
  saveExchangeCredential,
  deleteExchangeCredential,
  setSystemSetting,
  rebuildBotPositionFromFills,
  upsertBotRuntime,
  createAuditEvent,
  getTwoFactorSecretRecord,
  consumeTotpCounter,
  getDurableBotPosition,
  dbQuery,
} from '../database';
import { decryptSensitiveString, verifyServerTotp } from '../shared/cryptoUtils';
import { getBotRecoveryStatus } from '../../services/botRecovery';
import { applySellFill } from '../../services/botEngineCore';
import { generateDcaLayers } from '../../v2/engines/strategy/DcaEngine';
import { generateGridLevels } from '../../v2/engines/strategy/GridEngine';
import { assessRegisteredBotRisk } from '../../utils/strategyRiskGuardrails';
import {
  ActiveBotRunner,
  BotEngineLog,
  botRegistryKey,
  deriveBotRunnerId,
  transitionBotLifecycle,
  persistBotRunner,
  deletePersistedBotRunner,
  persistBotLog,
  acquireBotLeaseForManualClose,
  releaseBotLease,
  resolveBotPendingOrder,
  applyResolvedBotOrder,
  executeBotMarketOrder,
  applyBotRealizedPnl,
  cancelBotOpenOrders,
  getPrice,
  reconcileLiveBotPosition,
  v2WebSocketManager,
  botEngineLogs,
} from '../bot/botRunnerLoop';

const router = Router();

const BOT_STARTUP_AUTO_RESUME = process.env.BOT_STARTUP_AUTO_RESUME === 'true';

const CoinPairSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/);
const BotRegisterSchema = z.object({
  botId: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  botName: z.string().trim().max(100).optional(),
  pair: CoinPairSchema.default('BTC/USDT'),
  pairedCoins: z.array(CoinPairSchema).min(1).max(20).optional(),
  botMode: z.enum(['Avarage Only', 'Grid Only', 'Avarage+Grid']).default('Avarage Only'),
  baseAmount: z.coerce.number().min(0.00000001).default(35),
  baseTp: z.coerce.number().min(0.1).max(50).default(1.5),
  useMoneyManagement: z.boolean().default(true),
  averagingLayers: z.coerce.number().int().min(0).max(20).default(1),
  gridLayers: z.coerce.number().int().min(0).max(100).default(5),
  averageDownPct: z.coerce.number().min(0.1).default(1),
  uptrendFilter: z.boolean().default(true),
  uptrendThresholdPct: z.coerce.number().min(0.01).max(20).default(0.1),
  tpCallbackPct: z.coerce.number().min(0.01).max(10).default(0.2),
  layerCallbackPct: z.coerce.number().min(0.01).max(10).default(0.2),
  gridTp: z.coerce.number().min(0.1).max(50).default(1.2),
  minPrice: z.coerce.number().min(0).optional().default(0),
  maxPrice: z.coerce.number().min(0).optional().default(0),
  entryPrice: z.coerce.number().positive().optional(),
  timeframe: z.enum(['3m', '5m', '10m', '15m', '30m', '1h']).default('5m'),
  exchange: z.string().trim().transform((val) => {
    const desc = getExchangeDescriptor(val);
    return (desc ? desc.id : val).toUpperCase();
  }).pipe(z.enum(['BINANCE', 'BITGET', 'OKX', 'BYBIT', 'INDODAX', 'TOKOCRYPTO'])).default('BINANCE'),
  mode: z.enum(['testnet', 'live']).default('testnet'),
  isSandbox: z.boolean().default(true),
  availableBalanceUsdt: z.coerce.number().min(0).optional(),
  steps: z.array(z.object({
    step: z.number().optional(),
    amountUsdt: z.number().min(0),
    dropPct: z.number().optional(),
    multiplier: z.number().optional(),
    tpPct: z.number().optional(),
    status: z.string().optional(),
    isGridLayer: z.boolean().optional(),
  })).optional(),
}).refine((value) => !value.pairedCoins || new Set(value.pairedCoins).size === value.pairedCoins.length, {
  message: 'pairedCoins must not contain duplicates',
});

// Middleware to extract botUid from authentication
router.use(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith('/api/bot')) return next();
  if (res.locals.botUid) return next();

  try {
    const { identity } = await requireFirebaseIdentity(req);
    res.locals.botUid = identity.uid;
    return next();
  } catch (error) {
    // engine-status can degrade gracefully without auth (returns empty list)
    if (req.path === '/api/bot/engine-status') return next();
    return next(error);
  }
});

router.post('/api/bot/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = BotRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(new ApiError(400, 'BOT_CONFIGURATION_INVALID', 'validation', 'Bot configuration failed validation.', 'Konfigurasi bot tidak valid. Periksa simbol dan batas parameter.'));
    }

    const uid = res.locals.botUid as string;
    await requireSecuritySession(req, uid);
    const {
      botId: requestedBotId, botName, pair, pairedCoins, botMode, baseAmount, baseTp,
      useMoneyManagement, averagingLayers, gridLayers, averageDownPct, uptrendFilter,
      uptrendThresholdPct, tpCallbackPct, layerCallbackPct, gridTp, minPrice, maxPrice, entryPrice, timeframe,
      exchange, isSandbox, mode,
    } = parsed.data;

    if (mode === 'live') await requireActiveLicense(uid);
    if (mode === 'live' && !runtimeLiveTradingEnabled) {
      return next(new ApiError(403, 'LIVE_TRADING_DISABLED', 'security', 'Live trading is disabled on this server.', 'Trading live belum diaktifkan oleh administrator.'));
    }
    if (mode === 'testnet' && !isSandbox) {
      return next(new ApiError(403, 'TESTNET_REQUIRES_SANDBOX', 'security', 'Testnet bots must use an exchange sandbox/testnet endpoint.', 'Bot Testnet wajib menggunakan endpoint Testnet/Sandbox exchange.'));
    }
    if (mode === 'live' && LIVE_TRADING_TESTNET_ONLY && !isSandbox) {
      return next(new ApiError(403, 'LIVE_TRADING_TESTNET_ONLY', 'security', 'This server allows live-mode bot orders only against exchange testnet.', 'Server ini hanya mengizinkan mode live ke exchange Testnet.'));
    }
    if (mode === 'testnet' || mode === 'live') {
      const botCredential = await loadBotCredential(uid, exchange);
      if (!botCredential) {
        return next(new ApiError(409, 'BOT_CREDENTIALS_REQUIRED', 'validation', 'Encrypted exchange credentials are required for live trading.', 'Simpan kredensial exchange terlebih dahulu untuk memakai mode live.'));
      }
      if (botCredential.isSandbox !== isSandbox) {
        return next(new ApiError(409, 'BOT_EXCHANGE_MODE_MISMATCH', 'validation', 'Bot sandbox mode must match the encrypted exchange credentials.', 'Mode bot harus sama dengan mode API exchange yang tersimpan.'));
      }
    }

    if (mode === 'live' && !isSandbox) {
      const security = await getTwoFactorSecretRecord(uid);
      if (!security?.two_factor_enabled || !security.two_factor_secret_ciphertext || !security.two_factor_secret_iv || !security.two_factor_secret_auth_tag) {
        return next(new ApiError(403, 'BOT_2FA_REQUIRED', 'authorization', 'Two-factor authentication is required for live trading bots.', 'Aktifkan 2FA sebelum mendaftarkan bot trading live.'));
      }
      const otp = String(req.body?.otp2fa || req.body?.code || '').replace(/\D/g, '').trim();
      const secret = decryptSensitiveString({
        ciphertext: security.two_factor_secret_ciphertext,
        iv: security.two_factor_secret_iv,
        authTag: security.two_factor_secret_auth_tag,
      });
      const verification = verifyServerTotp(otp, secret, 1);
      if (!verification.valid || verification.counter === undefined || !(await consumeTotpCounter(uid, verification.counter))) {
        return next(new ApiError(403, 'BOT_2FA_INVALID', 'authorization', 'The TOTP code is invalid or already used.', 'Kode Google Authenticator tidak valid atau sudah digunakan.'));
      }
    }

    const currentUserExposure = Array.from(activeBotsRegistry.values())
      .filter((candidate) => candidate.uid === uid && (candidate.botId !== requestedBotId || !requestedBotId))
      .reduce((total, candidate) => total + Number(candidate.positionQty || 0) * (Number(candidate.avgEntryPrice) || Number(candidate.lastEvaluatedPrice) || 0), 0);
    const registrationRisk = assessRegisteredBotRisk({
      strategy: botMode, averagingLayers, gridLayers, baseAmount, baseTp, averageDownPct, gridProfitPct: gridTp, tpCallbackPct, layerCallbackPct,
      pairedCoinsCount: pairedCoins?.length || 1, currentUserExposureUsdt: currentUserExposure, availableBalanceUsdt: parsed.data.availableBalanceUsdt,
      useMoneyManagement,
      steps: parsed.data.steps,
    });
    console.log("Risk BLOCKED:", JSON.stringify(registrationRisk.blockers));
    if (registrationRisk.status === 'BLOCKED') {
      return next(new ApiError(422, 'BOT_RISK_GUARDRAIL_BLOCKED', 'risk',
        registrationRisk.blockers.map((rule: any) => rule.code).join(', '),
        registrationRisk.blockers.map((rule: any) => rule.message).join(' ')));
    }

    const coinsToRegister = pairedCoins?.length ? pairedCoins : [pair];
    const baseBotId = requestedBotId || `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const finalBotName = botName || `GAIN ${botMode} (${coinsToRegister.length} Koin)`;
    const avgL = botMode === 'Grid Only' ? 0 : Math.max(1, averagingLayers);
    const gridL = botMode === 'Avarage Only' ? 0 : Math.max(1, gridLayers);
    const initialPrices = new Map<string, number>();

    for (const coinPair of coinsToRegister) {
      let initialPrice = 0;
      try {
        initialPrice = (await getPrice(exchange, coinPair, isSandbox)).last;
      } catch (priceErr) {
        return next(
          new ApiError(
            400,
            'BOT_MARKET_PRICE_FAILED',
            'exchange',
            `Could not fetch market price for ${coinPair}: ${String((priceErr as any)?.message || priceErr)}`,
            `Gagal mengambil harga pasar terbaru untuk ${coinPair}. Periksa ketersediaan simbol koin di exchange ${exchange}.`
          )
        );
      }
      if (!(initialPrice > 0)) {
        return next(new ApiError(409, 'BOT_MARKET_PRICE_REQUIRED', 'exchange', `A fresh market price is required for ${coinPair}.`, `Harga market terbaru diperlukan untuk ${coinPair}.`));
      }
      initialPrices.set(coinPair, initialPrice);
    }

    const suppliedMinPrice = Number(minPrice || 0);
    const suppliedMaxPrice = Number(maxPrice || 0);
    if (suppliedMinPrice > 0 && suppliedMaxPrice > 0 && suppliedMaxPrice <= suppliedMinPrice) {
      return next(new ApiError(422, 'PRICE_BOUND_INVALID', 'validation', 'Max price must be greater than min price.', 'Max Price harus lebih tinggi dari Min Price.'));
    }

    for (const coinPair of coinsToRegister) {
      const runnerId = deriveBotRunnerId(baseBotId, coinPair, coinsToRegister.length > 1);
      const initialPrice = initialPrices.get(coinPair)!;
      const isPrimaryPair = coinPair === pair;
      const parsedMinPrice = (isPrimaryPair || coinsToRegister.length === 1) ? suppliedMinPrice : 0;
      const parsedMaxPrice = (isPrimaryPair || coinsToRegister.length === 1) ? suppliedMaxPrice : 0;

      const boundaryStatus = (parsedMaxPrice > 0 && initialPrice > parsedMaxPrice)
        ? 'ABOVE_MAX'
        : (parsedMinPrice > 0 && initialPrice < parsedMinPrice)
        ? 'BELOW_MIN'
        : 'IN_RANGE';

      const registryKey = botRegistryKey(uid, runnerId);
      const previousRunner = activeBotsRegistry.get(registryKey);
      if (previousRunner) {
        await transitionBotLifecycle(previousRunner, 'paused', 'USER_REQUEST');
      }
      const runner: ActiveBotRunner = {
        id: runnerId, uid, botId: baseBotId, mode, botName: finalBotName, pair: coinPair, pairedCoins: coinsToRegister,
        botMode, baseAmount: Number(baseAmount), baseTp: Number(baseTp), useMoneyManagement: useMoneyManagement !== false,
        averagingLayers: avgL, gridLayers: gridL, averageDownPct: Number(averageDownPct), uptrendFilter: uptrendFilter !== false,
        uptrendThresholdPct: Number(uptrendThresholdPct ?? 0.1),
        tpCallbackPct: Number(tpCallbackPct) || 0.2, layerCallbackPct: Number(layerCallbackPct) || 0.2, gridTp: Number(gridTp) || 1.2,
        minPrice: parsedMinPrice, maxPrice: parsedMaxPrice, priceBoundaryStatus: boundaryStatus, stepLayer: 1, entryPrice: initialPrice,
        peakPrice: initialPrice, troughPrice: initialPrice, lastEvaluatedPrice: initialPrice, positionQty: 0, positionVersion: 0,
        avgEntryPrice: 0, realizedPnlToday: 0, pnlDate: new Date().toISOString().slice(0, 10), failureStreak: 0, priceFailureStreak: 0,
        orderSequence: 0, status: 'paused', exchange: exchange.toUpperCase(), isSandbox, timeframe,
        lastStrategyCandleTimestamp: undefined, lastStrategySignalPrice: undefined,
        steps: parsed.data.steps,
        dcaLayers: GAIN_V2_ENABLED ? generateDcaLayers({
          baseOrderUsd: Number(baseAmount), stepDeviationPct: Number(averageDownPct), stepScale: 1.25, volumeMultiplier: 1.3,
          maxLayers: Math.max(1, avgL), maxCapitalUsd: useMoneyManagement !== false ? Math.min(V2_MAX_COMMITTED_CAPITAL_USDT, MAX_BOT_EXPOSURE_USDT) : Number.POSITIVE_INFINITY,
          takeProfitPct: Number(baseTp), trailingTpPct: Number(tpCallbackPct) || 0.2, callbackPct: Number(layerCallbackPct) || 0.2,
          minPrice: parsedMinPrice || undefined, maxPrice: parsedMaxPrice || undefined,
          steps: parsed.data.steps,
        }) : undefined,
        gridLevels: GAIN_V2_ENABLED && (botMode === 'Grid Only' || botMode === 'Avarage+Grid') && parsedMinPrice > 0 && parsedMaxPrice > parsedMinPrice
          ? generateGridLevels({ lowerPrice: parsedMinPrice, upperPrice: parsedMaxPrice, gridCount: Math.max(1, Math.min(100, gridL || 20)), orderSizeUsd: Number(baseAmount), takeProfitPct: Number(gridTp) || 1.2, maxCapitalUsd: useMoneyManagement !== false ? V2_MAX_COMMITTED_CAPITAL_USDT : Number.POSITIVE_INFINITY }, initialPrice)
          : undefined,
        committedCapitalUsd: 0,
      };
      await persistBotRunner(runner);
      await upsertBotRuntime({ 
        firebaseUid: uid, externalBotId: runner.id, name: finalBotName, exchange: exchange.toUpperCase(), symbol: coinPair, strategyType: botMode, status: 'ACTIVE', mode, 
        config: {
          baseAmount, baseTp, useMoneyManagement, tpCallbackPct, averageDownPct,
          maxLayers: botMode === 'Avarage+Grid' ? (avgL + gridL) : Math.max(avgL, gridL),
          maxCapitalUsd: useMoneyManagement !== false ? V2_MAX_COMMITTED_CAPITAL_USDT : null, minPrice: parsedMinPrice, maxPrice: parsedMaxPrice, timeframe,
          averagingLayers: avgL, gridLayers: gridL, uptrendFilter, uptrendThresholdPct: Number(uptrendThresholdPct ?? 0.1), layerCallbackPct, gridTp, pairedCoins: coinsToRegister
        } 
      });
      runner.status = 'active';
      await persistBotRunner(runner);
      activeBotsRegistry.set(registryKey, runner);
      if (GAIN_V2_ENABLED && (mode === 'testnet' || mode === 'live')) {
        try { v2WebSocketManager.connect(exchange.toLowerCase(), coinPair, isSandbox); } catch {}
      }
    }

    logAuditEvent(req, res, 'bot.registered', { uid, botId: baseBotId, exchange: String(exchange).slice(0, 20), pairedCoinCount: coinsToRegister.length, sandbox: Boolean(isSandbox) });
    res.json({
      success: true,
      message: `Bot "${finalBotName}" berhasil dipairing ke ${coinsToRegister.length} koin [${coinsToRegister.join(', ')}] & aktif di background engine 24/7!`,
      botId: baseBotId, botName: finalBotName, pairedCoins: coinsToRegister,
      activeCount: Array.from(activeBotsRegistry.values()).filter((bot) => bot.uid === uid).length,
    });
  } catch (err: any) {
    return next(err);
  }
});

router.post('/api/bot/credentials', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = BotCredentialSchema.safeParse(req.body);
    if (!parsed.success) return next(new ApiError(400, 'BOT_CREDENTIALS_INVALID', 'validation', 'Exchange credentials failed validation.', 'Kredensial exchange tidak valid.'));
    const uid = res.locals.botUid as string;
    await requireSecuritySession(req, uid);
    if (!parsed.data.isSandbox) await requireActiveLicense(uid);
    const credential = sanitizeExchangeInput(parsed.data, { requirePassphrase: ['bitget', 'okx'].includes(parsed.data.exchange) });
    requireDatabase();

    let client = createExchangeInstance(credential.exchange, {
      apiKey: credential.apiKey, secret: credential.secret, password: credential.password, isSandbox: credential.isSandbox,
    });
    let detectedBinanceEnv: 'vision' | 'demo' | undefined;
    let balance: any;
    try {
      balance = await withExchangeRetry(credential.exchange, 'fetchBalance', async () => client.fetchBalance());
    } catch (primaryErr: any) {
      if (credential.exchange === 'binance' && credential.isSandbox) {
        const primaryErrMsg = String(primaryErr?.message || primaryErr || '');
        if (/api.?key|apikey|-2015|-2014|-2008|signature|invalid|unauthorized/i.test(primaryErrMsg)) {
          const demoClient = createExchangeInstance(credential.exchange, {
            apiKey: credential.apiKey, secret: credential.secret, password: credential.password, isSandbox: credential.isSandbox, binanceSandboxEnv: 'demo',
          });
          balance = await withExchangeRetry(credential.exchange, 'fetchBalance', async () => demoClient.fetchBalance());
          client = demoClient;
          detectedBinanceEnv = 'demo';
        } else {
          throw primaryErr;
        }
      } else {
        throw primaryErr;
      }
    }
    const identity = resolveExchangeAccountIdentity(credential.exchange, credential.isSandbox, balance, credential);

    const existing = await getExchangeConnection(uid, credential.exchange);
    const ownedBots = selectOwnedBotEntries(Array.from(activeBotsRegistry.entries()), uid).filter(([, bot]) => bot.exchange.toLowerCase() === credential.exchange.toLowerCase());
    let identityChanged = Boolean(existing?.identity_key && existing.identity_key !== identity.identityKey);

    if (existing?.reported_identity_key && identity.reportedIdentityKey) {
      identityChanged = existing.reported_identity_key !== identity.reportedIdentityKey;
    } else if (existing?.credential_fingerprint && existing.credential_fingerprint === identity.credentialFingerprint) {
      identityChanged = false;
    }

    const botsWithPositions = ownedBots.filter(([, bot]) => Number(bot.positionQty || 0) > 0 || Boolean(bot.pendingOrder));
    if (identityChanged && botsWithPositions.length > 0) {
      return next(new ApiError(409, 'EXCHANGE_CREDENTIAL_REBIND_REQUIRES_FLAT', 'trading', 'The exchange credential can only be replaced after the existing bots are flat and reconciled.', 'API exchange tidak boleh diganti saat bot masih memiliki posisi atau order yang belum selesai. Tutup/reconcile posisi dan order terlebih dahulu, lalu ulangi penggantian API.'));
    }

    if (identityChanged && ownedBots.length > 0) {
      for (const [, bot] of ownedBots) {
        if (bot.status !== 'paused') await transitionBotLifecycle(bot, 'paused', 'EXCHANGE_CREDENTIAL_REPLACED');
      }
      const cancellation = await cancelBotOpenOrders(uid, ownedBots.map(([, bot]) => bot));
      if (cancellation.failures > 0) {
        return next(new ApiError(503, 'EXCHANGE_CREDENTIAL_REBIND_UNCONFIRMED', 'exchange', 'Open orders could not be fully confirmed before credential replacement.', 'Penggantian API dibatalkan karena open order lama belum dapat dipastikan batal. Bot tetap dijeda.'));
      }
    }

    const encrypted = encryptBotCredential({
      ...credential,
      exchange: parsed.data.exchange,
      isSandbox: parsed.data.isSandbox,
      ...(detectedBinanceEnv ? { binanceSandboxEnv: detectedBinanceEnv } : {}),
    });
    const saved = await saveExchangeCredential({
      firebaseUid: uid, exchange: credential.exchange, ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag,
      sandbox: credential.isSandbox, identityKey: identity.identityKey, identityType: identity.identityType, identityHint: identity.identityHint,
      credentialFingerprint: identity.credentialFingerprint, reportedIdentityKey: identity.reportedIdentityKey,
    });

    logAuditEvent(req, res, identityChanged ? 'bot.exchange.identity_rebound' : 'bot.credentials.updated', {
      uid, exchange: credential.exchange, storage: 'postgres_encrypted', identityType: identity.identityType, identityHint: identity.identityHint, exchangeAccountId: saved.exchangeAccountId || '', credentialVersion: saved.credentialVersion || 1, pausedRunnerCount: identityChanged ? ownedBots.length : 0,
    });
    res.json({
      success: true, exchange: credential.exchange, encryptedAtRest: true, exchangeAccountId: saved.exchangeAccountId, credentialVersion: saved.credentialVersion, identityType: identity.identityType, identityHint: identity.identityHint, reportedIdentityKey: saved.reportedIdentityKey, credentialStatus: 'ACTIVE', exchangeAccountStatus: 'ACTIVE', rebound: identityChanged,
    });
  } catch (error: any) {
    if (error?.code === 'EXCHANGE_ACCOUNT_ALREADY_LINKED') return next(normalizeExchangeCredentialConflict(error));
    next(error);
  }
});

router.get('/api/bot/credentials/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = res.locals.botUid as string;
    await requireSecuritySession(req, uid);
    requireDatabase();
    const exchange = typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const history = await getExchangeCredentialHistory(uid, exchange);
    res.json({ success: true, history });
  } catch (error) { next(error); }
});

router.post('/api/bot/disconnect-exchange', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawExchange = String(req.body?.exchange || '').trim();
    const descriptor = getExchangeDescriptor(rawExchange);
    if (!descriptor) return next(new ApiError(400, 'EXCHANGE_INVALID', 'validation', 'Exchange is invalid.', 'Exchange tidak valid.'));
    const normalizedExchange = descriptor.id;
    const uid = res.locals.botUid as string;
    await requireSecuritySession(req, uid);
    const ownedBots = selectOwnedBotEntries(Array.from(activeBotsRegistry.entries()), uid).filter(([, bot]) => {
      const bDesc = getExchangeDescriptor(bot.exchange);
      return (bDesc ? bDesc.id : bot.exchange.toLowerCase()) === normalizedExchange;
    });
    await Promise.all(ownedBots.map(([, bot]) => transitionBotLifecycle(bot, 'paused', 'EXCHANGE_DISCONNECTED')));
    const cancellation = await cancelBotOpenOrders(uid, ownedBots.map(([, bot]) => bot));
    if (cancellation.failures > 0) {
      return next(new ApiError(503, 'OPEN_ORDER_CANCELLATION_INCOMPLETE', 'exchange', 'Exchange open orders could not all be confirmed cancelled; credentials were retained.', 'Sebagian open order belum dapat dipastikan batal. Kredensial tetap disimpan dan bot dijeda agar dapat dicoba lagi.'));
    }
    requireDatabase();
    await deleteExchangeCredential(uid, normalizedExchange);
    logAuditEvent(req, res, 'bot.exchange.disconnected', { uid, exchange: normalizedExchange, pausedRunnerCount: ownedBots.length, cancelledOrderCount: cancellation.cancelled });
    res.json({ success: true, exchange: normalizedExchange, pausedRunnerCount: ownedBots.length, cancelledOrderCount: cancellation.cancelled, cancellationFailures: cancellation.failures, credentialsDeleted: true });
  } catch (error) { next(error); }
});

router.post('/api/bot/kill-switch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = res.locals.botUid as string;
    await requireSecuritySession(req, uid);
    const ownedBots = selectOwnedBotEntries(Array.from(activeBotsRegistry.entries()), uid);
    await Promise.all(ownedBots.map(([, bot]) => transitionBotLifecycle(bot, 'paused', 'KILL_SWITCH')));
    const cancellation = await cancelBotOpenOrders(uid, ownedBots.map(([, bot]) => bot));
    if (cancellation.failures > 0) {
      return next(new ApiError(503, 'OPEN_ORDER_CANCELLATION_INCOMPLETE', 'exchange', 'Exchange open orders could not all be confirmed cancelled; runners remain paused.', 'Sebagian open order belum dapat dipastikan batal. Bot tetap dijeda dan belum dihapus.'));
    }
    logAuditEvent(req, res, 'bot.kill_switch', { uid, pausedRunnerCount: ownedBots.length, cancelledOrderCount: cancellation.cancelled });
    res.json({ success: true, pausedRunnerCount: ownedBots.length, cancelledOrderCount: cancellation.cancelled, cancellationFailures: cancellation.failures });
  } catch (error) { next(error); }
});

router.post('/api/bot/delete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({ botId: z.string().trim().regex(/^[a-zA-Z0-9_\-\/]{1,128}$/) }).safeParse(req.body);
    if (!parsed.success) return next(new ApiError(400, 'BOT_ID_INVALID', 'validation', 'Bot id is invalid.', 'ID bot tidak valid.'));
    const uid = res.locals.botUid as string;
    const cleanTarget = parsed.data.botId.replace('/', '').toUpperCase();

    const ownedRunners = selectOwnedBotEntries(Array.from(activeBotsRegistry.entries()), uid).filter(
      ([, bot]) =>
        bot.botId === parsed.data.botId ||
        bot.id === parsed.data.botId ||
        (bot as any).dbId === parsed.data.botId ||
        bot.pair === parsed.data.botId ||
        bot.pair.replace('/', '').toUpperCase() === cleanTarget ||
        bot.id.startsWith(parsed.data.botId) ||
        bot.botId?.startsWith(parsed.data.botId) ||
        bot.id.includes(parsed.data.botId)
    );

    const activePositionRunner = ownedRunners.find(
      ([, bot]) => Number(bot.positionQty || 0) > 1e-8
    );
    if (activePositionRunner) {
      const [, activeBot] = activePositionRunner;
      return next(
        new ApiError(
          409,
          'BOT_HAS_ACTIVE_POSITION',
          'state',
          `Cannot delete bot "${activeBot.pair || parsed.data.botId}" while it holds an active position (${activeBot.positionQty} coins). Please perform Take Profit or close the position first.`,
          `Bot "${activeBot.pair || parsed.data.botId}" tidak dapat dihapus karena masih memiliki posisi aktif (${activeBot.positionQty} koin). Lakukan Take Profit atau tutup posisi terlebih dahulu.`
        )
      );
    }

    if (ownedRunners.length > 0) {
      for (const [, bot] of ownedRunners) {
        bot.status = 'paused';
        bot.lastErrorReason = 'DELETED';
      }

      await Promise.allSettled(
        ownedRunners.map(([, bot]) => transitionBotLifecycle(bot, 'paused', 'USER_PAUSE_ALL'))
      );

      const cancellation = await cancelBotOpenOrders(uid, ownedRunners.map(([, bot]) => bot));
      if (cancellation.failures > 0) {
        return next(new ApiError(503, 'OPEN_ORDER_CANCELLATION_INCOMPLETE', 'exchange', 'Exchange open orders could not all be confirmed cancelled; runners remain paused and were not deleted.', 'Sebagian open order belum dapat dipastikan batal. Bot tetap dijeda dan belum dihapus.'));
      }
      try {
        await Promise.all(
          ownedRunners.flatMap(([, bot]) => [
            deletePersistedBotRunner(uid, bot.id),
            (bot as any).dbId && (bot as any).dbId !== bot.id ? deletePersistedBotRunner(uid, (bot as any).dbId) : Promise.resolve(),
            bot.botId && bot.botId !== bot.id ? deletePersistedBotRunner(uid, bot.botId) : Promise.resolve(),
          ])
        );
      } catch (err: any) {
        if (err?.code === 'BOT_HAS_ACTIVE_POSITION') {
          return next(new ApiError(409, 'BOT_HAS_ACTIVE_POSITION', 'state', err.message, 'Bot tidak dapat dihapus karena masih memiliki posisi aktif.'));
        }
        throw err;
      }
      ownedRunners.forEach(([key]) => activeBotsRegistry.delete(key));
    }

    // Always purge database records even if runner was not in active memory
    try {
      await deletePersistedBotRunner(uid, parsed.data.botId);
    } catch (err: any) {
      if (err?.code === 'BOT_HAS_ACTIVE_POSITION') {
        return next(new ApiError(409, 'BOT_HAS_ACTIVE_POSITION', 'state', err.message, 'Bot tidak dapat dihapus karena masih memiliki posisi aktif di database.'));
      }
      throw err;
    }

    logAuditEvent(req, res, 'bot.deleted', { uid, botId: parsed.data.botId, found: ownedRunners.length > 0 });
    return res.json({
      success: true,
      message: `Bot "${parsed.data.botId}" berhasil dihapus dari background engine dan database.`,
      deletedRunnerCount: ownedRunners.length,
      activeCount: Array.from(activeBotsRegistry.values()).filter((bot) => bot.uid === uid).length,
    });
  } catch (err: any) { return next(err); }
});

router.post('/api/bot/force-take-profit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({
      botId: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,128}$/),
      pair: z.string().trim().regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,10}$/).optional(),
      quantity: z.number().positive().optional(),
      layerId: z.string().trim().min(1).max(128).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return next(new ApiError(400, 'BOT_FORCE_TP_INVALID', 'validation', 'Manual position close request is invalid.', 'Permintaan penutupan posisi tidak valid.'));

    const uid = res.locals.botUid as string;
    await requireSecuritySession(req, uid);
    const candidates = Array.from(activeBotsRegistry.values()).filter((candidate) => candidate.uid === uid);
    const target = (parsed.data.pair
      ? candidates.find((candidate) => candidate.pair === parsed.data.pair && (candidate.id === parsed.data.botId || candidate.botId === parsed.data.botId))
        || candidates.find((candidate) => candidate.pair === parsed.data.pair)
      : undefined)
      || candidates.find((candidate) => candidate.id === parsed.data.botId)
      || candidates.find((candidate) => candidate.botId === parsed.data.botId);

    if (!target) return next(new ApiError(404, 'BOT_NOT_FOUND', 'not_found', 'The bot runner was not found.', 'Runner bot tidak ditemukan.'));
    if (parsed.data.pair && parsed.data.pair !== target.pair) return next(new ApiError(409, 'BOT_PAIR_MISMATCH', 'state', 'The requested pair does not match the authoritative runner.', 'Pasangan koin tidak cocok dengan runner yang tersimpan.'));
    if (target.pendingOrder) return next(new ApiError(409, 'BOT_ORDER_STATUS_UNCERTAIN', 'state', 'An order is still being reconciled. Try again after it reaches a terminal state.', 'Masih ada order yang sedang direkonsiliasi. Coba lagi setelah status order sudah pasti.'));
    if (!['active', 'paused', 'error'].includes(target.status)) return next(new ApiError(409, 'BOT_NOT_CLOSEABLE', 'state', 'The bot is not in a closeable state.', 'Bot belum berada pada status yang dapat ditutup.'));

    let positionQty = Number(target.positionQty || 0);
    if (!(positionQty > 0)) {
      const durablePos = await getDurableBotPosition(target.uid, target.id, target.pair, target.exchange, target.isSandbox);
      if (durablePos && Number(durablePos.quantity) > 0) {
        target.positionQty = Number(durablePos.quantity);
        target.avgEntryPrice = Number(durablePos.average_entry || 0);
        positionQty = target.positionQty;
      }
    }
    const requestedQty = parsed.data.quantity === undefined ? positionQty : Number(parsed.data.quantity);
    if (!(requestedQty > 0)) return next(new ApiError(409, 'BOT_POSITION_EMPTY', 'state', 'There is no open position to close.', 'Tidak ada posisi terbuka yang bisa ditutup.'));
    if (requestedQty > positionQty + 1e-12) return next(new ApiError(409, 'BOT_CLOSE_QTY_EXCEEDS_POSITION', 'state', 'Requested close quantity exceeds the authoritative open position.', 'Jumlah yang akan ditutup melebihi posisi aktif.'));

    if (target.resumeAfterReconciliation || target.status === 'error') {
      try {
        await reconcileLiveBotPosition(target);
        target.resumeAfterReconciliation = false;
        if (target.status === 'error') target.status = 'paused';
        await persistBotRunner(target);
      } catch (error) { return next(error); }
    }

    const manualLeaseAcquired = await acquireBotLeaseForManualClose(target);
    if (!manualLeaseAcquired) return next(new ApiError(409, 'BOT_RUNNER_BUSY', 'state', 'The bot runner is busy in another execution cycle. Try again shortly.', 'Runner bot sedang sibuk menjalankan siklus lain. Coba lagi sebentar.'));

    const freshPrice = await getPrice(target.exchange, target.pair, target.isSandbox);
    if (!(freshPrice.last > 0)) return next(new ApiError(409, 'BOT_MARKET_PRICE_REQUIRED', 'exchange', 'A fresh market price is required before closing the position.', 'Harga pasar terbaru wajib tersedia sebelum posisi ditutup.'));

    const fill = await executeBotMarketOrder(target, 'sell', requestedQty, freshPrice.last, freshPrice.timestamp, true);
    const dailyLossPausedBots = applyBotRealizedPnl(target, fill.filledQty, fill.fillPrice);
    for (const candidate of dailyLossPausedBots) {
      await transitionBotLifecycle(candidate, 'paused', 'RISK_DAILY_LOSS_LIMIT');
    }

    const gainPct = target.avgEntryPrice > 0 ? ((fill.fillPrice - target.avgEntryPrice) / target.avgEntryPrice) * 100 : 0;
    const updatedPosition = applySellFill({ quantity: Number(target.positionQty || 0), averageEntryPrice: Number(target.avgEntryPrice || 0), realizedPnl: 0 }, fill.filledQty, fill.fillPrice);
    target.positionQty = Number(updatedPosition.quantity || 0);
    target.positionVersion = Number((target as any).positionVersion || 0) + 1;

    if (parsed.data.layerId) {
      const closedLayerIds = new Set(target.closedLayerIds || []);
      closedLayerIds.add(parsed.data.layerId);
      target.closedLayerIds = Array.from(closedLayerIds).slice(-200);
      if (Array.isArray(target.executedLayers)) {
        target.executedLayers = target.executedLayers.map((l: any) =>
          l.id === parsed.data.layerId ? { ...l, status: 'closed' } : l
        );
      }

      // Authoritative recalculation of remaining open buy layers
      const remainingActiveLayers = (target.executedLayers || []).filter((l: any) =>
        l.side !== 'sell' && l.status !== 'closed' && !closedLayerIds.has(l.id)
      );

      if (remainingActiveLayers.length > 0) {
        const remainingTotalCost = remainingActiveLayers.reduce((sum: number, l: any) =>
          sum + (Number(l.costUsdt) || (Number(l.buyPrice) * Number(l.amount)) || 0), 0);
        const remainingTotalQty = remainingActiveLayers.reduce((sum: number, l: any) =>
          sum + Number(l.amount || 0), 0);

        if (remainingTotalQty > 1e-12) {
          target.avgEntryPrice = remainingTotalCost / remainingTotalQty;
          target.positionQty = remainingTotalQty;
          target.stepLayer = Math.max(1, remainingActiveLayers.length);
        } else {
          target.positionQty = 0;
          target.avgEntryPrice = 0;
          target.stepLayer = 0;
        }
      } else {
        target.positionQty = 0;
        target.avgEntryPrice = 0;
        target.stepLayer = 0;
      }

      await dbQuery(
        `UPDATE positions SET quantity = $3, average_entry = $4, updated_at = now()
         WHERE bot_id = (SELECT id FROM bots WHERE external_bot_id = $1 LIMIT 1) AND symbol = $2`,
        [target.id, target.pair, target.positionQty, target.avgEntryPrice],
      ).catch(() => {});
    }

    if (target.positionQty <= 1e-12) {
      target.positionQty = 0;
      target.avgEntryPrice = 0;
      target.stepLayer = 1;
      target.entryPrice = fill.fillPrice;
      target.peakPrice = fill.fillPrice;
      target.troughPrice = fill.fillPrice;
      target.pendingOrder = undefined;
      target.executedLayers = [];
      target.closedLayerIds = [];
      if (GAIN_V2_ENABLED && target.dcaLayers) {
        target.dcaLayers = generateDcaLayers({
          baseOrderUsd: target.baseAmount, stepDeviationPct: target.averageDownPct, stepScale: 1.25, volumeMultiplier: 1.3,
          maxLayers: Math.max(1, target.averagingLayers), maxCapitalUsd: target.useMoneyManagement !== false ? Math.min(V2_MAX_COMMITTED_CAPITAL_USDT, MAX_BOT_EXPOSURE_USDT) : Number.POSITIVE_INFINITY,
          takeProfitPct: target.baseTp, trailingTpPct: target.tpCallbackPct || 0.2, callbackPct: target.layerCallbackPct || 0.2,
          minPrice: target.minPrice, maxPrice: target.maxPrice,
          steps: (target as any).steps,
        });
      }
      target.committedCapitalUsd = 0;
      target.status = 'paused';
      target.resumeAfterReconciliation = false;
      target.lastErrorReason = undefined;
    } else {
      target.pendingOrder = undefined;
    }

    const logItem: BotEngineLog = {
      id: `log-manual-tp-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
      uid: target.uid, timestamp: Date.now(), pair: target.pair, botId: target.id, botName: target.botName, action: 'TAKE_PROFIT',
      details: `[${target.botName || target.pair}] MANUAL SELL ${fill.filledQty} @ ${fill.fillPrice} confirmed (${fill.orderId}) (${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}%).`,
      price: fill.fillPrice, stepLayer: target.stepLayer,
    };
    botEngineLogs.unshift(logItem);
    if (botEngineLogs.length > 50) botEngineLogs.pop();
    await persistBotRunner(target);
    await persistBotLog(logItem);

    await releaseBotLease(target).catch(() => {});

    return res.json({
      success: true, mode: target.mode, runnerId: target.id, botId: target.botId, pair: target.pair, orderId: fill.orderId,
      filledQty: fill.filledQty, fillPrice: fill.fillPrice, avgEntryPrice: target.avgEntryPrice, requestedQty,
      remainingQty: target.positionQty, layerId: parsed.data.layerId, roiPct: gainPct, recoveryState: getBotRecoveryStatus(target),
      message: `Posisi ${target.pair} berhasil ditutup pada harga pasar ${fill.fillPrice}.`,
    });
  } catch (error) {
    try {
      const uid = res.locals.botUid as string;
      const target = Array.from(activeBotsRegistry.values()).find((candidate) => candidate.uid === uid && (candidate.id === String(req.body?.botId || '') || (req.body?.pair && candidate.pair === String(req.body.pair))));
      if (target) await releaseBotLease(target);
    } catch {}
    return next(error);
  }
});

router.post('/api/bot/update-bounds', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      botId: z.string().trim().min(1),
      pair: z.string().trim().optional(),
      minPrice: z.coerce.number().min(0).nullable().optional(),
      maxPrice: z.coerce.number().min(0).nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return next(new ApiError(400, 'BOT_BOUNDS_INVALID', 'validation', 'Invalid price boundary request.', 'Format batas harga bot tidak valid.'));
    }

    const { botId, pair, minPrice, maxPrice } = parsed.data;
    const newMin = Number(minPrice || 0);
    const newMax = Number(maxPrice || 0);

    if (newMin > 0 && newMax > 0 && newMax <= newMin) {
      return next(new ApiError(422, 'PRICE_BOUND_INVALID', 'validation', 'Max price must be greater than min price.', 'Max Price harus lebih tinggi dari Min Price.'));
    }

    const uid = res.locals.botUid as string;
    await requireSecuritySession(req, uid);

    const ownedEntries = selectOwnedBotEntries(Array.from(activeBotsRegistry.entries()), uid).filter(([, bot]) => {
      const idMatch = bot.botId === botId || bot.id === botId;
      if (pair) return idMatch || bot.pair.toUpperCase() === pair.toUpperCase();
      return idMatch;
    });

    if (ownedEntries.length === 0) {
      try {
        await dbQuery(
          `UPDATE bot_strategy_configs SET min_price = $1, max_price = $2
           WHERE bot_id = (SELECT id FROM bots WHERE (external_bot_id = $3 OR id::text = $3) AND user_id = (SELECT id FROM users WHERE firebase_uid = $4 LIMIT 1) LIMIT 1)`,
          [newMin > 0 ? newMin : null, newMax > 0 ? newMax : null, botId, uid]
        );
      } catch {}
      return res.json({ success: true, botId, minPrice: newMin > 0 ? newMin : null, maxPrice: newMax > 0 ? newMax : null });
    }

    for (const [, runner] of ownedEntries) {
      runner.minPrice = newMin > 0 ? newMin : undefined;
      runner.maxPrice = newMax > 0 ? newMax : undefined;

      const evalPrice = runner.lastEvaluatedPrice || runner.entryPrice || 0;
      if (runner.maxPrice && evalPrice > runner.maxPrice) {
        runner.priceBoundaryStatus = 'ABOVE_MAX';
      } else if (runner.minPrice && evalPrice < runner.minPrice) {
        runner.priceBoundaryStatus = 'BELOW_MIN';
      } else {
        runner.priceBoundaryStatus = 'IN_RANGE';
      }

      if (GAIN_V2_ENABLED && (runner.botMode === 'Grid Only' || runner.botMode === 'Avarage+Grid')) {
        if (runner.minPrice && runner.maxPrice && runner.maxPrice > runner.minPrice) {
          runner.gridLevels = generateGridLevels({
            lowerPrice: runner.minPrice,
            upperPrice: runner.maxPrice,
            gridCount: Math.max(1, Math.min(100, runner.gridLayers || 20)),
            orderSizeUsd: Number(runner.baseAmount || 20),
            takeProfitPct: Number(runner.gridTp) || 1.2,
            maxCapitalUsd: runner.useMoneyManagement !== false ? V2_MAX_COMMITTED_CAPITAL_USDT : Number.POSITIVE_INFINITY,
          });
        } else {
          runner.gridLevels = undefined;
        }
      }

      await persistBotRunner(runner);
      try {
        await dbQuery(
          `UPDATE bot_strategy_configs SET min_price = $1, max_price = $2
           WHERE bot_id = (SELECT id FROM bots WHERE (external_bot_id = $3 OR id::text = $3) AND user_id = (SELECT id FROM users WHERE firebase_uid = $4 LIMIT 1) LIMIT 1)`,
          [newMin > 0 ? newMin : null, newMax > 0 ? newMax : null, runner.botId || runner.id, uid]
        );
      } catch {}
    }

    return res.json({
      success: true,
      botId,
      minPrice: newMin > 0 ? newMin : null,
      maxPrice: newMax > 0 ? newMax : null,
      priceBoundaryStatus: ownedEntries[0][1].priceBoundaryStatus,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/bot/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({ botId: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,128}$/), status: z.enum(['active', 'paused']) }).safeParse(req.body);
    if (!parsed.success) return next(new ApiError(400, 'BOT_STATUS_INVALID', 'validation', 'Bot status request is invalid.', 'Perintah status bot tidak valid.'));

    const uid = res.locals.botUid as string;
    await requireSecuritySession(req, uid);
    const ownedEntries = selectOwnedBotEntries(Array.from(activeBotsRegistry.entries()), uid).filter(([, bot]) => bot.botId === parsed.data.botId || bot.id === parsed.data.botId);
    if (ownedEntries.length === 0) return next(new ApiError(404, 'BOT_NOT_FOUND', 'not_found', 'Bot runner was not found for the authenticated user.', 'Bot tidak ditemukan untuk akun Anda.'));

    const target = ownedEntries[0][1];
    const requestedStatus = parsed.data.status;
    if (requestedStatus === 'active' && target.mode === 'live') await requireActiveLicense(uid);

    if (requestedStatus === 'active') {
      if (target.pendingOrder) {
        try {
          const resolution = await resolveBotPendingOrder(target);
          await applyResolvedBotOrder(target, resolution);
        } catch (error) {
          const failure = classifyBotExecutionError(error);
          if (failure.reasonCode === 'ORDER_STATUS_UNCERTAIN') {
            return next(new ApiError(409, 'BOT_ORDER_STATUS_UNCERTAIN', 'state', 'The exchange has not returned a definitive status for the pending order.', 'Exchange belum memberikan status final untuk order sebelumnya. Sistem menahan Resume agar tidak terjadi double order.'));
          }
          throw error;
        }
      }

      if (target.resumeAfterReconciliation) {
        try {
          await reconcileLiveBotPosition(target);
          target.resumeAfterReconciliation = false;
          target.lastErrorReason = undefined;
          await persistBotRunner(target);
        } catch (error) { return next(error); }
      }
    }

    const previousStatus = target.status;
    const previousErrorReason = target.lastErrorReason;

    await upsertBotRuntime({
      firebaseUid: uid, externalBotId: target.id, name: target.botName || target.pair,
      exchange: target.exchange, symbol: target.pair, strategyType: target.botMode,
      status: requestedStatus === 'active' ? 'ACTIVE' : 'STANDBY', mode: target.mode,
      config: {
        baseAmount: target.baseAmount, baseTp: target.baseTp, tpCallbackPct: target.tpCallbackPct, averageDownPct: target.averageDownPct,
        maxLayers: target.botMode === 'Avarage+Grid'
          ? ((Number(target.averagingLayers) || 0) + (Number(target.gridLayers) || 0))
          : Math.max(Number(target.averagingLayers) || 0, Number(target.gridLayers) || 0),
        maxCapitalUsd: target.committedCapitalUsd || 0, minPrice: target.minPrice, maxPrice: target.maxPrice, timeframe: target.timeframe,
        averagingLayers: target.averagingLayers, gridLayers: target.gridLayers, uptrendFilter: target.uptrendFilter, uptrendThresholdPct: target.uptrendThresholdPct, layerCallbackPct: target.layerCallbackPct, gridTp: target.gridTp, pairedCoins: target.pairedCoins
      },
    });

    await transitionBotLifecycle(target, requestedStatus, 'USER_REQUEST');

    logAuditEvent(req, res, requestedStatus === 'active' ? 'bot.resumed' : 'bot.paused', {
      uid, botId: target.botId, runnerId: target.id, previousStatus, status: requestedStatus, hadPreviousError: Boolean(previousErrorReason),
    });

    return res.json({
      success: true, botId: target.botId, runnerId: target.id, status: target.status,
      resumeAfterReconciliation: target.resumeAfterReconciliation === true, lastErrorReason: target.lastErrorReason,
      message: requestedStatus === 'active' ? 'Bot berhasil dilanjutkan.' : 'Bot berhasil dijeda.',
    });
  } catch (error) { return next(error); }
});

router.post('/api/bot/reconcile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({ botId: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,128}$/) }).safeParse(req.body);
    if (!parsed.success) return next(new ApiError(400, 'BOT_ID_INVALID', 'validation', 'Bot id is invalid.', 'ID bot tidak valid.'));

    const uid = res.locals.botUid as string;
    await requireSecuritySession(req, uid);
    const ownedEntries = selectOwnedBotEntries(Array.from(activeBotsRegistry.entries()), uid).filter(([, bot]) => bot.botId === parsed.data.botId || bot.id === parsed.data.botId);
    if (ownedEntries.length === 0) return next(new ApiError(404, 'BOT_NOT_FOUND', 'not_found', 'Bot runner was not found for the authenticated user.', 'Bot tidak ditemukan untuk akun Anda.'));

    const bot = ownedEntries[0][1];
    if (bot.pendingOrder) {
      const resolution = await resolveBotPendingOrder(bot);
      await applyResolvedBotOrder(bot, resolution);
    }

    await reconcileLiveBotPosition(bot);
    await persistBotRunner(bot);

    return res.json({
      success: true, runnerId: bot.id, botId: bot.botId, positionQty: bot.positionQty, lastReconciledAt: bot.lastReconciledAt, exchangeWrites: 0, recoveryState: getBotRecoveryStatus(bot), message: 'Rekonsiliasi exchange selesai. Lifecycle runner tidak diubah oleh endpoint ini.',
    });
  } catch (error) { return next(error); }
});

router.post('/api/bot/rebuild-position-from-fills', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({ botId: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,128}$/), pair: z.string().trim().regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,10}$/).optional() }).safeParse(req.body);
    if (!parsed.success) return next(new ApiError(400, 'BOT_REBUILD_INVALID', 'validation', 'Position rebuild request is invalid.', 'Permintaan rebuild posisi tidak valid.'));

    const uid = res.locals.botUid as string;
    await requireSecuritySession(req, uid);
    const ownedEntries = selectOwnedBotEntries(Array.from(activeBotsRegistry.entries()), uid).filter(([, bot]) => bot.botId === parsed.data.botId || bot.id === parsed.data.botId);
    if (ownedEntries.length === 0) return next(new ApiError(404, 'BOT_NOT_FOUND', 'not_found', 'Bot runner was not found for the authenticated user.', 'Bot tidak ditemukan untuk akun Anda.'));

    const bot = ownedEntries[0][1];
    if (bot.status === 'active') return next(new ApiError(409, 'BOT_REBUILD_REQUIRES_PAUSED', 'state', 'Pause the bot before rebuilding its financial position.', 'Jeda bot terlebih dahulu sebelum memperbaiki posisi finansial.'));
    if (parsed.data.pair && parsed.data.pair !== bot.pair) return next(new ApiError(409, 'BOT_PAIR_MISMATCH', 'state', 'The requested pair does not match the bot runner.', 'Pair yang diminta tidak cocok dengan runner bot.'));

    const repaired = await rebuildBotPositionFromFills({ firebaseUid: uid, externalBotId: bot.id, symbol: bot.pair, exchange: bot.exchange });

    if (bot.pendingOrder) {
      const resolution = await resolveBotPendingOrder(bot);
      await applyResolvedBotOrder(bot, resolution);
    } else {
      await reconcileLiveBotPosition(bot);
      await persistBotRunner(bot);
    }

    await createAuditEvent({
      firebaseUid: uid, botId: bot.id, eventType: 'bot.position.rebuilt_from_fill_history',
      payload: { exchange: bot.exchange, symbol: bot.pair, source: repaired.source, fillCount: repaired.fillCount, repairedPosition: repaired.position },
    });

    return res.json({
      success: true, exchange: bot.exchange, pair: bot.pair, runnerId: bot.id, botId: bot.botId, repaired, positionQty: bot.positionQty, avgEntryPrice: bot.avgEntryPrice, recoveryState: getBotRecoveryStatus(bot), message: 'Posisi durable direkonstruksi dari immutable fill history dan state exchange direkonsiliasi tanpa membuat order baru.',
    });
  } catch (error) { return next(error); }
});

router.get('/api/bot/engine-status', (_req: Request, res: Response) => {
  const uid = res.locals.botUid as string;
  const ownedBots = Array.from(activeBotsRegistry.values()).filter((bot) => bot.uid === uid);
  const botsList = ownedBots.map((b) => {
    const posQty = Number(b.positionQty || 0);
    const avgEntry = Number(b.avgEntryPrice || b.entryPrice || 0);
    const lastPrice = Number(b.lastEvaluatedPrice || avgEntry || 0);
    const baseTp = Number(b.baseTp || 1.5);

    const rawAvg = Number(b.averagingLayers || 0);
    const rawGrid = Number(b.gridLayers || 0);
    const dcaCount = Array.isArray(b.dcaLayers) ? b.dcaLayers.length : 0;
    const gridCount = Array.isArray(b.gridLevels) ? b.gridLevels.length : 0;

    // Self-healing: if an in-memory runner was stored with legacy 1-layer default, upgrade to operational standards
    const resolvedAvg = rawAvg > 1
      ? rawAvg
      : (b.botMode === 'Grid Only' ? 0 : Math.max(rawAvg, dcaCount, 8));
    const resolvedGrid = rawGrid > 1
      ? rawGrid
      : (b.botMode === 'Avarage Only' ? 0 : Math.max(rawGrid, gridCount, 10));

    if (b.botMode !== 'Grid Only' && (!b.averagingLayers || b.averagingLayers <= 1)) {
      b.averagingLayers = resolvedAvg;
    }
    if (b.botMode !== 'Avarage Only' && (!b.gridLayers || b.gridLayers <= 1)) {
      b.gridLayers = resolvedGrid;
    }

    const totalMaxLayers = b.botMode === 'Avarage Only'
      ? Math.max(1, b.averagingLayers || 10)
      : b.botMode === 'Grid Only'
      ? Math.max(1, b.gridLayers || 20)
      : Math.max(1, (b.averagingLayers || 8) + (b.gridLayers || 10));

    // Regenerate dcaLayers if missing or crippled to single layer
    if (GAIN_V2_ENABLED && (!b.dcaLayers || b.dcaLayers.length <= 1) && (b.botMode === 'Avarage Only' || b.botMode === 'Avarage+Grid')) {
      try {
        b.dcaLayers = generateDcaLayers({
          baseOrderUsd: Number(b.baseAmount || 10),
          stepDeviationPct: Number(b.averageDownPct || 1.0),
          stepScale: 1.25,
          volumeMultiplier: 1.3,
          maxLayers: Math.max(1, b.averagingLayers),
          maxCapitalUsd: b.useMoneyManagement !== false ? Math.min(V2_MAX_COMMITTED_CAPITAL_USDT, MAX_BOT_EXPOSURE_USDT) : Number.POSITIVE_INFINITY,
          takeProfitPct: Number(b.baseTp || 1.5),
          trailingTpPct: Number(b.tpCallbackPct) || 0.2,
          callbackPct: Number(b.layerCallbackPct) || 0.2,
          minPrice: b.minPrice || undefined,
          maxPrice: b.maxPrice || undefined,
        });
      } catch {}
    }

    return {
      id: b.id, botId: b.botId, runnerId: b.id, botName: b.botName, pair: b.pair, exchange: b.exchange, isSandbox: b.isSandbox, mode: b.mode, strategy: b.botMode, stepLayer: b.stepLayer,
      maxLayers: totalMaxLayers,
      averagingLayers: b.averagingLayers,
      gridLayers: b.gridLayers,
      executedLayerCount: Array.isArray(b.executedLayers) && b.executedLayers.length > 0
        ? b.executedLayers.filter((l: any) => l.side !== 'sell' && l.status !== 'closed').length
        : (posQty > 0 ? 1 : 0),
      executedLayers: (Array.isArray(b.executedLayers) && b.executedLayers.length > 0)
        ? b.executedLayers
        : (posQty > 0 ? [{
            id: `layer-${b.id}-1`,
            orderId: b.botId || b.id,
            symbol: b.pair,
            coin: b.pair.split('/')[0] || b.pair,
            side: 'buy',
            layerNo: 1,
            layerStep: 1,
            layerType: 'average',
            amount: posQty,
            costUsdt: Number((posQty * (avgEntry || 1)).toFixed(4)),
            buyPrice: avgEntry,
            timestamp: Date.now(),
            status: 'filled',
            label: `BUY -> ${posQty.toFixed(4)} ${b.pair.split('/')[0] || b.pair}`,
            currentPrice: lastPrice,
            estimatedTpPrice: Number((avgEntry * (1 + baseTp / 100)).toFixed(4)),
            estimatedTpPct: baseTp,
            estimatedTpUsdt: Number((posQty * avgEntry * (baseTp / 100)).toFixed(4)),
            floatingPnlUsdt: Number(((lastPrice - avgEntry) * posQty).toFixed(4)),
            floatingPnlPct: avgEntry > 0 ? Number((((lastPrice - avgEntry) / avgEntry) * 100).toFixed(2)) : 0,
            fee: 0,
            feeAsset: 'USDT',
            date: 'Live execution snapshot',
            isInitialEntry: true,
          }] : []),
      closedLayerIds: b.closedLayerIds || [],
      dcaLayers: b.dcaLayers || [], gridLevels: b.gridLevels || [],
      entryPrice: Number(b.entryPrice || 0), lastPrice: lastPrice, timeframe: b.timeframe, lastStrategyCandleTimestamp: b.lastStrategyCandleTimestamp || null,
      strategyPriceSource: 'CLOSED_CANDLE', strategySignalPrice: b.lastStrategySignalPrice || null, strategySignalCloseTimestamp: b.lastStrategyCandleTimestamp || null,
      status: b.status, positionQty: posQty, avgEntryPrice: avgEntry, realizedPnlToday: Number(b.realizedPnlToday || 0), lastErrorReason: b.lastErrorReason,
      resumeAfterReconciliation: b.resumeAfterReconciliation === true, startupAutoResumeEnabled: BOT_STARTUP_AUTO_RESUME, lastReconciledAt: b.lastReconciledAt, positionVersion: Number((b as any).positionVersion || 0),
      pendingOrderStatus: b.pendingOrder?.status || null, pendingClientOrderId: b.pendingOrder?.clientOrderId || null, pendingSide: b.pendingOrder?.side || null, pendingRequestedQty: b.pendingOrder?.requestedQty || null, pendingCreatedAt: b.pendingOrder?.createdAt || null, pendingExchangeOrderId: b.pendingOrder?.orderId || null,
      ...getBotRecoveryStatus(b), minPrice: b.minPrice, maxPrice: b.maxPrice, priceBoundaryStatus: b.priceBoundaryStatus,
      uptrendFilter: b.uptrendFilter !== false, uptrendThresholdPct: b.uptrendThresholdPct ?? 0.1, uptrendStatus: b.uptrendStatus || 'Sideways',
      baseTp, gridTp: Number(b.gridTp || 1.2), tpCallbackPct: Number(b.tpCallbackPct || 0.2), averageDownPct: Number(b.averageDownPct || 1.0),
      tpPrice: avgEntry > 0 ? Number((avgEntry * (1 + baseTp / 100)).toFixed(4)) : null,
      tpTargetPrice: avgEntry > 0 ? `$${(avgEntry * (1 + baseTp / 100)).toFixed(avgEntry < 1 ? 4 : 2)}` : null,
      tpTriggerPrice: avgEntry > 0 ? `$${(avgEntry * (1 + baseTp / 100)).toFixed(avgEntry < 1 ? 4 : 2)} (+${baseTp}%)` : null,
    };
  });

  res.json({
    success: true, source: 'backend_runtime', serverTime: Date.now(), engineRunning: true, loopIntervalSec: GAIN_V2_ENABLED ? 1 : 15, startupAutoResumeEnabled: BOT_STARTUP_AUTO_RESUME, startupAutoResumePolicy: BOT_STARTUP_AUTO_RESUME ? 'OPT_IN_AUTO_RESUME' : 'MANUAL_RESUME_REQUIRED', activeBotsCount: botsList.filter((b) => b.status === 'active').length, totalRegisteredBots: botsList.length, bots: botsList, botsList: botsList, recentLogs: botEngineLogs.filter((log) => log.uid === uid).slice(0, 15),
  });
});

router.post('/api/bot/pause-all', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = res.locals.botUid as string;
    await requireSecuritySession(_req, uid);
    const ownedBots = selectOwnedBotEntries(Array.from(activeBotsRegistry.entries()), uid).map(([, bot]) => bot);
    await Promise.all(ownedBots.map((bot) => transitionBotLifecycle(bot, 'paused', 'USER_PAUSE_ALL')));
    logAuditEvent(_req, res, 'bot.engine.paused', { uid });
    res.json({ success: true, message: 'Seluruh bot Anda berhasil dijeda.' });
  } catch (error) { next(error); }
});

router.post('/api/bot/resume-all', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = res.locals.botUid as string;
    await requireSecuritySession(_req, uid);
    const ownedBots = selectOwnedBotEntries(Array.from(activeBotsRegistry.entries()), uid).map(([, bot]) => bot);
    if (ownedBots.some((bot) => bot.mode === 'live' && !bot.pendingOrder && !bot.resumeAfterReconciliation)) {
      await requireActiveLicense(uid);
    }
    for (const bot of ownedBots) {
      if (bot.pendingOrder || bot.resumeAfterReconciliation) continue;
      await transitionBotLifecycle(bot, 'active', 'USER_REQUEST');
    }
    logAuditEvent(_req, res, 'bot.engine.resumed', { uid });
    res.json({ success: true, message: 'Bot tanpa order ambigu berhasil dilanjutkan.' });
  } catch (error) { next(error); }
});

router.post('/api/admin/trading-kill-switch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminUid = await requireAdmin(req);
    const requestedEnabled = req.body?.enabled === true;
    if (requestedEnabled && process.env.LIVE_TRADING_ENABLED !== 'true') return next(new ApiError(403,'LIVE_TRADING_ENV_DISABLED','security','Environment-level live trading gate is disabled.','LIVE_TRADING_ENABLED di environment masih false.'));
    const enabled = requestedEnabled;
    setRuntimeLiveTradingEnabled(enabled);
    await setSystemSetting('live_trading_enabled', { enabled }, adminUid);
    if (!enabled) {
      const owned = Array.from(activeBotsRegistry.values()).filter((bot) => bot.mode === 'live');
      await Promise.all(owned.map((bot) => transitionBotLifecycle(bot, 'paused', 'GLOBAL_LIVE_TRADING_KILL_SWITCH')));
      const byUser = new Map<string, ActiveBotRunner[]>();
      owned.forEach((bot) => { const list = byUser.get(bot.uid) || []; list.push(bot); byUser.set(bot.uid, list); });
      for (const [uid, bots] of byUser) await cancelBotOpenOrders(uid, bots);
    }
    await createAuditEvent({ firebaseUid:adminUid, eventType:'admin.global_live_trading_toggle', payload:{ enabled } });
    res.json({ success:true, liveTradingEnabled:runtimeLiveTradingEnabled });
  } catch (error) { next(error); }
});

export default router;
