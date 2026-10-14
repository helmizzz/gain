import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { verifyCustomJwt } from './jwtUtils';
import { ApiError } from './apiError';
import { serverState } from './serverState';
import { redisGet, redisSetEx, redisDel, redisIncr, redisExpire } from '../redis';
import { dbQuery, getWalletSnapshot, getUserByFirebaseUid } from '../database';

export interface AuthIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
}
export type FirebaseIdentity = AuthIdentity;

export type VerificationChallenge = {
  codeHash: string;
  expiresAt: number;
  attempts: number;
  sentAt: number;
};

export const emailVerificationChallenges = new Map<string, VerificationChallenge>();
export const loginVerificationChallenges = new Map<string, VerificationChallenge>();
export const localSessionElevation = new Map<string, { uid: string; expiresAt: number }>();

export const SESSION_ELEVATION_TTL_SECONDS = 24 * 60 * 60;

export function hashVerificationCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function hashSessionElevationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header = ''): Record<string, string> {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const i = part.indexOf('=');
    return i > 0 ? [part.slice(0, i), decodeURIComponent(part.slice(i + 1))] : ['', ''];
  }).filter(([k]) => k));
}

export function setSessionElevationCookie(res: Response, token: string, maxAgeSeconds = 24 * 60 * 60) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const expires = new Date(Date.now() + maxAgeSeconds * 1000).toUTCString();
  res.setHeader('Set-Cookie', `gain_session_elevation=${encodeURIComponent(token)}; Max-Age=${maxAgeSeconds}; Expires=${expires}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

export function clearSessionElevationCookie(res: Response) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `gain_session_elevation=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

export function requireDatabase(): void {
  if (!serverState.databaseReady) {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'configuration', 'Authoritative financial database is unavailable.', 'Database finansial belum siap. Silakan coba lagi setelah layanan pulih.');
  }
}

export async function createSessionElevation(uid: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_ELEVATION_TTL_SECONDS * 1000;
  const key = `gain:session:elevated:${token}`;

  const stored = await redisSetEx(key, uid, SESSION_ELEVATION_TTL_SECONDS);
  if (!stored) localSessionElevation.set(token, { uid, expiresAt });

  try {
    await dbQuery(
      `INSERT INTO auth_session_elevations (token_hash, firebase_uid, expires_at, created_at)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), now())
       ON CONFLICT (token_hash) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid, expires_at = EXCLUDED.expires_at`,
      [hashSessionElevationToken(token), uid, expiresAt],
    );
  } catch (error) {
    console.warn('[AUTH_SESSION_DURABLE_WRITE_FAILED]', {
      uid,
      code: String((error as any)?.code || 'DB_WRITE_FAILED').slice(0, 80),
    });
  }

  return token;
}

export async function isSessionElevated(req: Request, uid: string): Promise<boolean> {
  const token = parseCookies(String(req.headers.cookie || '')).gain_session_elevation;
  if (!token) return false;
  const now = Date.now();
  const redisUid = await redisGet(`gain:session:elevated:${token}`);
  if (redisUid) return redisUid === uid;

  const local = localSessionElevation.get(token);
  if (local && local.expiresAt > now) return local.uid === uid;
  if (local) localSessionElevation.delete(token);

  try {
    const durable = await dbQuery<{ firebase_uid: string; expires_at_ms: number | string }>(
      `SELECT firebase_uid, floor(extract(epoch from expires_at) * 1000) AS expires_at_ms
         FROM auth_session_elevations
        WHERE token_hash = $1
          AND expires_at > now()
        LIMIT 1`,
      [hashSessionElevationToken(token)],
    );
    const row = durable.rows[0];
    if (!row || row.firebase_uid !== uid) return false;

    const expiresAt = Number(row.expires_at_ms);
    const ttl = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    await redisSetEx(`gain:session:elevated:${token}`, uid, Math.min(SESSION_ELEVATION_TTL_SECONDS, ttl));
    localSessionElevation.set(token, { uid, expiresAt });
    return true;
  } catch (error) {
    console.warn('[AUTH_SESSION_DURABLE_READ_FAILED]', {
      uid,
      code: String((error as any)?.code || 'DB_READ_FAILED').slice(0, 80),
    });
    return false;
  }
}

export async function requireAdmin(req: Request): Promise<string> {
  const authorization = req.header('authorization') || '';
  const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const cookieToken = parseCookies(String(req.headers.cookie || '')).gain_auth_token;
  const token = idToken || cookieToken;
  
  if (!token) throw new ApiError(401, 'AUTH_REQUIRED', 'authentication', 'Admin authentication is required.', 'Autentikasi admin diperlukan.');
  try {
    const decoded = verifyCustomJwt(token);
    let role = decoded.role;
    const tokenEmail = String(decoded.email || '').trim().toLowerCase();
    const masterEmail = String(process.env.GAIN_MASTER_OWNER_EMAIL || '').trim().toLowerCase();
    const adminEmails = String(process.env.ADMIN_EMAILS || '').toLowerCase();
    const isMaster = (masterEmail && tokenEmail === masterEmail) || (adminEmails && adminEmails.includes(tokenEmail));

    if (isMaster) {
      role = 'superadmin';
    }

    if (role !== 'admin' && role !== 'superadmin') {
      const user = await getUserByFirebaseUid(decoded.uid);
      if (user) {
        const dbEmail = String(user.email || '').trim().toLowerCase();
        if (user.role === 'admin' || user.role === 'superadmin') {
          role = user.role;
        } else if ((masterEmail && dbEmail === masterEmail) || (adminEmails && adminEmails.includes(dbEmail))) {
          role = 'superadmin';
          await dbQuery("UPDATE users SET role = 'superadmin', updated_at = now() WHERE id = $1", [user.id]).catch(() => {});
        }
      } else if (tokenEmail) {
        const byEmail = await dbQuery<any>('SELECT id, role, email FROM users WHERE lower(email) = $1 LIMIT 1', [tokenEmail]);
        if (byEmail.rows[0]) {
          const userRow = byEmail.rows[0];
          if (userRow.role === 'admin' || userRow.role === 'superadmin') {
            role = userRow.role;
          } else if ((masterEmail && tokenEmail === masterEmail) || (adminEmails && adminEmails.includes(tokenEmail))) {
            role = 'superadmin';
            await dbQuery("UPDATE users SET role = 'superadmin', updated_at = now() WHERE id = $1", [userRow.id]).catch(() => {});
          }
        }
      }
    }

    if (role !== 'admin' && role !== 'superadmin') {
      throw new ApiError(403, 'ADMIN_REQUIRED', 'authorization', 'Administrator privileges are required.', 'Hak akses administrator diperlukan.');
    }
    return decoded.uid;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, 'AUTH_INVALID', 'authentication', 'Admin token is invalid or expired.', 'Sesi admin tidak valid atau sudah kedaluwarsa.');
  }
}

export async function requireActiveMember(uid: string) {
  requireDatabase();
  const snapshot = await getWalletSnapshot(uid);
  const memberStatus = String(snapshot?.member_status || snapshot?.status || 'active').toLowerCase();
  if (memberStatus === 'suspended') {
    throw new ApiError(403, 'MEMBER_SUSPENDED', 'authorization', 'This GAIN member account is suspended.', 'Akun Member GAIN sedang ditangguhkan.');
  }
  if (memberStatus === 'closed') {
    throw new ApiError(403, 'MEMBER_CLOSED', 'authorization', 'This GAIN member account is closed.', 'Akun Member GAIN sudah ditutup.');
  }
  if (memberStatus !== 'active') {
    throw new ApiError(403, 'MEMBER_NOT_ACTIVE', 'authorization', 'This GAIN member account is not active.', 'Status akun Member GAIN tidak aktif.');
  }
  return snapshot;
}

export async function requireSecuritySession(req: Request, uid: string) {
  await requireActiveMember(uid);
  if (!(await isSessionElevated(req, uid))) {
    throw new ApiError(403, 'SESSION_ELEVATION_REQUIRED', 'authorization', 'Security verification is required for this action.', 'Verifikasi keamanan sesi diperlukan untuk tindakan ini. Verifikasi keamanan 6 digit akan diminta saat diperlukan.');
  }
}

export async function requireActiveLicense(uid: string) {
  requireDatabase();
  const snapshot = await getWalletSnapshot(uid);
  const licenseStatus = String(snapshot?.license_status || 'NONE').toUpperCase();
  const role = snapshot?.role || 'user';
  
  if (role !== 'admin' && role !== 'superadmin' && licenseStatus !== 'ACTIVE') {
    throw new ApiError(403, 'LICENSE_REQUIRED', 'authorization', 'An active GAIN license is required for this feature.', 'Lisensi GAIN aktif diperlukan untuk menggunakan fitur ini.');
  }
  return snapshot;
}

export async function requireLicensedSecuritySession(req: Request, uid: string) {
  await requireActiveLicense(uid);
  await requireSecuritySession(req, uid);
}

export async function getChallenge(kind: 'login' | 'email', uid: string): Promise<VerificationChallenge | undefined> {
  const key = `gain:${kind}:challenge:${uid}`;
  const raw = await redisGet(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as VerificationChallenge;
      if (parsed.expiresAt > Date.now()) return parsed;
    } catch {}
  }

  try {
    const durable = await dbQuery<{
      code_hash: string;
      expires_at_ms: number | string;
      attempts: number;
      sent_at_ms: number | string;
    }>(
      `SELECT encode(code_hash, 'hex') AS code_hash,
              floor(extract(epoch from expires_at) * 1000) AS expires_at_ms,
              attempts,
              floor(extract(epoch from sent_at) * 1000) AS sent_at_ms
         FROM auth_verification_challenges
        WHERE firebase_uid = $1 AND kind = $2
          AND expires_at > now()
        LIMIT 1`,
      [uid, kind],
    );
    const row = durable.rows[0];
    if (row) {
      const value: VerificationChallenge = {
        codeHash: row.code_hash,
        expiresAt: Number(row.expires_at_ms),
        attempts: Number(row.attempts),
        sentAt: Number(row.sent_at_ms),
      };
      const ttl = Math.max(1, Math.ceil((value.expiresAt - Date.now()) / 1000));
      await redisSetEx(key, JSON.stringify(value), Math.min(600, ttl));
      return value;
    }
  } catch (error) {
    console.warn('[OTP_DURABLE_READ_FALLBACK]', {
      kind,
      code: String((error as any)?.code || 'DB_READ_FAILED').slice(0, 80),
    });
  }

  const memory = (kind === 'login' ? loginVerificationChallenges : emailVerificationChallenges).get(uid);
  if (memory && memory.expiresAt > Date.now()) return memory;
  return undefined;
}

export async function setChallenge(kind: 'login' | 'email', uid: string, value: VerificationChallenge) {
  const key = `gain:${kind}:challenge:${uid}`;
  const ttl = Math.max(1, Math.min(600, Math.ceil((value.expiresAt - Date.now()) / 1000)));
  const savedRedis = await redisSetEx(key, JSON.stringify(value), ttl);

  try {
    await dbQuery(
      `INSERT INTO auth_verification_challenges (firebase_uid, kind, code_hash, expires_at, attempts, sent_at, updated_at)
       VALUES ($1, $2, decode($3, 'hex'), to_timestamp($4 / 1000.0), $5, to_timestamp($6 / 1000.0), now())
       ON CONFLICT (firebase_uid, kind)
       DO UPDATE SET code_hash = EXCLUDED.code_hash,
                     expires_at = EXCLUDED.expires_at,
                     attempts = EXCLUDED.attempts,
                     sent_at = EXCLUDED.sent_at,
                     updated_at = now()`,
      [uid, kind, value.codeHash, value.expiresAt, value.attempts, value.sentAt],
    );
  } catch (error) {
    console.warn('[OTP_DURABLE_WRITE_FAILED]', {
      kind,
      code: String((error as any)?.code || 'DB_WRITE_FAILED').slice(0, 80),
    });
  }

  (kind === 'login' ? loginVerificationChallenges : emailVerificationChallenges).set(uid, value);

  if (!savedRedis) {
    console.warn('[OTP_REDIS_UNAVAILABLE_USING_DURABLE_DB]', { kind });
  }
}

export async function deleteChallenge(kind: 'login' | 'email', uid: string) {
  await redisDel(`gain:${kind}:challenge:${uid}`);
  try {
    await dbQuery('DELETE FROM auth_verification_challenges WHERE firebase_uid = $1 AND kind = $2', [uid, kind]);
  } catch (error) {
    console.warn('[OTP_DURABLE_DELETE_FAILED]', {
      kind,
      code: String((error as any)?.code || 'DB_DELETE_FAILED').slice(0, 80),
    });
  }
  (kind === 'login' ? loginVerificationChallenges : emailVerificationChallenges).delete(uid);
}

export async function checkRedisRateLimit(key: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev && process.env.REDIS_REQUIRED !== 'true') {
    return true;
  }
  const count = await redisIncr(`gain:rl:${key}`);
  if (count === null) {
    return isDev || process.env.REDIS_REQUIRED !== 'true';
  }
  if (count === 1) await redisExpire(`gain:rl:${key}`, windowSeconds);
  return count <= maxRequests;
}

const globalRequestRateLimitMap = new Map<string, { count: number; resetTime: number }>();

export async function checkGlobalRequestRateLimit(key: string, maxRequests: number = 120, windowMs: number = 60000): Promise<boolean> {
  const isDev = process.env.NODE_ENV !== 'production' || key.includes('127.0.0.1') || key.includes('::1') || key.includes('localhost') || key.includes('::ffff:');
  const effectiveMax = isDev ? Math.max(maxRequests, 10000) : maxRequests;
  const redisAllowed = await checkRedisRateLimit(`global:${key}`, effectiveMax, Math.ceil(windowMs / 1000));
  if (!redisAllowed) return false;
  const now = Date.now();
  const entry = globalRequestRateLimitMap.get(key);
  if (!entry || now > entry.resetTime) { globalRequestRateLimitMap.set(key, { count: 1, resetTime: now + windowMs }); return true; }
  if (entry.count >= effectiveMax) return false;
  entry.count += 1;
  return true;
}

export async function requireFirebaseIdentity(req: Request): Promise<{ identity: FirebaseIdentity; idToken: string }> {
  const authorization = req.header('authorization') || '';
  const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const cookieToken = parseCookies(String(req.headers.cookie || '')).gain_auth_token;
  
  const token = idToken || cookieToken;

  if (!token) {
    throw new ApiError(
      401,
      'AUTH_REQUIRED',
      'authentication',
      'A valid sign-in is required.',
      'Silakan login dengan akun yang valid.'
    );
  }

  try {
    const decoded = verifyCustomJwt(token);
    const email = typeof decoded.email === 'string' ? decoded.email.trim() : '';
    if (!decoded.uid || !email) {
      throw new ApiError(
        401,
        'AUTH_INVALID',
        'authentication',
        'Account identity is incomplete.',
        'Identitas akun tidak lengkap.'
      );
    }

    return {
      idToken: token,
      identity: {
        uid: decoded.uid,
        email,
        emailVerified: true,
      },
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      401,
      'AUTH_INVALID',
      'authentication',
      'Sign-in token is invalid or expired.',
      'Sesi login tidak valid atau telah berakhir.'
    );
  }
}

export const requireAuthIdentity = requireFirebaseIdentity;
