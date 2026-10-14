import { createHmac, createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { dbQuery, dbTransaction, getSystemSetting, setSystemSetting } from './database';

const BSC_CHAIN_ID = 56;
const DEFAULT_USDT = '0x55d398326f99059ff775485246999027b3197955'.toLowerCase();
const MASTER_SETTING = 'native_bsc_deposit_root_v1';
const HOT_SETTING = 'native_bsc_hot_wallet_v1';
const SCAN_SETTING = 'native_bsc_scanner_v1';
const CURVE_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

function rpcUrl(): string {
  const value = String(process.env.BSC_RPC_URL || '').trim();
  if (!value) throw new Error('BSC_RPC_URL is not configured.');
  return value;
}

function encryptionKey(): Buffer {
  const raw = String(process.env.ENCRYPTION_MASTER_KEY || '').trim();
  if (!raw) throw new Error('ENCRYPTION_MASTER_KEY is not configured.');
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return createHash('sha256').update(raw).digest();
}

function encryptSecret(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptSecret(value: any): string {
  if (!value?.ciphertext || !value?.iv || !value?.authTag) throw new Error('Encrypted wallet secret is incomplete.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest();
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function privateToAddress(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const hash = keccak_256(publicKey.slice(1));
  return `0x${Buffer.from(hash.slice(-20)).toString('hex')}`;
}

function deriveChild(parentKey: Uint8Array, parentChainCode: Uint8Array, index: number, hardened: boolean) {
  const data = hardened
    ? concatBytes(new Uint8Array([0]), parentKey, u32(index + 0x80000000))
    : concatBytes(secp256k1.getPublicKey(parentKey, true), u32(index));
  const I = hmacSha512(parentChainCode, data);
  const IL = BigInt(`0x${Buffer.from(I.slice(0, 32)).toString('hex')}`);
  if (IL >= CURVE_N) throw new Error('BIP32 derivation produced an invalid child.');
  const parent = BigInt(`0x${Buffer.from(parentKey).toString('hex')}`);
  const child = (IL + parent) % CURVE_N;
  if (child === 0n) throw new Error('BIP32 derivation produced an invalid zero key.');
  const key = Buffer.from(child.toString(16).padStart(64, '0'), 'hex');
  return { key, chainCode: I.slice(32) };
}

export function deriveNativeBscAddressFromSeedHex(seedHex: string, index: number): string {
  return derivePathFromSeed(parseSeedHex(seedHex), index).address;
}

function derivePathFromSeed(seed: Uint8Array, index: number): { privateKey: Buffer; address: string; path: string } {
  const I = hmacSha512(new TextEncoder().encode('Bitcoin seed'), seed);
  let key = Buffer.from(I.slice(0, 32));
  let chain = I.slice(32);
  const parts: Array<[number, boolean]> = [[44, true], [60, true], [0, true], [0, false], [index, false]];
  for (const [part, hardened] of parts) {
    const next = deriveChild(key, chain, part, hardened);
    key = next.key;
    chain = next.chainCode;
  }
  return { privateKey: key, address: privateToAddress(key), path: `m/44'/60'/0'/0/${index}` };
}

function parseSeedHex(value: string): Buffer {
  const normalized = value.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64,128}$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('BSC deposit root seed must be 32-64 bytes of hexadecimal data.');
  }
  return Buffer.from(normalized, 'hex');
}

async function getOrCreateDepositRoot(): Promise<Buffer> {
  const configured = String(process.env.BSC_DEPOSIT_MASTER_SEED_HEX || '').trim();
  if (configured) return parseSeedHex(configured);
  const stored = await getSystemSetting<any>(MASTER_SETTING);
  if (stored) return Buffer.from(decryptSecret(stored), 'hex');
  const seed = randomBytes(64);
  const encrypted = encryptSecret(seed.toString('hex'));
  await setSystemSetting(MASTER_SETTING, {
    version: 1,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    fingerprint: createHash('sha256').update(seed).digest('hex').slice(0, 16),
    createdAt: new Date().toISOString(),
  });
  return seed;
}

export async function ensureNativeDepositAddress(firebaseUid: string) {
  const existing = await dbQuery<any>(
    `SELECT da.id,da.address,da.status,da.currency,da.network,da.created_at,
            da.qr_payload,da.chain_id,da.asset_id,da.provider,da.provider_wallet_id,
            da.derivation_index,da.derivation_path
       FROM wallet_deposit_addresses da
       JOIN users u ON u.id=da.user_id
      WHERE u.firebase_uid=$1 AND da.currency='USDT' AND da.network='BEP-20' AND da.provider='native-bsc' AND da.status='ACTIVE'
      ORDER BY da.created_at ASC LIMIT 1`,
    [firebaseUid],
  );
  if (existing.rows[0]) return { ...existing.rows[0], replayed: true };

  const seed = await getOrCreateDepositRoot();
  return dbTransaction(async (client) => {
    const user = await client.query(`SELECT id FROM users WHERE firebase_uid=$1 FOR UPDATE`, [firebaseUid]);
    if (!user.rows[0]) throw Object.assign(new Error('Account not provisioned.'), { code: 'ACCOUNT_NOT_PROVISIONED' });
    const replay = await client.query(
      `SELECT da.id,da.address,da.status,da.currency,da.network,da.created_at,da.qr_payload,da.chain_id,da.asset_id,da.provider,da.provider_wallet_id,da.derivation_index,da.derivation_path
         FROM wallet_deposit_addresses da
        WHERE da.user_id=$1 AND da.currency='USDT' AND da.network='BEP-20' AND da.provider='native-bsc' AND da.status='ACTIVE'
        LIMIT 1 FOR UPDATE`,
      [user.rows[0].id],
    );
    if (replay.rows[0]) return { ...replay.rows[0], replayed: true };

    const seq = await client.query(`SELECT nextval('gain_bsc_deposit_index_seq') AS value`);
    const index = Number(seq.rows[0].value);
    const derived = derivePathFromSeed(seed, index);
    const asset = await client.query(`SELECT id FROM financial_assets WHERE asset_code='BSC_BINANCE_PEG_USDT' LIMIT 1`);
    const inserted = await client.query(
      `INSERT INTO wallet_deposit_addresses
        (user_id,currency,network,address,provider,provider_wallet_id,status,asset_id,chain_id,provider_wallet_type,qr_payload,derivation_index,derivation_path,metadata)
       VALUES($1,'USDT','BEP-20',$2,'native-bsc',$3,'ACTIVE',$4,56,'HD_DERIVED',$2,$5,$6,$7::jsonb)
       RETURNING id,address,status,currency,network,created_at,qr_payload,chain_id,asset_id,provider,provider_wallet_id,derivation_index,derivation_path`,
      [user.rows[0].id, derived.address, `native-bsc:${index}`, asset.rows[0]?.id || null, index, derived.path, JSON.stringify({ custodyMode: 'NATIVE_BSC', scheme: 'BIP32/BIP44_EVM', chainId: BSC_CHAIN_ID })],
    );
    await client.query(
      `INSERT INTO custody_wallets(user_id,provider,provider_wallet_id,wallet_type,purpose,network,address,status,metadata)
       VALUES($1,'native-bsc',$2,'HD_DERIVED','USER_DEPOSIT','BSC',$3,'ACTIVE',$4::jsonb)
       ON CONFLICT(provider,provider_wallet_id) DO NOTHING`,
      [user.rows[0].id, `native-bsc:${index}`, derived.address, JSON.stringify({ derivationIndex: index, derivationPath: derived.path })],
    );
    return { ...inserted.rows[0], replayed: false };
  });
}

export async function getNativeWalletStatus() {
  const hot = await getSystemSetting<any>(HOT_SETTING);
  const root = await getSystemSetting<any>(MASTER_SETTING);
  let hotAddress = String(hot?.address || '').toLowerCase();
  let hotBnb = '0';
  let hotUsdt = '0';
  if (hotAddress) {
    try {
      const [bnb, usdt] = await Promise.all([
        rpcCall('eth_getBalance', [hotAddress, 'latest']),
        rpcCall('eth_call', [{ to: usdtAddress(), data: `0x70a08231${hotAddress.slice(2).padStart(64, '0')}` }, 'latest']),
      ]);
      hotBnb = unitsToDecimal(BigInt(String(bnb)), 18);
      hotUsdt = unitsToDecimal(BigInt(String(usdt)), 18);
    } catch { /* status remains visible even when RPC is temporarily unavailable */ }
  }
  return {
    mode: 'NATIVE_BSC',
    network: 'BSC',
    chainId: BSC_CHAIN_ID,
    usdtContract: usdtAddress(),
    depositRootConfigured: Boolean(root),
    depositRootFingerprint: root?.fingerprint || null,
    hotWalletConfigured: Boolean(hotAddress),
    hotWalletAddress: hotAddress || null,
    hotWalletBnb: hotBnb,
    hotWalletUsdt: hotUsdt,
    autoWithdrawalEnabled: process.env.BSC_NATIVE_WITHDRAWAL_ENABLED !== 'false' && Boolean(hot?.autoWithdrawalEnabled),
    autoWithdrawalMaxAmount: Number.isFinite(Number(hot?.autoWithdrawalMaxAmount)) && Number(hot?.autoWithdrawalMaxAmount) > 0
      ? Number(hot.autoWithdrawalMaxAmount)
      : Number.isFinite(Number(process.env.AUTO_WITHDRAWAL_MAX_AMOUNT_USDT)) && Number(process.env.AUTO_WITHDRAWAL_MAX_AMOUNT_USDT) > 0
        ? Number(process.env.AUTO_WITHDRAWAL_MAX_AMOUNT_USDT)
        : 50,
  };
}

function usdtAddress(): string {
  const configured = String(process.env.BSC_USDT_CONTRACT || DEFAULT_USDT).trim().toLowerCase();
  if (configured !== DEFAULT_USDT) throw new Error('BSC_USDT_CONTRACT must be the approved BSC USDT mainnet contract.');
  return DEFAULT_USDT;
}

async function rpcCall(method: string, params: unknown[]): Promise<any> {
  const response = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.json();
  if (!response.ok || body?.error || body?.result === undefined) throw new Error(`BSC RPC ${method} failed.`);
  return body.result;
}

function decimalToUnits(value: string, decimals = 18): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match || (match[2] || '').length > decimals) throw new Error('Invalid token amount.');
  return BigInt(match[1]) * (10n ** BigInt(decimals)) + BigInt((match[2] || '').padEnd(decimals, '0') || '0');
}

function unitsToDecimal(value: bigint, decimals = 18): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  if (!frac) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

function bytes(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const clean = value.replace(/^0x/i, '');
  if (!clean) return new Uint8Array();
  return Uint8Array.from(Buffer.from(clean.length % 2 ? `0${clean}` : clean, 'hex'));
}

function intBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array();
  return bytes(value.toString(16));
}

function rlpEncode(value: Uint8Array | Uint8Array[]): Uint8Array {
  if (Array.isArray(value)) {
    const payload = concatBytes(...value.map(rlpEncode));
    if (payload.length <= 55) return concatBytes(new Uint8Array([0xc0 + payload.length]), payload);
    const len = bytes(payload.length.toString(16));
    return concatBytes(new Uint8Array([0xf7 + len.length]), len, payload);
  }
  if (value.length === 1 && value[0] < 0x80) return value;
  if (value.length <= 55) return concatBytes(new Uint8Array([0x80 + value.length]), value);
  const len = bytes(value.length.toString(16));
  return concatBytes(new Uint8Array([0xb7 + len.length]), len, value);
}

function encodeTransfer(to: string, amount: bigint): string {
  const address = to.replace(/^0x/, '').toLowerCase();
  return `0xa9059cbb${address.padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
}

async function sendLegacyContractTransfer(privateKey: string, destination: string, amount: string) {
  const cleanKey = privateKey.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(cleanKey)) throw new Error('Configured hot-wallet private key is invalid.');
  const key = Buffer.from(cleanKey, 'hex');
  const from = privateToAddress(key);
  const to = destination.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error('Withdrawal destination is invalid.');
  const token = usdtAddress();
  const amountUnits = decimalToUnits(amount, 18);
  const [chainIdHex, nonceHex, gasPriceHex] = await Promise.all([
    rpcCall('eth_chainId', []),
    rpcCall('eth_getTransactionCount', [from, 'pending']),
    rpcCall('eth_gasPrice', []),
  ]);
  if (BigInt(String(chainIdHex)) !== BigInt(BSC_CHAIN_ID)) throw new Error('BSC RPC chain ID mismatch.');
  const data = encodeTransfer(to, amountUnits);
  const estimateHex = await rpcCall('eth_estimateGas', [{ from, to: token, value: '0x0', data }]);
  const gasLimit = (BigInt(String(estimateHex)) * 120n) / 100n;
  const gasPrice = (BigInt(String(gasPriceHex)) * 110n) / 100n;
  const nonce = BigInt(String(nonceHex));
  const balance = BigInt(String(await rpcCall('eth_getBalance', [from, 'latest'])));
  const gasCost = gasLimit * gasPrice;
  if (balance < gasCost) {
    const availableBnb = unitsToDecimal(balance, 18);
    const requiredBnb = unitsToDecimal(gasCost, 18);
    throw new Error(`Hot wallet (${from}) has insufficient BNB balance for withdrawal gas. Available: ${availableBnb} BNB, Required: ${requiredBnb} BNB.`);
  }
  const unsigned = [
    intBytes(nonce), intBytes(gasPrice), intBytes(gasLimit), bytes(token), intBytes(0n), bytes(data),
    intBytes(BigInt(BSC_CHAIN_ID)), intBytes(0n), intBytes(0n),
  ];
  const digest = keccak_256(rlpEncode(unsigned));
  const signature: any = secp256k1.sign(digest, key, { lowS: true, prehash: false });
  const recovery = Number(signature.recovery ?? 0);
  const v = BigInt(recovery + 35) + BigInt(BSC_CHAIN_ID) * 2n;
  const raw = rlpEncode([
    intBytes(nonce), intBytes(gasPrice), intBytes(gasLimit), bytes(token), intBytes(0n), bytes(data),
    intBytes(v), intBytes(BigInt(`0x${signature.r.toString(16)}`)), intBytes(BigInt(`0x${signature.s.toString(16)}`)),
  ]);
  const txHash = String(await rpcCall('eth_sendRawTransaction', [`0x${Buffer.from(raw).toString('hex')}`]));
  return { txHash, from, gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString() };
}

async function getHotWalletSecret(): Promise<{ address: string; privateKey: string; autoWithdrawalEnabled: boolean }> {
  const stored = await getSystemSetting<any>(HOT_SETTING);
  if (!stored?.ciphertext) throw new Error('Native BSC hot wallet private key is not configured by an administrator.');
  const privateKey = decryptSecret(stored);
  const derivedAddress = privateToAddress(Buffer.from(privateKey.replace(/^0x/i, ''), 'hex'));
  if (derivedAddress.toLowerCase() !== String(stored.address || '').toLowerCase()) throw new Error('Stored hot-wallet address does not match its private key.');
  return { address: derivedAddress, privateKey, autoWithdrawalEnabled: Boolean(stored.autoWithdrawalEnabled) };
}

export async function configureNativeHotWallet(input: { privateKey: string; expectedAddress?: string; enabled: boolean; autoWithdrawalMaxAmount?: number; adminUid: string }) {
  const key = input.privateKey.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('Hot-wallet private key must be exactly 32 bytes hexadecimal.');
  const address = privateToAddress(Buffer.from(key, 'hex'));
  if (input.expectedAddress && address.toLowerCase() !== input.expectedAddress.trim().toLowerCase()) throw new Error('Private key does not match the configured hot-wallet address.');
  const encrypted = encryptSecret(key);
  const maxAmount = input.autoWithdrawalMaxAmount !== undefined && Number.isFinite(Number(input.autoWithdrawalMaxAmount)) && Number(input.autoWithdrawalMaxAmount) > 0
    ? Number(input.autoWithdrawalMaxAmount)
    : 50;
  await setSystemSetting(HOT_SETTING, {
    version: 1,
    address,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    autoWithdrawalEnabled: Boolean(input.enabled),
    autoWithdrawalMaxAmount: maxAmount,
    updatedAt: new Date().toISOString(),
  }, input.adminUid);
  return { address, enabled: Boolean(input.enabled), autoWithdrawalMaxAmount: maxAmount };
}

export async function setNativeHotWalletEnabled(input: { enabled: boolean; autoWithdrawalMaxAmount?: number; adminUid: string }) {
  const current = await getSystemSetting<any>(HOT_SETTING);
  if (!current?.ciphertext) throw new Error('Hot wallet is not configured.');
  const maxAmount = input.autoWithdrawalMaxAmount !== undefined && Number.isFinite(Number(input.autoWithdrawalMaxAmount)) && Number(input.autoWithdrawalMaxAmount) > 0
    ? Number(input.autoWithdrawalMaxAmount)
    : Number.isFinite(Number(current.autoWithdrawalMaxAmount)) ? Number(current.autoWithdrawalMaxAmount) : 50;
  await setSystemSetting(HOT_SETTING, {
    ...current,
    autoWithdrawalEnabled: Boolean(input.enabled),
    autoWithdrawalMaxAmount: maxAmount,
    updatedAt: new Date().toISOString(),
  }, input.adminUid);
  return { enabled: Boolean(input.enabled), address: current.address, autoWithdrawalMaxAmount: maxAmount };
}

export async function processNativeWithdrawal(withdrawal: { id: string; destinationAddress: string; netAmount: string }) {
  return dbTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('gain:native-bsc:hot-wallet-nonce'))`);
    const hot = await getHotWalletSecret();
    if (!hot.autoWithdrawalEnabled) throw new Error('Automatic withdrawal is disabled.');
    const sent = await sendLegacyContractTransfer(hot.privateKey, withdrawal.destinationAddress, withdrawal.netAmount);
    return { ...sent, hotWalletAddress: hot.address };
  });
}

export async function waitForNativeBscReceipt(txHash: string, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = await rpcCall('eth_getTransactionReceipt', [txHash]);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}

export async function getNativeScannerState(): Promise<{ lastBlock: bigint }> {
  const state = await getSystemSetting<any>(SCAN_SETTING);
  return { lastBlock: state?.lastBlock ? BigInt(String(state.lastBlock)) : 0n };
}

export async function setNativeScannerState(lastBlock: bigint) {
  await setSystemSetting(SCAN_SETTING, { lastBlock: lastBlock.toString(), updatedAt: new Date().toISOString() });
}

export async function scanNativeBscDeposits(minConfirmations: number) {
  const rpc = rpcUrl();
  const latest = BigInt(String(await rpcCall('eth_blockNumber', [])));
  const safeConfirmations = BigInt(Math.max(Number(minConfirmations) || 1, 1));
  const safeLatest = latest >= safeConfirmations ? latest - safeConfirmations + 1n : 0n;

  const state = await getNativeScannerState();
  let from = state.lastBlock > 0n ? state.lastBlock + 1n : (safeLatest > 100n ? safeLatest - 100n : 0n);
  if (from > safeLatest) return { scanned: false, from, to: safeLatest, matched: 0 };

  const to = from + 250n < safeLatest ? from + 250n : safeLatest;
  const token = usdtAddress();
  const transferTopic = `0x${Buffer.from(keccak_256(new TextEncoder().encode('Transfer(address,address,uint256)'))).toString('hex')}`;
  const logs = await rpcCall('eth_getLogs', [{ address: token, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [transferTopic] }]);
  const addresses = await dbQuery<any>(`SELECT da.address,u.firebase_uid,da.id FROM wallet_deposit_addresses da JOIN users u ON u.id=da.user_id WHERE da.status='ACTIVE' AND da.provider='native-bsc' AND da.network='BEP-20' AND da.currency='USDT'`);
  const byAddress = new Map<string, any>(addresses.rows.map((row: any) => [String(row.address).toLowerCase(), row] as [string, any]));
  let matched = 0;
  const matchedByTx = new Map<string, any[]>();
  for (const log of logs || []) {
    const destination = `0x${String(log.topics?.[2] || '').slice(-40)}`.toLowerCase();
    if (!byAddress.has(destination)) continue;
    const txHash = String(log.transactionHash).toLowerCase();
    const list = matchedByTx.get(txHash) || [];
    list.push(log);
    matchedByTx.set(txHash, list);
  }
  for (const [txHash, txLogs] of matchedByTx.entries()) {
    const destinationSet = new Set(txLogs.map((log: any) => `0x${String(log.topics?.[2] || '').slice(-40)}`.toLowerCase()));
    if (destinationSet.size !== 1 || txLogs.length !== 1) {
      console.warn(JSON.stringify({ event: 'native_bsc.deposit_ambiguous_transaction', txHash, matchingTransfers: txLogs.length, destinations: [...destinationSet] }));
      continue;
    }
    const log = txLogs[0];
    const destination = `0x${String(log.topics?.[2] || '').slice(-40)}`.toLowerCase();
    const source = `0x${String(log.topics?.[1] || '').slice(-40)}`.toLowerCase();
    const owner = byAddress.get(destination);
    if (!owner) continue;
    const amount = unitsToDecimal(BigInt(String(log.data)), 18);
    const blockNumber = BigInt(String(log.blockNumber));
    const confirmations = Number(latest - blockNumber + 1n);
    if (confirmations < minConfirmations) continue;
    const providerEventId = `native-bsc:${txHash}:${String(log.logIndex || '0')}`;
    const credited = await creditNativeDeposit({
      firebaseUid: String(owner.firebase_uid),
      txHash,
      destinationAddress: destination,
      sourceAddress: source,
      amount,
      blockNumber: Number(blockNumber),
      confirmations,
      providerEventId,
      logIndex: Number(BigInt(String(log.logIndex || '0'))),
    });
    if (credited) matched++;
  }
  await setNativeScannerState(to);
  return { scanned: true, from, to, matched };
}

async function creditNativeDeposit(input: { firebaseUid: string; txHash: string; destinationAddress: string; sourceAddress: string; amount: string; blockNumber: number; confirmations: number; providerEventId: string; logIndex: number }) {
  return dbTransaction(async (client) => {
    const user = await client.query(`SELECT id FROM users WHERE firebase_uid=$1 FOR UPDATE`, [input.firebaseUid]);
    if (!user.rows[0]) return false;
    const existing = await client.query(`SELECT id,status FROM deposits WHERE network='BEP-20' AND lower(tx_hash)=lower($1) FOR UPDATE`, [input.txHash]);
    if (existing.rows[0]) return false;
    const wallet = await client.query(`SELECT id,available_balance FROM wallet_accounts WHERE user_id=$1 AND currency='USDT' FOR UPDATE`, [user.rows[0].id]);
    if (!wallet.rows[0]) return false;
    const amount = Number(input.amount);
    const before = Number(wallet.rows[0].available_balance);
    const after = before + amount;
    const deposit = await client.query(
      `INSERT INTO deposits(user_id,currency,network,tx_hash,destination_address,source_address,amount,block_number,confirmations,status,verified_at,screening_status,screening_provider,provider,provider_event_id,finalized)
       VALUES($1,'USDT','BEP-20',$2,$3,$4,$5,$6,$7,'CREDITED',now(),'CLEAR','native-bsc','native-bsc',$8,true) RETURNING id,credited_at`,
      [user.rows[0].id,input.txHash.toLowerCase(),input.destinationAddress,input.sourceAddress,amount,input.blockNumber,input.confirmations,input.providerEventId],
    );
    await client.query(`UPDATE wallet_accounts SET available_balance=$2,total_inflow=total_inflow+$3,version=version+1,updated_at=now() WHERE id=$1`, [wallet.rows[0].id, after, amount]);
    const ledger = await client.query(
      `INSERT INTO wallet_ledger(account_id,direction,amount,balance_before,balance_after,entry_type,reference_type,reference_id,description,metadata)
       VALUES($1,'CREDIT',$2,$3,$4,'ONCHAIN_DEPOSIT','DEPOSIT',$5,'Native BSC deposit credited',$6::jsonb) RETURNING id`,
      [wallet.rows[0].id, amount, before, after, deposit.rows[0].id, JSON.stringify({ sourceAddress: input.sourceAddress, destinationAddress: input.destinationAddress, txHash: input.txHash, provider: 'native-bsc', confirmations: input.confirmations })],
    );
      

    await client.query(
      `INSERT INTO deposit_screening_events(deposit_id,provider,provider_event_id,status,reason_code)
       VALUES($1,'native-bsc',$2,'CLEAR','NATIVE_BSC_AUTO_CLEAR')
       ON CONFLICT(provider,provider_event_id) DO NOTHING`,
      [deposit.rows[0].id, input.providerEventId],
    );
    await client.query(
      `INSERT INTO native_bsc_transaction_events(event_type,tx_hash,log_index,user_id,address,source_address,destination_address,amount,block_number,confirmations,status,metadata)
       VALUES('DEPOSIT',$1,$2,$3,$4,$5,$6,$7,$8,$9,'CREDITED',$10::jsonb)
       ON CONFLICT(network,tx_hash,event_type,log_index) DO NOTHING`,
      [input.txHash.toLowerCase(), input.logIndex, user.rows[0].id, input.destinationAddress, input.sourceAddress, input.destinationAddress, amount, input.blockNumber, input.confirmations, JSON.stringify({ providerEventId: input.providerEventId, nativeBsc: true })],
    );
    return true;
  });
}
