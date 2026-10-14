import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import { ApiError } from '../shared/apiError';
import { getRequestId } from '../shared/observabilityUtils';
import {
  requireDatabase,
  requireFirebaseIdentity,
  requireAdmin,
  requireSecuritySession,
  checkGlobalRequestRateLimit,
} from '../shared/authUtils';
import { decryptSensitiveString, verifyServerTotp } from '../shared/cryptoUtils';
import { FINANCIAL_CONFIG } from '../../config/financialConfig';
import { getLicenseTierConfig } from '../../config/licensePromo';
import {
  requireFinancialOperationsReady,
  getFinancialOperationsReadiness,
} from '../financialControlPolicy';

import {
  getNativeWalletStatus,
  configureNativeHotWallet,
  setNativeHotWalletEnabled,
  ensureNativeDepositAddress,
} from '../nativeBscWallet';
import { redisAvailable, redisSetNxEx } from '../redis';
import {
  getUserByMemberId,
  dbQuery,
  createAuditEvent,
  getTwoFactorSecretRecord,
  consumeTotpCounter,
  getWalletDepositAddresses,
  provisionWalletDepositAddress,
  getNativeBscUserBalances,
  listFinancialTransactions,
  getUserLedgerTransactions,
  getFinancialWalletOverview,
  queueNativeBscWithdrawal,
  transferFundsAtomic,
  topupGasAtomic,
  getProfitShareSummary,
  getGasAutoRefillConfig,
  upsertGasAutoRefillConfig,
  activateLicenseAtomic,
  createVoucherInDb,
  getVouchersFromDb,
  toggleVoucherStatusInDb,
  deleteVoucherInDb,
  validateVoucherForUserInDb,
  recordConfirmedDeposit,
  applyDepositScreeningResult,
  listWithdrawalAddresses,
  registerWithdrawalAddress,
  removeWithdrawalAddress,
  listWithdrawalQueue,
  recordWithdrawalApproval,
  rejectWithdrawal,
  applyWithdrawalScreeningResult,
  claimNextWithdrawal,
  markWithdrawalPayoutSubmitted,
  settleWithdrawal,
  createWithdrawalRequest,
  toLedgerAmount,
} from '../database';

const router = Router();

// ==========================================
// HELPER FUNCTIONS & MIDDLEWARE
// ==========================================
function requiredPositiveLimit(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new ApiError(503, 'FINANCIAL_LIMITS_NOT_CONFIGURED', 'configuration', `${name} must be set to a positive number.`, 'Batas transaksi belum dikonfigurasi oleh administrator.');
  return value;
}
async function requireFinancialRateLimit(uid: string, action: string, maxRequests: number): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.REDIS_REQUIRED === 'true' && !(await redisAvailable())) {
    throw new ApiError(503, 'FINANCIAL_RATE_LIMIT_UNAVAILABLE', 'configuration', 'Production financial actions require REDIS_REQUIRED=true and a healthy Redis instance.', 'Layanan pembatas transaksi belum siap.');
  }
  if (!(await checkGlobalRequestRateLimit(`financial:${action}:${uid}`, maxRequests, 60_000))) {
    throw new ApiError(429, 'FINANCIAL_RATE_LIMITED', 'rate_limit', 'Financial action rate limit exceeded.', 'Terlalu banyak permintaan transaksi. Tunggu sebentar lalu coba lagi.');
  }
}

function canonicalJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

async function requireWithdrawalProcessorSignature(req: Request, secretName = 'WITHDRAWAL_PROCESSOR_SECRET'): Promise<void> {
  const secret = String(process.env[secretName] || '');
  const timestamp = String(req.header('x-withdrawal-processor-timestamp') || '');
  const nonce = String(req.header('x-withdrawal-processor-nonce') || '');
  const suppliedHex = String(req.header('x-withdrawal-processor-signature') || '').toLowerCase();
  const timestampSeconds = Number(timestamp);
  if (secret.length < 32 || !/^\d{10}$/.test(timestamp) || !Number.isSafeInteger(timestampSeconds)
    || Math.abs(Date.now() / 1000 - timestampSeconds) > 60 || !/^[A-Za-z0-9-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(suppliedHex)) {
    throw new ApiError(401, 'PROCESSOR_UNAUTHORIZED', 'authorization', 'A current signed withdrawal-processor request is required.', 'Request processor withdrawal tidak terautentikasi.');
  }
  const message = `${timestamp}\n${nonce}\n${req.method.toUpperCase()}\n${req.path}\n${canonicalJson(req.body || {})}`;
  const expected = createHmac('sha256', secret).update(message).digest();
  const supplied = Buffer.from(suppliedHex, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
    throw new ApiError(401, 'PROCESSOR_UNAUTHORIZED', 'authorization', 'Withdrawal-processor signature is invalid.', 'Tanda tangan processor withdrawal tidak valid.');
  }
  if (!(await redisAvailable())) throw new ApiError(503, 'PROCESSOR_REPLAY_GUARD_UNAVAILABLE', 'configuration', 'Redis is required to reject processor request replays.', 'Layanan proteksi replay processor sedang tidak tersedia.');
  if (!(await redisSetNxEx(`gain:financial-internal:${secretName}:${nonce}`, '1', 120))) {
    throw new ApiError(409, 'PROCESSOR_REPLAY_REJECTED', 'security', 'Withdrawal-processor nonce was already used.', 'Request processor tersebut sudah pernah digunakan.');
  }
}

function decimalAmountToUnits(value: unknown, decimals: number): bigint {
  const input = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input);
  if (!match || (match[2] || '').length > decimals) throw new ApiError(400, 'TOKEN_AMOUNT_INVALID', 'validation', 'Amount precision is invalid for this token.', 'Presisi nominal tidak sesuai dengan token.');
  const scale = 10n ** BigInt(decimals);
  return BigInt(match[1]) * scale + BigInt((match[2] || '').padEnd(decimals, '0') || '0');
}

function unitsToLedgerAmount(units: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = decimals ? (units % scale).toString().padStart(decimals, '0') : '';
  const normalizedFraction = fraction.slice(0, 10).replace(/0+$/, '');
  const amount = toLedgerAmount(Number(normalizedFraction ? `${whole}.${normalizedFraction}` : whole.toString()));
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError(400, 'TOKEN_AMOUNT_INVALID', 'validation', 'On-chain token amount is invalid.', 'Nominal token on-chain tidak valid.');
  return amount;
}

function evmTopicAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

const BSC_USDT_MAINNET_CONTRACT = '0x55d398326f99059ff775485246999027b3197955';

async function bscRpcCall(rpc: string, method: string, params: unknown[]): Promise<any> {
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError(503, 'BSC_RPC_UNAVAILABLE', 'provider', 'BSC RPC timed out or is unavailable.', 'Penyedia jaringan BSC sedang tidak tersedia.');
  }
  let body: any;
  try { body = await response.json(); } catch { throw new ApiError(503, 'BSC_RPC_INVALID_RESPONSE', 'provider', 'BSC RPC returned invalid JSON.', 'Respons penyedia jaringan BSC tidak valid.'); }
  if (!response.ok || body?.error || body?.result === undefined) throw new ApiError(503, 'BSC_RPC_ERROR', 'provider', 'BSC RPC request failed.', 'Verifikasi jaringan BSC gagal sementara.');
  return body.result;
}

async function verifyBscUsdtTransfer(input: { txHash: string; destinations: string[]; source?: string }) {
  const rpc = String(process.env.BSC_RPC_URL || '').trim();
  const configuredToken = String(process.env.BSC_USDT_CONTRACT || BSC_USDT_MAINNET_CONTRACT).trim().toLowerCase();
  const token = BSC_USDT_MAINNET_CONTRACT;
  const destinations = new Set(input.destinations.map((address) => address.toLowerCase()));
  if (!destinations.size || [...destinations].some((address) => !/^0x[a-f0-9]{40}$/.test(address))) throw new ApiError(409, 'DEPOSIT_ADDRESS_NOT_PROVISIONED', 'configuration', 'No valid provider-assigned address is available.', 'Alamat deposit khusus akun ini belum disiapkan oleh kustodian.');
  if (!rpc || configuredToken !== BSC_USDT_MAINNET_CONTRACT) throw new ApiError(503, 'ONCHAIN_PROVIDER_NOT_CONFIGURED', 'configuration', 'A BSC RPC and the approved USDT mainnet contract configuration are required.', 'RPC BSC dan kontrak USDT BEP-20 yang disetujui wajib dikonfigurasi.');
  const [chainIdResult, tx, receipt, latestResult, finalized] = await Promise.all([
    bscRpcCall(rpc, 'eth_chainId', []),
    bscRpcCall(rpc, 'eth_getTransactionByHash', [input.txHash]),
    bscRpcCall(rpc, 'eth_getTransactionReceipt', [input.txHash]),
    bscRpcCall(rpc, 'eth_blockNumber', []),
    bscRpcCall(rpc, 'eth_getBlockByNumber', ['finalized', false]),
  ]);
  if (BigInt(String(chainIdResult)) !== 56n) throw new ApiError(503, 'BSC_CHAIN_ID_MISMATCH', 'configuration', 'The configured RPC is not BNB Smart Chain mainnet (chain ID 56).', 'RPC yang dikonfigurasi bukan BNB Smart Chain mainnet.');
  const validHash = /^0x[a-fA-F0-9]{64}$/;
  if (!tx || !receipt || !validHash.test(String(tx.hash || '')) || String(tx.hash).toLowerCase() !== input.txHash.toLowerCase()
    || String(receipt.transactionHash || '').toLowerCase() !== input.txHash.toLowerCase() || String(receipt.status) !== '0x1') {
    throw new ApiError(400, 'ONCHAIN_TRANSACTION_NOT_CONFIRMED', 'validation', 'A successful mined BSC transaction is required.', 'Transaksi BSC belum berhasil dikonfirmasi.');
  }
  if (!/^0x[0-9a-f]+$/i.test(String(receipt.blockNumber || '')) || !/^0x[a-f0-9]{64}$/i.test(String(receipt.blockHash || ''))) {
    throw new ApiError(503, 'BSC_RPC_INVALID_RECEIPT', 'provider', 'BSC receipt is incomplete.', 'Data receipt BSC tidak lengkap.');
  }
  const blockNumber = Number(BigInt(String(receipt.blockNumber)));
  const latestBlock = Number(BigInt(String(latestResult)));
  const finalizedNumber = Number(BigInt(String(finalized?.number || '0x0')));
  if (![blockNumber, latestBlock, finalizedNumber].every(Number.isSafeInteger) || blockNumber <= 0 || latestBlock < blockNumber) {
    throw new ApiError(503, 'BSC_RPC_INVALID_BLOCK', 'provider', 'BSC RPC returned invalid block numbers.', 'Nomor blok dari penyedia BSC tidak valid.');
  }
  const canonicalBlock = await bscRpcCall(rpc, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
  if (!canonicalBlock?.hash || String(canonicalBlock.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
    throw new ApiError(409, 'ONCHAIN_RECEIPT_NOT_CANONICAL', 'validation', 'The transaction receipt is not on the canonical BSC chain.', 'Blok transaksi belum cocok dengan rantai BSC yang kanonis.');
  }
  if (!finalized?.number || finalizedNumber < blockNumber) throw new ApiError(409, 'ONCHAIN_FINALITY_PENDING', 'validation', 'The BSC transaction has not reached finalized status.', 'Transaksi masih menunggu finalitas jaringan BSC.');
  const minConfirmations = Number(process.env.BSC_MIN_CONFIRMATIONS || 12);
  const confirmations = latestBlock - blockNumber + 1;
  if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || confirmations < minConfirmations) {
    throw new ApiError(409, 'ONCHAIN_CONFIRMATIONS_PENDING', 'validation', 'The transaction needs more configured confirmations.', 'Transaksi masih menunggu konfirmasi jaringan.');
  }
  const decimalsResult = await bscRpcCall(rpc, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);
  if (!/^0x[0-9a-f]+$/i.test(String(decimalsResult))) throw new ApiError(503, 'TOKEN_DECIMALS_INVALID', 'provider', 'USDT token decimals could not be verified.', 'Desimal token USDT tidak dapat diverifikasi.');
  const decimals = Number(BigInt(String(decimalsResult)));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new ApiError(503, 'TOKEN_DECIMALS_INVALID', 'provider', 'USDT token decimals are outside the supported range.', 'Desimal token USDT di luar dukungan.');
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a6d4b2b5c4';
  const destinationTopics = new Set([...destinations].map(evmTopicAddress));
  const sourceFilterTopic = input.source ? evmTopicAddress(input.source) : undefined;
  const matchingLogs = (receipt.logs || []).filter((log: any) =>
    String(log.address || '').toLowerCase() === token
    && String(log.topics?.[0] || '').toLowerCase() === transferTopic
    && destinationTopics.has(String(log.topics?.[2] || '').toLowerCase())
    && (!sourceFilterTopic || String(log.topics?.[1] || '').toLowerCase() === sourceFilterTopic)
    && /^0x[0-9a-f]+$/i.test(String(log.data || '')),
  );
  if (!matchingLogs.length) throw new ApiError(400, 'ONCHAIN_TRANSFER_NOT_FOUND', 'validation', 'No matching USDT Transfer event was found for the assigned address.', 'Transfer USDT ke alamat yang ditetapkan tidak ditemukan.');
  const matchedDestinationTopics = new Set(matchingLogs.map((log: any) => String(log.topics[2]).toLowerCase()));
  if (matchedDestinationTopics.size !== 1) throw new ApiError(422, 'ONCHAIN_MULTIPLE_DEPOSIT_ADDRESSES', 'validation', 'Use one assigned deposit address per transaction.', 'Gunakan satu alamat deposit khusus untuk setiap transaksi.');
  const matchedTopic = Array.from(matchedDestinationTopics)[0] as string;
  const sourceTopics = new Set(matchingLogs.map((log: any) => String(log.topics?.[1] || '').toLowerCase()));
  if(sourceTopics.size!==1) throw new ApiError(422,'ONCHAIN_MULTIPLE_DEPOSIT_SOURCES','validation','Each deposit transaction must have one source address for screening.','Setiap transaksi deposit harus memiliki satu alamat sumber untuk screening.');
  const sourceTopic=Array.from(sourceTopics)[0] as string;
  if(!/^0x[0-9a-f]{64}$/.test(sourceTopic)) throw new ApiError(400,'ONCHAIN_SOURCE_ADDRESS_INVALID','validation','The deposit source address could not be identified.','Alamat sumber deposit tidak dapat diidentifikasi.');
  const destination = `0x${matchedTopic.slice(-40)}`;
  const sourceAddress = '0x' + sourceTopic.slice(-40);
  const rawAmount = matchingLogs.reduce((sum: bigint, log: any) => sum + BigInt(String(log.data)), 0n);
  return { amountUnits: rawAmount, amount: unitsToLedgerAmount(rawAmount, decimals), destination, sourceAddress, blockNumber, confirmations, decimals, tokenContract: token, transferCount: matchingLogs.length, finalized: true };
}

// ==========================================
// WALLET & FINANCIAL ROUTES
// ==========================================

router.get('/api/wallet/deposit-address', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    const assignment = await ensureNativeDepositAddress(identity.uid);
    return res.json({
      success: true,
      address: String(assignment.address),
      qrPayload: String(assignment.qr_payload || assignment.address),
      provider: String(assignment.provider || 'native-bsc'),
      providerWalletId: String(assignment.provider_wallet_id || ''),
      walletType: String(assignment.provider_wallet_type || 'HD_DERIVED'),
      asset: 'USDT',
      network: 'BEP-20',
      chainId: 56,
      persistent: true,
      derivationIndex: assignment.derivation_index ?? null,
      derivationPath: assignment.derivation_path ?? null,
      createdAt: assignment.created_at,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/api/wallet/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    const result = await getUserLedgerTransactions({ firebaseUid: identity.uid, limit, offset });

    // No firestore sync needed in Phase 4

    return res.json({
      success: true,
      transactions: result.transactions,
      total: result.total,
      hasMore: result.hasMore,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/api/admin/wallet/deposit-address', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    const adminUid = await requireAdmin(req);
    await requireSecuritySession(req, adminUid);
    const memberId = String(req.body?.memberId || '').trim().toUpperCase();
    if (!/^GN-\d{5}$/.test(memberId)) return next(new ApiError(400, 'DEPOSIT_ADDRESS_ASSIGNMENT_INVALID', 'validation', 'A valid Member ID is required.', 'Member ID tidak valid.'));
    const owner = await getUserByMemberId(memberId);
    if (!owner?.firebase_uid) return next(new ApiError(404, 'DEPOSIT_ADDRESS_MEMBER_NOT_FOUND', 'not_found', 'Member tidak ditemukan.', 'Member tidak ditemukan.'));
    const assigned = await ensureNativeDepositAddress(owner.firebase_uid);
    await createAuditEvent({ eventType: 'admin.wallet.deposit_address.provisioned', payload: { adminUid, memberId, address: assigned.address, network: assigned.network, currency: assigned.currency, provider: assigned.provider, providerWalletId: assigned.provider_wallet_id } });
    res.json({ success: true, depositAddress: assigned.address, network: assigned.network, currency: assigned.currency, provider: assigned.provider, memberId: assigned.memberId });
  } catch (error) { next(error); }
});

router.post('/api/wallet/authorize-financial-action', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    const amount = Number(req.body?.amount);
    const allowedActions = new Set(['deposit','withdraw','transfer','activation','referral','trade']);
    if (!allowedActions.has(action) || !Number.isFinite(amount) || amount <= 0) return next(new ApiError(400,'FINANCIAL_ACTION_INVALID','validation','Financial action is invalid.','Aksi finansial tidak valid.'));
    await createAuditEvent({firebaseUid:identity.uid,eventType:'wallet.financial_action.validated',payload:{action,amount}});
    res.status(202).json({success:true,approved:false,validated:true,action,amount,currency:String(req.body?.currency||'USDT').slice(0,8),requestId:getRequestId(res),source:'server_authoritative_validation',note:'Validation only. Settlement must use its dedicated authoritative endpoint.'});
  } catch(error){ next(error); }
});

router.post('/api/member/transfer', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    const { identity } = await requireFirebaseIdentity(req);
    await requireSecuritySession(req, identity.uid);
    await requireFinancialRateLimit(identity.uid, 'transfer', 10);
    const amount = Number(req.body?.amount);
    const recipientMemberId = String(req.body?.recipientMemberId || '').trim().toUpperCase();
    if (!recipientMemberId || !Number.isFinite(amount) || amount <= 0) return next(new ApiError(400,'TRANSFER_INVALID','validation','Transfer parameters are invalid.','Parameter transfer tidak valid.'));
    const idempotencyKey = String(req.header('Idempotency-Key') || req.body?.idempotencyKey || '').trim();
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) return next(new ApiError(400,'TRANSFER_IDEMPOTENCY_REQUIRED','validation','A stable idempotency key is required for every transfer.','Kunci idempotensi transaksi wajib dikirim.'));
    const minAmount = Number.isFinite(Number(process.env.P2P_TRANSFER_MIN_AMOUNT_USDT)) && Number(process.env.P2P_TRANSFER_MIN_AMOUNT_USDT) > 0 ? Number(process.env.P2P_TRANSFER_MIN_AMOUNT_USDT) : 1;
    const maxAmount = requiredPositiveLimit('P2P_TRANSFER_MAX_AMOUNT_USDT');
    const dailyLimit = requiredPositiveLimit('P2P_TRANSFER_DAILY_LIMIT_USDT');
    if (amount < minAmount) return next(new ApiError(422,'TRANSFER_AMOUNT_BELOW_MINIMUM','validation',`Minimal transfer P2P adalah ${minAmount} USDT.`, `Minimal nominal transfer P2P adalah ${minAmount} USDT.`));
    const security=await getTwoFactorSecretRecord(identity.uid);
    const otp=String(req.body?.otp2fa||'').trim();
    if(!security?.two_factor_enabled||!security.two_factor_secret_ciphertext||!security.two_factor_secret_iv||!security.two_factor_secret_auth_tag) return next(new ApiError(403,'TRANSFER_2FA_REQUIRED','authorization','Two-factor authentication must be enabled.','Aktifkan 2FA sebelum transfer.'));
    const transferSecret=decryptSensitiveString({ciphertext:security.two_factor_secret_ciphertext,iv:security.two_factor_secret_iv,authTag:security.two_factor_secret_auth_tag});
    const transferVerification=verifyServerTotp(otp,transferSecret,1);
    if(!transferVerification.valid || transferVerification.counter===undefined || !(await consumeTotpCounter(identity.uid,transferVerification.counter))) return next(new ApiError(403,'TRANSFER_2FA_INVALID','authorization','The TOTP code is invalid or already used.','Kode Google Authenticator tidak valid atau sudah digunakan.'));
    const result = await transferFundsAtomic({ senderFirebaseUid:identity.uid, recipientMemberId, amount, note:typeof req.body?.note==='string'?req.body.note.slice(0,200):undefined, idempotencyKey, minAmount, maxAmount, dailyLimit });
    
    // Post-commit side effects: isolate Firestore sync to prevent network timeouts from failing an already-committed DB transfer
    try {
      if (!result.replayed) {
        await createAuditEvent({ firebaseUid:identity.uid, eventType:'wallet.transfer.completed', payload:{ transferId:result.transferId, recipientMemberId, amount, replayed:false } });
                const recipientUser = await getUserByMemberId(recipientMemberId);
        if (recipientUser?.firebase_uid) {
                            }
      }
          } catch (syncError) {
      console.warn('[P2P_TRANSFER_FIRESTORE_SYNC_WARNING]', String((syncError as any)?.message || syncError));
    }

    res.json({ success:true, ...result, amount, fee:0, status:'Completed', timestamp:Date.now() });
  } catch (error:any) { next(error); }
});

router.post('/api/wallet/topup-gas', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase(); const { identity }=await requireFirebaseIdentity(req); await requireSecuritySession(req, identity.uid); const amount=Number(req.body?.amount);
    if(!Number.isFinite(amount)||amount<10) return next(new ApiError(400,'GAS_TOPUP_INVALID','validation','Gas top-up amount is invalid.','Minimal alokasi gas pool adalah 10 USDT.'));
    const security=await getTwoFactorSecretRecord(identity.uid);
    if(security?.two_factor_enabled&&security.two_factor_secret_ciphertext&&security.two_factor_secret_iv&&security.two_factor_secret_auth_tag) {
      const otp=String(req.body?.otp2fa||req.body?.code||'').replace(/\D/g,'').trim();
      const secret=decryptSensitiveString({ciphertext:security.two_factor_secret_ciphertext,iv:security.two_factor_secret_iv,authTag:security.two_factor_secret_auth_tag});
      const verification=verifyServerTotp(otp,secret,1);
      if(!verification.valid||verification.counter===undefined||!(await consumeTotpCounter(identity.uid,verification.counter))) {
        return next(new ApiError(403,'GAS_TOPUP_2FA_INVALID','authorization','The TOTP code is invalid or already used.','Kode Google Authenticator tidak valid atau sudah digunakan.'));
      }
    }
    const idempotencyKey=String(req.header('Idempotency-Key')||req.body?.idempotencyKey||randomUUID()).slice(0,128);
    const result=await topupGasAtomic({firebaseUid:identity.uid,amount,idempotencyKey});
    if (!result.replayed) {
      await createAuditEvent({firebaseUid:identity.uid,eventType:'wallet.gas_topup.completed',payload:{amount,bonusUsdt:result.bonusUsdt,referralBonusUsdt:result.referralBonusUsdt,ledgerId:result.ledgerId}});
                }
    res.json({success:true,amount,bonusUsdt:result.bonusUsdt,referralBonusUsdt:result.referralBonusUsdt,newLiquidBalance:result.newBalance,newGasReserve:result.newGasReserve,ledgerId:result.ledgerId,replayed:result.replayed});
  } catch(error){next(error);}
});

router.get('/api/wallet/profit-share', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase(); const { identity }=await requireFirebaseIdentity(req); await requireSecuritySession(req, identity.uid);
    const summary=await getProfitShareSummary(identity.uid);
    res.json({
      success: true,
      config: {
        traderNetProfitPct: FINANCIAL_CONFIG.profitShare.traderNetProfitPct,
        platformProfitSharePct: FINANCIAL_CONFIG.profitShare.platformProfitSharePct,
        managementShareOfPlatformPct: FINANCIAL_CONFIG.profitShare.managementShareOfPlatformPct,
        uplineCashShareOfPlatformPct: FINANCIAL_CONFIG.profitShare.uplineCashShareOfPlatformPct,
        activationCashPct: FINANCIAL_CONFIG.referral.activationCashPct,
        tradingFeeCashPct: FINANCIAL_CONFIG.referral.tradingFeeCashPct,
        topupGasNonCashPct: FINANCIAL_CONFIG.referral.topupGasNonCashPct,
      },
      summary,
    });
  } catch(error){next(error);}
});

router.get('/api/wallet/auto-refill', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase(); const { identity }=await requireFirebaseIdentity(req); await requireSecuritySession(req, identity.uid);
    const config=await getGasAutoRefillConfig(identity.uid);
    res.json({success:true,config:config||{enabled:FINANCIAL_CONFIG.autoRefill.defaultEnabled,thresholdUsdt:FINANCIAL_CONFIG.autoRefill.thresholdUsdt,refillUsdt:FINANCIAL_CONFIG.autoRefill.refillUsdt,maxDailyUsdt:FINANCIAL_CONFIG.autoRefill.maxDailyUsdt,dailyRefilledUsdt:0,lastRefilledAt:null}});
  } catch(error){next(error);}
});

router.post('/api/wallet/auto-refill', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase(); const { identity }=await requireFirebaseIdentity(req); await requireSecuritySession(req, identity.uid);
    const enabled=Boolean(req.body?.enabled); const thresholdUsdt=Number(req.body?.thresholdUsdt??FINANCIAL_CONFIG.autoRefill.thresholdUsdt); const refillUsdt=Number(req.body?.refillUsdt??FINANCIAL_CONFIG.autoRefill.refillUsdt); const maxDailyUsdt=Number(req.body?.maxDailyUsdt??FINANCIAL_CONFIG.autoRefill.maxDailyUsdt);
    if (!Number.isFinite(thresholdUsdt) || thresholdUsdt < 1 || thresholdUsdt > 1000 || !Number.isFinite(refillUsdt) || refillUsdt < 1 || refillUsdt > 5000 || !Number.isFinite(maxDailyUsdt) || maxDailyUsdt < refillUsdt || maxDailyUsdt > 10000 || thresholdUsdt > maxDailyUsdt) {
      return next(new ApiError(400,'AUTO_REFILL_CONFIG_INVALID','validation','Auto-refill configuration is invalid.','Konfigurasi auto-refill tidak valid.'));
    }
    const config=await upsertGasAutoRefillConfig({firebaseUid:identity.uid,enabled,thresholdUsdt,refillUsdt,maxDailyUsdt});
    await createAuditEvent({firebaseUid:identity.uid,eventType:'wallet.gas_auto_refill.changed',payload:{enabled,thresholdUsdt,refillUsdt,maxDailyUsdt}});
    res.json({success:true,config});
  } catch(error){next(error);}
});

router.post('/api/wallet/process-activation', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    await requireSecuritySession(req, identity.uid);
    const tier = req.body?.tier === 'pro_12' ? 'pro_12' : req.body?.tier === 'starter_6' ? 'starter_6' : '';
    if (!tier) return next(new ApiError(400,'ACTIVATION_REQUEST_INVALID','validation','Activation tier is invalid.','Paket aktivasi tidak valid.'));
    const isPro=tier==='pro_12';
    const tierConfig = getLicenseTierConfig(isPro ? 'pro_12' : 'starter_6');
    const fee=tierConfig.promoPriceUsdt;
    const tradingBonus=tierConfig.gasBonusUsdt;
    const maxActiveBots=tierConfig.maxActiveBots;
    const licenseName=isPro?'Lisensi Lifetime Pro (12 Bot Aktif)':'Lisensi Lifetime Starter (6 Bot Aktif)';
    const idempotencyKey=String(req.get('Idempotency-Key')||req.body?.idempotencyKey||'').trim();
    const voucherCode=req.body?.voucherCode ? String(req.body.voucherCode).trim() : undefined;
    if (idempotencyKey.length > 200) return next(new ApiError(400,'ACTIVATION_IDEMPOTENCY_KEY_INVALID','validation','Idempotency key is too long.','Idempotency key aktivasi terlalu panjang.'));
    const result=await activateLicenseAtomic({firebaseUid:identity.uid,tier,fee,tradingBonus,maxActiveBots,licenseName,idempotencyKey:idempotencyKey||undefined,voucherCode});
    const feeDeducted = result.effectiveFee !== undefined ? result.effectiveFee : fee;
    if (!result.replayed) {
      await createAuditEvent({firebaseUid:identity.uid,eventType:'wallet.activation.completed',payload:{activationId:result.activationId,tier,fee:feeDeducted,tradingBonus,voucherCode:voucherCode||null,discountAmount:result.discountAmount||0}});
            if (result.referralSponsorFirebaseUid && result.referralBonus > 0) {
                      }
    }
        res.json({success:true,replayed:Boolean(result.replayed),accountStatus:'active',licenseStatus:'active',memberStatus:'active',licenseTier:tier,licenseType:'lifetime',licenseName,maxActiveBots,feeDeducted,tradingBonusGranted:tradingBonus,newLiquidBalance:result.newBalance,newGasReserve:result.gasReserve,activationReceipt:{activationId:result.activationId,userId:identity.uid,memberId:result.memberId,timestamp:new Date().toISOString(),licenseType:'lifetime',plan:licenseName,tradingBonusUsdt:tradingBonus,maxActiveBots,referralBonusUsdt:result.referralBonus || 0,referralEventId:result.referralEventId || null}});
  } catch(error:any){ next(error); }
});

// Admin Voucher Management Routes
router.get('/api/admin/vouchers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    await requireAdmin(req);
    const vouchers = await getVouchersFromDb();
    res.json({ success: true, vouchers });
  } catch (error) { next(error); }
});

router.post('/api/admin/vouchers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const adminUid = await requireAdmin(req);
    await requireSecuritySession(req, adminUid);
    const voucher = await createVoucherInDb(req.body);
    await createAuditEvent({ firebaseUid: adminUid, eventType: 'admin.voucher.created', payload: { voucherId: voucher.id, code: voucher.code } });
    res.json({ success: true, voucher });
  } catch (error) { next(error); }
});

router.patch('/api/admin/vouchers/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const adminUid = await requireAdmin(req);
    await requireSecuritySession(req, adminUid);
    const voucher = await toggleVoucherStatusInDb(req.params.id, Boolean(req.body?.isActive));
    await createAuditEvent({ firebaseUid: adminUid, eventType: 'admin.voucher.status_toggled', payload: { voucherId: voucher.id, isActive: voucher.isActive } });
    res.json({ success: true, voucher });
  } catch (error) { next(error); }
});

router.delete('/api/admin/vouchers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const adminUid = await requireAdmin(req);
    await requireSecuritySession(req, adminUid);
    await deleteVoucherInDb(req.params.id);
    await createAuditEvent({ firebaseUid: adminUid, eventType: 'admin.voucher.deleted', payload: { voucherId: req.params.id } });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.post('/api/wallet/validate-voucher', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    const tier = req.body?.tier === 'pro_12' ? 'pro_12' : req.body?.tier === 'starter_6' ? 'starter_6' : '';
    if (!tier) return next(new ApiError(400, 'VOUCHER_TIER_INVALID', 'validation', 'License tier is required for voucher validation.', 'Paket lisensi diperlukan untuk validasi voucher.'));
    const tierConfig = getLicenseTierConfig(tier);
    const voucher = await validateVoucherForUserInDb({
      code: String(req.body?.code || ''),
      firebaseUid: identity.uid,
      tier,
      originalFee: tierConfig.promoPriceUsdt,
    });
    res.json({ success: true, valid: true, voucher });
  } catch (error) { next(error); }
});

router.get('/api/wallet/deposit-policy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireFinancialOperationsReady();
    await requireFirebaseIdentity(req);
    res.json({success:true,minimumAmount:requiredPositiveLimit('DEPOSIT_MIN_AMOUNT_USDT'),maximumAmount:requiredPositiveLimit('DEPOSIT_MAX_AMOUNT_USDT'),minimumConfirmations:requiredPositiveLimit('BSC_MIN_CONFIRMATIONS')});
  } catch(error){next(error);}
});

router.post('/api/wallet/verify-deposit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    const { identity } = await requireFirebaseIdentity(req);
    await requireFinancialRateLimit(identity.uid, 'deposit-verification', 6);
    const txHash=String(req.body?.txHash||'').trim();
    const submittedNetwork=String(req.body?.network||'BEP-20').trim().toUpperCase();
    const network = ['BEP-20', 'BEP-20 (BNB SMART CHAIN)'].includes(submittedNetwork) ? 'BEP-20' : submittedNetwork;
    const requestedAmount=Number(req.body?.amount);
    if(!/^0x[a-fA-F0-9]{64}$/.test(txHash)) return next(new ApiError(400,'DEPOSIT_TX_HASH_INVALID','validation','A valid EVM transaction hash is required.','TX hash BSC/EVM tidak valid.'));
    const depositMinimum=requiredPositiveLimit('DEPOSIT_MIN_AMOUNT_USDT');
    const depositMaximum=requiredPositiveLimit('DEPOSIT_MAX_AMOUNT_USDT');
    const depositDailyLimit=requiredPositiveLimit('DEPOSIT_DAILY_LIMIT_USDT');
    if(!Number.isFinite(requestedAmount)||requestedAmount<depositMinimum||requestedAmount>depositMaximum) return next(new ApiError(400,'DEPOSIT_AMOUNT_INVALID','validation','Deposit amount is outside the configured range.','Nominal deposit di luar batas yang dikonfigurasi.'));
    if(network!=='BEP-20') return next(new ApiError(400,'DEPOSIT_NETWORK_UNSUPPORTED','validation','Only BEP-20 verification is enabled in this release.','Saat ini verifikasi on-chain hanya mendukung BEP-20.'));
    const assignedAddresses = await getWalletDepositAddresses(identity.uid, 'BEP-20');
    if (!assignedAddresses.length) return next(new ApiError(409,'DEPOSIT_ADDRESS_NOT_PROVISIONED','configuration','This member has no custody-provider deposit address assigned.','Alamat deposit khusus akun ini belum disiapkan oleh kustodian.'));
    const verified = await verifyBscUsdtTransfer({ txHash, destinations: assignedAddresses.map((entry: any) => String(entry.address).toLowerCase()) });
    if (decimalAmountToUnits(req.body?.amount, verified.decimals) !== verified.amountUnits) return next(new ApiError(400,'DEPOSIT_AMOUNT_MISMATCH','validation','The submitted amount must exactly match the on-chain amount.','Nominal harus sama persis dengan jumlah on-chain.'));
    const onchainAmount=verified.amount;
    const screeningProvider = String(process.env.FINANCIAL_SCREENING_PROVIDER || 'native-bsc');
    const pending=await recordConfirmedDeposit({firebaseUid:identity.uid,network,txHash:txHash.toLowerCase(),amount:onchainAmount,maxAmount:depositMaximum,dailyLimit:depositDailyLimit,blockNumber:verified.blockNumber,confirmations:verified.confirmations,destinationAddress:verified.destination,sourceAddress:verified.sourceAddress,screeningProvider});
    let effectiveStatus = pending.status;
    if (!pending.replayed && screeningProvider === 'native-bsc') {
      const cleared = await applyDepositScreeningResult({
        depositId: String(pending.depositId),
        provider: 'native-bsc',
        providerEventId: `native-bsc:manual:${txHash.toLowerCase()}`,
        status: 'CLEAR',
        reasonCode: 'NATIVE_BSC_ONCHAIN_VERIFIED',
        reference: txHash.toLowerCase(),
      });
      effectiveStatus = cleared.status;
      await createAuditEvent({firebaseUid:identity.uid,eventType:'wallet.deposit.native_bsc_credited',payload:{depositId:pending.depositId,txHash:txHash.toLowerCase(),amount:onchainAmount,sourceAddress:verified.sourceAddress,blockNumber:verified.blockNumber,confirmations:verified.confirmations}});
    } else if (!pending.replayed) {
      await createAuditEvent({firebaseUid:identity.uid,eventType:'wallet.deposit.screening_pending',payload:{depositId:pending.depositId,txHash:txHash.toLowerCase(),amount:onchainAmount,sourceAddress:verified.sourceAddress,blockNumber:verified.blockNumber,confirmations:verified.confirmations,tokenContract:verified.tokenContract,finalized:verified.finalized}});
    }
        res.json({success:true,message:effectiveStatus==='CREDITED'?'Deposit BSC terverifikasi dan saldo sudah dikreditkan.':'Deposit terverifikasi on-chain dan menunggu screening sumber.',txHash:txHash.toLowerCase(),network,amount:onchainAmount,blockNumber:verified.blockNumber,confirmations:verified.confirmations,status:effectiveStatus,depositId:pending.depositId,verifiedAt:new Date().toISOString()});
  } catch(error){ next(error); }
});

router.get('/api/admin/financial-readiness', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireAdmin(req);
    res.json({success:true,...getFinancialOperationsReadiness()});
  } catch(error){next(error);}
});

router.get('/api/admin/financial-wallet/native-bsc/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    await requireAdmin(req);
    res.json({ success: true, wallet: await getNativeWalletStatus() });
  } catch (error) { next(error); }
});

router.post('/api/admin/financial-wallet/native-bsc/hot-wallet', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const adminUid = await requireAdmin(req);
    await requireSecuritySession(req, adminUid);
    const privateKey = String(req.body?.privateKey || '').trim();
    const expectedAddress = String(req.body?.address || '').trim();
    const enabled = req.body?.enabled !== false;
    const autoWithdrawalMaxAmount = req.body?.autoWithdrawalMaxAmount !== undefined ? Number(req.body.autoWithdrawalMaxAmount) : undefined;
    if (!privateKey) return next(new ApiError(400, 'HOT_WALLET_PRIVATE_KEY_REQUIRED', 'validation', 'Hot-wallet private key is required.', 'Private key hot wallet wajib diisi.'));
    const result = await configureNativeHotWallet({ privateKey, expectedAddress: expectedAddress || undefined, enabled, autoWithdrawalMaxAmount, adminUid });
    await createAuditEvent({ firebaseUid: adminUid, eventType: 'admin.native_bsc.hot_wallet.configured', payload: { address: result.address, enabled: result.enabled, autoWithdrawalMaxAmount: result.autoWithdrawalMaxAmount, network: 'BSC' } });
    res.json({ success: true, address: result.address, enabled: result.enabled, autoWithdrawalMaxAmount: result.autoWithdrawalMaxAmount });
  } catch (error) { next(error); }
});

router.post('/api/admin/financial-wallet/native-bsc/hot-wallet/toggle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const adminUid = await requireAdmin(req);
    await requireSecuritySession(req, adminUid);
    const enabled = req.body?.enabled === true;
    const autoWithdrawalMaxAmount = req.body?.autoWithdrawalMaxAmount !== undefined ? Number(req.body.autoWithdrawalMaxAmount) : undefined;
    const result = await setNativeHotWalletEnabled({ enabled, autoWithdrawalMaxAmount, adminUid });
    await createAuditEvent({ firebaseUid: adminUid, eventType: 'admin.native_bsc.hot_wallet.toggled', payload: { address: result.address, enabled: result.enabled, autoWithdrawalMaxAmount: result.autoWithdrawalMaxAmount } });
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

router.get('/api/admin/financial-wallet/native-bsc/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    await requireAdmin(req);
    res.json({ success: true, users: await getNativeBscUserBalances(Number(req.query.limit || 2000)) });
  } catch (error) { next(error); }
});

router.get('/api/admin/financial-wallet/native-bsc/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    await requireAdmin(req);
    res.json({ success: true, transactions: await listFinancialTransactions(Number(req.query.limit || 300)), serverTime: new Date().toISOString() });
  } catch (error) { next(error); }
});

router.get('/api/admin/financial-wallet/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    await requireAdmin(req);
    const [overview, users, native] = await Promise.all([
      getFinancialWalletOverview(),
      getNativeBscUserBalances(2000),
      getNativeWalletStatus(),
    ]);
    res.json({
      success: true,
      overview,
      users,
      native,
      asset: {
        symbol: 'USDT',
        network: 'BEP-20',
        chainId: 56,
        contract: String(process.env.BSC_USDT_CONTRACT || '0x55d398326f99059fF775485246999027B3197955'),
        decimals: 18,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/api/wallet/withdrawal-addresses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const {identity}=await requireFirebaseIdentity(req);
    res.json({success:true,addresses:await listWithdrawalAddresses(identity.uid)});
  } catch(error){next(error);}
});

router.get('/api/wallet/withdrawal-policy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireFinancialOperationsReady();
    await requireFirebaseIdentity(req);
    res.json({success:true,minimumAmount:requiredPositiveLimit('WITHDRAWAL_MIN_AMOUNT_USDT'),maximumAmount:requiredPositiveLimit('WITHDRAWAL_MAX_AMOUNT_USDT'),fee:requiredPositiveLimit('WITHDRAWAL_FEE_USDT'),addressCooldownHours:requiredPositiveLimit('WITHDRAWAL_ADDRESS_COOLDOWN_HOURS')});
  } catch(error){next(error);}
});

router.post('/api/wallet/withdrawal-addresses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    const {identity}=await requireFirebaseIdentity(req);
    await requireSecuritySession(req,identity.uid);
    await requireFinancialRateLimit(identity.uid,'withdrawal-address-enroll',4);
    const address=String(req.body?.address||'').trim().toLowerCase();
    const label=String(req.body?.label||'').trim().slice(0,80);
    const otp=String(req.body?.otp2fa||'').trim();
    if(!/^0x[a-f0-9]{40}$/.test(address)) return next(new ApiError(400,'WITHDRAW_ADDRESS_INVALID','validation','A valid BEP-20 destination is required.','Alamat tujuan BEP-20 tidak valid.'));
    const security=await getTwoFactorSecretRecord(identity.uid);
    if(!security?.two_factor_enabled||!security.two_factor_secret_ciphertext||!security.two_factor_secret_iv||!security.two_factor_secret_auth_tag) return next(new ApiError(403,'WITHDRAW_2FA_REQUIRED','authorization','Two-factor authentication must be enabled.','Aktifkan 2FA sebelum mendaftarkan alamat.'));
    const secret=decryptSensitiveString({ciphertext:security.two_factor_secret_ciphertext,iv:security.two_factor_secret_iv,authTag:security.two_factor_secret_auth_tag});
    const verification=verifyServerTotp(otp,secret,1);
    if(!verification.valid||verification.counter===undefined||!(await consumeTotpCounter(identity.uid,verification.counter))) return next(new ApiError(403,'WITHDRAW_2FA_INVALID','authorization','The TOTP code is invalid or already used.','Kode Google Authenticator tidak valid atau sudah digunakan.'));
    const cooldownHours=requiredPositiveLimit('WITHDRAWAL_ADDRESS_COOLDOWN_HOURS');
    const entry=await registerWithdrawalAddress({firebaseUid:identity.uid,address,label,cooldownHours});
    await createAuditEvent({firebaseUid:identity.uid,eventType:'wallet.withdrawal_address.enrolled',payload:{addressId:entry.id,network:entry.network,cooldownUntil:entry.cooldown_until}});
    res.status(entry.replayed?200:201).json({success:true,address:entry.address,label:entry.label,status:entry.status,cooldownUntil:entry.cooldown_until,replayed:entry.replayed});
  } catch(error){next(error);}
});

router.delete('/api/wallet/withdrawal-addresses/:addressId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    const {identity}=await requireFirebaseIdentity(req);
    await requireSecuritySession(req,identity.uid);
    const security=await getTwoFactorSecretRecord(identity.uid);
    const otp=String(req.body?.otp2fa||'').trim();
    if(!security?.two_factor_enabled||!security.two_factor_secret_ciphertext||!security.two_factor_secret_iv||!security.two_factor_secret_auth_tag) return next(new ApiError(403,'WITHDRAW_2FA_REQUIRED','authorization','Two-factor authentication must be enabled.','Aktifkan 2FA sebelum menghapus alamat.'));
    const secret=decryptSensitiveString({ciphertext:security.two_factor_secret_ciphertext,iv:security.two_factor_secret_iv,authTag:security.two_factor_secret_auth_tag});
    const verification=verifyServerTotp(otp,secret,1);
    if(!verification.valid||verification.counter===undefined||!(await consumeTotpCounter(identity.uid,verification.counter))) return next(new ApiError(403,'WITHDRAW_2FA_INVALID','authorization','The TOTP code is invalid or already used.','Kode Google Authenticator tidak valid atau sudah digunakan.'));
    const result=await removeWithdrawalAddress(identity.uid,String(req.params.addressId||''));
    await createAuditEvent({firebaseUid:identity.uid,eventType:'wallet.withdrawal_address.removed',payload:{addressId:String(req.params.addressId||'')}});
    res.json({success:true,...result});
  } catch(error){next(error);}
});

router.get('/api/admin/withdrawals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    await requireAdmin(req);
    const rows=await listWithdrawalQueue(String(req.query.status||'REVIEW'),Number(req.query.limit||100));
    res.json({success:true,withdrawals:rows,requiredApprovals:2});
  } catch(error){next(error);}
});

router.post('/api/admin/withdrawals/:withdrawalId/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const adminUid=await requireAdmin(req);
    await requireSecuritySession(req,adminUid);
    const result=await recordWithdrawalApproval({withdrawalId:String(req.params.withdrawalId||''),adminUid,reason:String(req.body?.reason||'').slice(0,400)});
    await createAuditEvent({firebaseUid:adminUid,eventType:'admin.withdrawal.approved',payload:{withdrawalId:String(req.params.withdrawalId||''),approvalCount:result.approvalCount,status:result.status}});
    res.json({success:true,...result});
  } catch(error){next(error);}
});

router.post('/api/admin/withdrawals/:withdrawalId/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const adminUid=await requireAdmin(req);
    await requireSecuritySession(req,adminUid);
    const reason=String(req.body?.reason||'Rejected by authorized financial operator').trim();
    if(reason.length<8) return next(new ApiError(400,'WITHDRAWAL_REJECTION_REASON_REQUIRED','validation','A rejection reason is required.','Alasan penolakan wajib diisi.'));
    const result=await rejectWithdrawal(String(req.params.withdrawalId||''),reason);
    await createAuditEvent({firebaseUid:adminUid,eventType:'admin.withdrawal.rejected',payload:{withdrawalId:String(req.params.withdrawalId||''),reason:reason.slice(0,200)}});
    res.json({success:true,...result});
  } catch(error){next(error);}
});

router.post('/api/internal/withdrawals/screening-result', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    await requireWithdrawalProcessorSignature(req,'FINANCIAL_SCREENING_HANDOFF_SECRET');
    const provider=String(req.body?.provider||'').trim();
    if(provider!==String(process.env.FINANCIAL_SCREENING_PROVIDER||'')) return next(new ApiError(403,'SCREENING_PROVIDER_MISMATCH','authorization','Screening provider does not match configured provider.','Provider screening tidak sesuai konfigurasi.'));
    const status=String(req.body?.status||'').toUpperCase();
    if(!['CLEAR','BLOCKED','ERROR'].includes(status)) return next(new ApiError(400,'SCREENING_RESULT_INVALID','validation','Screening result is invalid.','Hasil screening tidak valid.'));
    const result=await applyWithdrawalScreeningResult({
      withdrawalId:String(req.body?.withdrawalId||''),provider,
      providerEventId:String(req.body?.providerEventId||''),
      status:status as 'CLEAR'|'BLOCKED'|'ERROR',
      reasonCode:String(req.body?.reasonCode||'').slice(0,100),
      reference:String(req.body?.reference||'').slice(0,200),
    });
    await createAuditEvent({eventType:'financial.withdrawal.screened',payload:{withdrawalId:String(req.body?.withdrawalId||''),provider,status:result.status,replayed:result.replayed}});
    res.json({success:true,...result});
  } catch(error){next(error);}
});

router.post('/api/internal/deposits/screening-result', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    await requireWithdrawalProcessorSignature(req,'FINANCIAL_SCREENING_HANDOFF_SECRET');
    const provider=String(req.body?.provider||'').trim();
    if(provider!==String(process.env.FINANCIAL_SCREENING_PROVIDER||'')) return next(new ApiError(403,'SCREENING_PROVIDER_MISMATCH','authorization','Screening provider does not match configured provider.','Provider screening tidak sesuai konfigurasi.'));
    const status=String(req.body?.status||'').toUpperCase();
    if(!['CLEAR','BLOCKED','ERROR'].includes(status)) return next(new ApiError(400,'SCREENING_RESULT_INVALID','validation','Screening result is invalid.','Hasil screening tidak valid.'));
    const result=await applyDepositScreeningResult({depositId:String(req.body?.depositId||''),provider,providerEventId:String(req.body?.providerEventId||''),status:status as 'CLEAR'|'BLOCKED'|'ERROR',reasonCode:String(req.body?.reasonCode||'').slice(0,100),reference:String(req.body?.reference||'').slice(0,200)});
    if(result.status==='CREDITED') {
                }
    await createAuditEvent({eventType:'financial.deposit.screened',payload:{depositId:String(req.body?.depositId||''),provider,status:result.status,replayed:result.replayed}});
    res.json({success:true,...result});
  } catch(error){next(error);}
});

router.post('/api/internal/custody/deposit-address', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    await requireWithdrawalProcessorSignature(req,'FINANCIAL_CUSTODY_HANDOFF_SECRET');
    const provider=String(req.body?.provider||'').trim();
    if(provider!==String(process.env.FINANCIAL_CUSTODY_PROVIDER||'')) return next(new ApiError(403,'CUSTODY_PROVIDER_MISMATCH','authorization','Custody provider does not match configured provider.','Provider kustodian tidak sesuai konfigurasi.'));
    const memberId=String(req.body?.memberId||'').trim().toUpperCase();
    const address=String(req.body?.address||'').trim();
    const providerWalletId=String(req.body?.providerWalletId||'').trim();
    if(!/^GN-\d{5}$/.test(memberId)||!/^0x[a-fA-F0-9]{40}$/.test(address)||!providerWalletId) return next(new ApiError(400,'DEPOSIT_ADDRESS_ASSIGNMENT_INVALID','validation','Member, provider wallet ID, and BSC address are required.','Member ID, ID wallet kustodian, dan alamat BEP-20 wajib diisi.'));
    const owner=await getUserByMemberId(memberId);
    if(!owner?.firebase_uid) return next(new ApiError(404,'DEPOSIT_ADDRESS_MEMBER_NOT_FOUND','not_found','Member was not found.','Member tidak ditemukan.'));
    const assigned=await provisionWalletDepositAddress({firebaseUid:owner.firebase_uid,address,provider,providerWalletId});
    await createAuditEvent({firebaseUid:owner.firebase_uid,eventType:'custody.deposit_address.provisioned',payload:{memberId,address:assigned.address,provider,providerWalletId:assigned.provider_wallet_id,replayed:assigned.replayed}});
        res.json({success:true,address:assigned.address,network:assigned.network,currency:assigned.currency,replayed:assigned.replayed});
  } catch(error){next(error);}
});

router.post('/api/internal/withdrawals/claim', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    await requireWithdrawalProcessorSignature(req);
    const processorId=String(req.body?.processorId||'').trim();
    if(!/^[A-Za-z0-9._-]{1,80}$/.test(processorId)) return next(new ApiError(400,'PROCESSOR_ID_INVALID','validation','A valid payout processor ID is required.','ID payout processor tidak valid.'));
    const leaseSeconds=requiredPositiveLimit('WITHDRAWAL_PROCESSOR_LEASE_SECONDS');
    const maxAttempts=requiredPositiveLimit('WITHDRAWAL_MAX_PROCESSOR_ATTEMPTS');
    if(!Number.isInteger(leaseSeconds)||!Number.isInteger(maxAttempts)) return next(new ApiError(503,'PROCESSOR_POLICY_INVALID','configuration','Processor lease and retry limits must be whole numbers.','Batas lease dan percobaan processor harus bilangan bulat.'));
    const claim=await claimNextWithdrawal({processorId,leaseSeconds,maxAttempts});
    res.json({success:true,claim});
  } catch(error){next(error);}
});

router.post('/api/internal/withdrawals/payout-submitted', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    await requireWithdrawalProcessorSignature(req);
    const provider=String(req.body?.provider||'').trim();
    if(provider!==String(process.env.FINANCIAL_CUSTODY_PROVIDER||'')) return next(new ApiError(403,'CUSTODY_PROVIDER_MISMATCH','authorization','Custody provider does not match configured provider.','Provider kustodian tidak sesuai konfigurasi.'));
    const withdrawalId=String(req.body?.withdrawalId||'');
    const claimId=String(req.body?.claimId||'');
    const providerPayoutId=String(req.body?.providerPayoutId||'').trim();
    if(!/^[0-9a-f-]{36}$/i.test(claimId)||!providerPayoutId) return next(new ApiError(400,'PAYOUT_SUBMISSION_INVALID','validation','Payout claim and provider reference are required.','Claim payout dan referensi provider wajib diisi.'));
    const result=await markWithdrawalPayoutSubmitted({withdrawalId,claimId,providerPayoutId});
    await createAuditEvent({eventType:'financial.withdrawal.payout_submitted',payload:{withdrawalId,provider,replayed:result.replayed}});
    res.json({success:true,...result});
  } catch(error){next(error);}
});

router.post('/api/internal/withdrawals/settle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    await requireWithdrawalProcessorSignature(req);
    const withdrawalId=String(req.body?.withdrawalId||''); const txHash=String(req.body?.txHash||''); const claimId=String(req.body?.claimId||'');
    if(!withdrawalId||!/^0x[a-fA-F0-9]{64}$/.test(txHash)||!/^[0-9a-f-]{36}$/i.test(claimId)) return next(new ApiError(400,'SETTLEMENT_INVALID','validation','Settlement parameters are invalid.','Parameter settlement tidak valid.'));
    const withdrawalRows = await dbQuery<any>(`SELECT w.id,w.network,w.destination_address,w.net_amount,w.currency,w.status,w.tx_hash,w.processor_claim_id,w.provider_payout_id,w.screening_status FROM withdrawals w WHERE w.id=$1`, [withdrawalId]);
    const withdrawal = withdrawalRows.rows[0];
    if (!withdrawal) return next(new ApiError(404,'WITHDRAWAL_NOT_FOUND','not_found','Withdrawal was not found.','Withdrawal tidak ditemukan.'));
    if (withdrawal.network !== 'BEP-20' || withdrawal.currency !== 'USDT') return next(new ApiError(400,'SETTLEMENT_NETWORK_UNSUPPORTED','validation','Only BEP-20 USDT settlement verification is enabled.','Settlement saat ini hanya mendukung USDT BEP-20.'));
    if(String(withdrawal.processor_claim_id)!==claimId||!withdrawal.provider_payout_id||withdrawal.screening_status!=='CLEAR') return next(new ApiError(409,'PAYOUT_CLAIM_INVALID','state','The active payout claim, provider submission, and screening clearance are required.','Claim payout aktif, submission kustodian, dan screening CLEAR wajib tersedia.'));
    if (!['PROCESSING','SENT','CONFIRMED'].includes(String(withdrawal.status))) return next(new ApiError(409,'WITHDRAWAL_STATE_CONFLICT','state','Withdrawal requires screening clearance and two approvals before settlement.','Withdrawal wajib lolos screening dan dua persetujuan sebelum settlement.'));
    if (['SENT','CONFIRMED'].includes(String(withdrawal.status)) && String(withdrawal.tx_hash || '').toLowerCase() !== txHash.toLowerCase()) return next(new ApiError(409,'WITHDRAWAL_SETTLEMENT_CONFLICT','state','Withdrawal was already settled with a different transaction.','Withdrawal sudah diselesaikan dengan transaksi berbeda.'));
    const hotWallet = String(process.env.BSC_TREASURY_HOT_ADDRESS || '').trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(hotWallet)) return next(new ApiError(503,'TREASURY_HOT_WALLET_NOT_CONFIGURED','configuration','BSC_TREASURY_HOT_ADDRESS must match the approved hot-wallet send address.','Alamat hot wallet GAIN belum dikonfigurasi dengan benar.'));
    const verified = await verifyBscUsdtTransfer({ txHash:txHash.toLowerCase(), destinations:[String(withdrawal.destination_address)], source:hotWallet });
    if (verified.amountUnits !== decimalAmountToUnits(withdrawal.net_amount, verified.decimals)) return next(new ApiError(400,'SETTLEMENT_AMOUNT_MISMATCH','validation','On-chain amount must exactly equal the withdrawal net amount.','Nominal on-chain harus sama persis dengan net amount withdrawal.'));
    const result=await settleWithdrawal({withdrawalId,txHash:txHash.toLowerCase(),claimId,verifiedAt:new Date().toISOString(),metadata:{blockNumber:verified.blockNumber,confirmations:verified.confirmations,tokenContract:verified.tokenContract,sourceAddress:hotWallet,destinationAddress:withdrawal.destination_address,onchainAmount:verified.amount,finalized:verified.finalized}});
    res.json({success:true,...result});
  } catch(error){next(error);}
});

router.post('/api/internal/withdrawals/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    await requireWithdrawalProcessorSignature(req);
    const withdrawalId=String(req.body?.withdrawalId||''); const reason=String(req.body?.reason||'Rejected by settlement operator');
    const result=await rejectWithdrawal(withdrawalId,reason);
    res.json({success:true,...result});
  } catch(error){next(error);}
});

router.post('/api/wallet/submit-withdraw', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    requireFinancialOperationsReady();
    const { identity } = await requireFirebaseIdentity(req);
    await requireSecuritySession(req, identity.uid);
    await requireFinancialRateLimit(identity.uid, 'withdrawal', 5);
    const address=String(req.body?.address||'').trim().toLowerCase(); const network=String(req.body?.network||'BEP-20').trim().toUpperCase(); const amount=Number(req.body?.amount); const otp=String(req.body?.otp2fa||'').trim();
    if(!/^0x[a-fA-F0-9]{40}$/.test(address)) return next(new ApiError(400,'WITHDRAW_ADDRESS_INVALID','validation','Withdrawal address is invalid.','Alamat BEP-20 tidak valid.'));
    if(network!=='BEP-20') return next(new ApiError(400,'WITHDRAW_NETWORK_UNSUPPORTED','validation','Only BEP-20 USDT withdrawals are enabled.','Withdrawal hanya tersedia melalui jaringan BEP-20.'));
    const minimumAmount=requiredPositiveLimit('WITHDRAWAL_MIN_AMOUNT_USDT');
    if(!Number.isFinite(amount)||amount<minimumAmount) return next(new ApiError(400,'WITHDRAW_AMOUNT_INVALID','validation','Withdrawal amount is invalid.','Nominal withdrawal berada di bawah minimum yang dikonfigurasi.'));
    const idempotencyKey=String(req.header('Idempotency-Key')||req.body?.idempotencyKey||'').trim();
    if(!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) return next(new ApiError(400,'WITHDRAW_IDEMPOTENCY_REQUIRED','validation','A stable idempotency key is required for every withdrawal.','Kunci idempotensi transaksi wajib dikirim.'));
    const maxAmount=requiredPositiveLimit('WITHDRAWAL_MAX_AMOUNT_USDT');
    const dailyLimit=requiredPositiveLimit('WITHDRAWAL_DAILY_LIMIT_USDT');
    const security=await getTwoFactorSecretRecord(identity.uid); if(!security?.two_factor_enabled||!security.two_factor_secret_ciphertext||!security.two_factor_secret_iv||!security.two_factor_secret_auth_tag) return next(new ApiError(403,'WITHDRAW_2FA_REQUIRED','authorization','Two-factor authentication must be enabled.','Aktifkan 2FA sebelum withdrawal.'));
    const secret=decryptSensitiveString({ciphertext:security.two_factor_secret_ciphertext,iv:security.two_factor_secret_iv,authTag:security.two_factor_secret_auth_tag}); const verification=verifyServerTotp(otp,secret,1); if(!verification.valid || verification.counter===undefined || !(await consumeTotpCounter(identity.uid,verification.counter))) return next(new ApiError(403,'WITHDRAW_2FA_INVALID','authorization','The TOTP code is invalid or already used.','Kode Google Authenticator tidak valid atau sudah digunakan.'));
    const fee=requiredPositiveLimit('WITHDRAWAL_FEE_USDT');
    const hotWalletDailyCap=requiredPositiveLimit('WITHDRAWAL_HOT_WALLET_DAILY_CAP_USDT');
    const result=await createWithdrawalRequest({firebaseUid:identity.uid,address,amount,fee,network,idempotencyKey,maxAmount,dailyLimit,hotWalletDailyCap,screeningProvider:String(process.env.FINANCIAL_SCREENING_PROVIDER||'native-bsc')});
    let nativeAutoQueued = false;
    if (!result.replayed && network === 'BEP-20') {
      try {
        const native = await getNativeWalletStatus();
        if (native.autoWithdrawalEnabled) {
          const queueRes = await queueNativeBscWithdrawal(String(result.id), native.autoWithdrawalMaxAmount);
          if (queueRes.status === 'PROCESSING') {
            nativeAutoQueued = true;
          }
        }
      } catch (nativeError) {
        console.warn('[NATIVE_BSC_WITHDRAWAL_QUEUE_FAILED]', String((nativeError as any)?.message || nativeError));
      }
    }
    if (!result.replayed) {
      await createAuditEvent({firebaseUid:identity.uid,eventType:'wallet.withdrawal.requested',payload:{withdrawalId:result.id,amount,network}});
          }
        res.json({success:true,message:nativeAutoQueued?'Withdrawal diterima dan diproses otomatis melalui hot wallet BSC.':'Withdrawal masuk tahap review settlement.',queueId:result.id,amount:result.amount,fee:result.fee,netAmount:result.netAmount,network,status:nativeAutoQueued?'PROCESSING':result.status,estimatedMinutes:nativeAutoQueued?3:10,automatic:nativeAutoQueued,timestamp:Date.now(),replayed:result.replayed});
  } catch(error){ next(error); }
});

export default router;
