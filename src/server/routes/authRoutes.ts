import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../shared/apiError';
// Firebase Admin removed in Phase 4
import {
  requireFirebaseIdentity,
  requireActiveMember,
  isSessionElevated,
  SESSION_ELEVATION_TTL_SECONDS,
  getChallenge,
  setChallenge,
  deleteChallenge,
  hashVerificationCode,
  createSessionElevation,
  setSessionElevationCookie,
  clearSessionElevationCookie,
  parseCookies,
  hashSessionElevationToken,
  localSessionElevation,
  requireSecuritySession,
  requireDatabase,
} from '../shared/authUtils';
import { encryptSensitiveString, decryptSensitiveString, verifyServerTotp, generateServerTotpSecret } from '../shared/cryptoUtils';
import { buildEmailIdempotencyKey, getEmailDeliveryConfig, sendTransactionalEmail, EmailDeliveryError } from '../emailDelivery';
import { redisSetNxEx, redisDel } from '../redis';
import { getUserByFirebaseUid, getWalletSnapshot, dbQuery, saveTwoFactorSecret, getTwoFactorSecretRecord, consumeTotpCounter, createAuditEvent } from '../database';

const router = Router();

router.post('/api/auth/send-verification-code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    const forceResend = req.body?.forceResend === true;
    const emailConfig = getEmailDeliveryConfig();
    if (!emailConfig.configured) {
      return next(new ApiError(503, 'EMAIL_DELIVERY_NOT_CONFIGURED', 'configuration', 'Email delivery is not configured.', 'Pengiriman email belum dikonfigurasi. Tetapkan RESEND_API_KEY dan RESEND_FROM di server.'));
    }

    const previous = await getChallenge('email', identity.uid);
    if (previous) {
      const remaining = Math.max(0, Math.ceil((previous.expiresAt - Date.now()) / 1000));
      const retryAfter = Math.max(1, Math.ceil(30 - (Date.now() - previous.sentAt) / 1000));

      if (!forceResend) {
        return res.json({
          success: true,
          expiresInSeconds: remaining,
          retryAfterSeconds: Math.max(0, retryAfter),
          alreadySent: true,
        });
      }

      if (Date.now() - previous.sentAt < 30_000) {
        return next(new ApiError(429, 'VERIFICATION_RATE_LIMITED', 'rate_limit', 'A verification email was sent recently.', 'Tunggu 30 detik sebelum meminta kode baru.'));
      }
    }

    const sendLockKey = `gain:otp:send-lock:email:${identity.uid}`;
    const sendLockAcquired = await redisSetNxEx(sendLockKey, identity.uid, 45);
    if (!sendLockAcquired) {
      const locked = await getChallenge('email', identity.uid);
      return res.json({
        success: true,
        expiresInSeconds: locked ? Math.max(0, Math.ceil((locked.expiresAt - Date.now()) / 1000)) : 1800,
        retryAfterSeconds: 30,
        alreadySent: Boolean(locked),
      });
    }

    try {
      const lockedPrevious = await getChallenge('email', identity.uid);
      if (lockedPrevious && !forceResend) {
        return res.json({
          success: true,
          expiresInSeconds: Math.max(0, Math.ceil((lockedPrevious.expiresAt - Date.now()) / 1000)),
          retryAfterSeconds: Math.max(0, Math.ceil(30 - (Date.now() - lockedPrevious.sentAt) / 1000)),
          alreadySent: true,
        });
      }

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const sentAt = Date.now();
      const expiresAt = sentAt + 30 * 60_000;
      try {
        const delivery = await sendTransactionalEmail({
          to: identity.email,
          subject: 'Kode verifikasi GAIN Niaga Koin',
          text: `Kode verifikasi Anda: ${code}\n\nKode berlaku selama 30 menit. Jangan bagikan kode ini kepada siapa pun.`,
          idempotencyKey: buildEmailIdempotencyKey('email-verification', identity.uid, sentAt, code),
        });
        console.info('[EMAIL_VERIFICATION_SENT]', { uid: identity.uid, resendEmailId: delivery.id });
      } catch (error) {
        if (error instanceof EmailDeliveryError) {
          console.error('[EMAIL_DELIVERY_FAILED]', {
            status: error.status,
            providerCode: error.providerCode,
            uid: identity.uid,
            fromDomain: emailConfig.fromDomain,
          });
          if (error.code === 'RESEND_API_KEY_REJECTED') {
            return next(new ApiError(503, error.code, 'configuration', 'Resend rejected the API key.', 'RESEND_API_KEY ditolak Resend. Periksa API key server dan restart aplikasi.'));
          }
          if (error.code === 'RESEND_SENDER_NOT_ALLOWED') {
            return next(new ApiError(503, error.code, 'configuration', 'Resend rejected the configured sender.', `Alamat pengirim '${emailConfig.from}' belum diizinkan Resend. Verifikasi domain pengirim di Resend lalu set RESEND_FROM ke alamat di domain tersebut.`));
          }
          if (error.code === 'EMAIL_PROVIDER_RATE_LIMITED') {
            return next(new ApiError(503, error.code, 'upstream', 'Email provider rate limited the request.', 'Layanan email sedang membatasi permintaan. Tunggu sebentar lalu coba lagi.'));
          }
          return next(new ApiError(502, error.code, 'upstream', 'Email provider rejected the verification message.', 'Email gagal dikirim. Periksa status provider email server.'));
        }
        return next(error);
      }

      await setChallenge('email', identity.uid, {
        codeHash: hashVerificationCode(code),
        expiresAt,
        attempts: 0,
        sentAt,
      });
      res.json({ success: true, expiresInSeconds: 1800, retryAfterSeconds: 30, alreadySent: false });
    } finally {
      await redisDel(sendLockKey);
    }
  } catch (err) {
    return next(err);
  }
});

router.get('/api/auth/verification-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    const kind = req.query.kind === 'login' ? 'login' : req.query.kind === 'email' ? 'email' : null;
    if (!kind) return next(new ApiError(400, 'VERIFICATION_KIND_INVALID', 'validation', 'Verification kind is invalid.', 'Jenis verifikasi tidak valid.'));
    const challenge = await getChallenge(kind, identity.uid);
    if (!challenge) return res.json({ success: true, active: false, expiresInSeconds: 0 });
    res.json({
      success: true,
      active: true,
      expiresInSeconds: Math.max(0, Math.ceil((challenge.expiresAt - Date.now()) / 1000)),
      retryAfterSeconds: Math.max(0, Math.ceil(30 - (Date.now() - challenge.sentAt) / 1000)),
    });
  } catch (error) {
    next(error);
  }
});

async function handleSecuritySessionStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    await requireActiveMember(identity.uid);
    res.json({ success: true, elevated: await isSessionElevated(req, identity.uid), expiresInSeconds: SESSION_ELEVATION_TTL_SECONDS });
  } catch (error) { next(error); }
}

router.get('/api/security/session-status', handleSecuritySessionStatus);
router.get('/api/auth/session-status', handleSecuritySessionStatus);

async function handleSecuritySendCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    requireDatabase();
    await requireActiveMember(identity.uid);

    if (await isSessionElevated(req, identity.uid)) {
      return res.json({
        success: true,
        required: false,
        expiresInSeconds: SESSION_ELEVATION_TTL_SECONDS,
        alreadySent: false,
      });
    }

    const user = await getUserByFirebaseUid(identity.uid);
    const snapshot = await getWalletSnapshot(identity.uid);

    if (!user || !snapshot) {
      return next(new ApiError(
        404,
        'ACCOUNT_NOT_PROVISIONED',
        'not_found',
        'Financial account is not provisioned.',
        'Akun finansial belum tersedia.'
      ));
    }

    const security = await getTwoFactorSecretRecord(identity.uid);
    if (security?.two_factor_enabled) {
      return res.json({
        success: true,
        required: true,
        method: 'totp',
        expiresInSeconds: 300,
        alreadySent: true,
      });
    }

    const emailConfig = getEmailDeliveryConfig();

    if (!emailConfig.configured) {
      return next(new ApiError(
        503,
        'EMAIL_DELIVERY_NOT_CONFIGURED',
        'configuration',
        'Email delivery is not configured.',
        'Pengiriman email belum dikonfigurasi. Tetapkan RESEND_API_KEY dan RESEND_FROM di server.'
      ));
    }

    const forceResend = req.body?.forceResend === true;
    const previous = await getChallenge('login', identity.uid);

    if (previous && !forceResend) {
      return res.json({
        success: true,
        required: true,
        expiresInSeconds: Math.max(
          0,
          Math.floor((previous.expiresAt - Date.now()) / 1000)
        ),
        retryAfterSeconds: Math.max(0, Math.ceil(30 - (Date.now() - previous.sentAt) / 1000)),
        alreadySent: true,
      });
    }

    if (previous && Date.now() - previous.sentAt < 30_000) {
      return next(new ApiError(429, 'SECURITY_CODE_RATE_LIMITED', 'rate_limit', 'A security verification email was sent recently.', 'Tunggu 30 detik sebelum meminta kode keamanan baru.'));
    }

    const sendLockKey = `gain:otp:send-lock:login:${identity.uid}`;
    const sendLockAcquired = await redisSetNxEx(sendLockKey, identity.uid, 45);

    if (!sendLockAcquired) {
      console.info('[OTP_SEND_SUPPRESSED]', {
        kind: 'login',
        uid: identity.uid,
        reason: 'concurrent_send',
      });

      return res.json({
        success: true,
        required: true,
        expiresInSeconds: 1800,
        retryAfterSeconds: 30,
      });
    }

    try {
      const lockedPrevious = await getChallenge('login', identity.uid);

      if (lockedPrevious && !forceResend) {
        return res.json({
          success: true,
          required: true,
          expiresInSeconds: Math.max(0, Math.floor((lockedPrevious.expiresAt - Date.now()) / 1000)),
          retryAfterSeconds: Math.max(0, Math.ceil(30 - (Date.now() - lockedPrevious.sentAt) / 1000)),
          alreadySent: true,
        });
      }

      if (lockedPrevious && Date.now() - lockedPrevious.sentAt < 30_000) {
        return next(new ApiError(429, 'SECURITY_CODE_RATE_LIMITED', 'rate_limit', 'A security verification email was sent recently.', 'Tunggu 30 detik sebelum meminta kode keamanan baru.'));
      }

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

      try {
        const sentAt = Date.now();
        const expiresAt = sentAt + 30 * 60_000;
        const delivery = await sendTransactionalEmail({
          to: identity.email,
          subject: 'Kode keamanan sesi GAIN',
          text: `Kode keamanan sesi GAIN Anda: ${code}\n\nKode berlaku selama 30 menit dan hanya dapat digunakan sekali. Jangan bagikan kode ini.`,
          idempotencyKey: buildEmailIdempotencyKey('login-verification', identity.uid, sentAt, code),
        });

        console.info('[SECURITY_CODE_SENT]', { uid: identity.uid, resendEmailId: delivery.id });
      } catch (error) {
        if (error instanceof EmailDeliveryError) {
          console.error('[SECURITY_CODE_DELIVERY_FAILED]', {
            status: error.status,
            providerCode: error.providerCode,
            uid: identity.uid,
            fromDomain: emailConfig.fromDomain,
          });
          if (error.code === 'RESEND_API_KEY_REJECTED') {
            return next(new ApiError(503, error.code, 'configuration', 'Resend rejected the API key.', 'RESEND_API_KEY ditolak Resend. Periksa API key server dan restart aplikasi.'));
          }
          if (error.code === 'RESEND_SENDER_NOT_ALLOWED') {
            return next(new ApiError(503, error.code, 'configuration', 'Resend rejected the configured sender.', `Alamat pengirim '${emailConfig.from}' belum diizinkan Resend. Verifikasi domain pengirim di Resend lalu set RESEND_FROM ke alamat di domain tersebut.`));
          }
          if (error.code === 'EMAIL_PROVIDER_RATE_LIMITED') {
            return next(new ApiError(503, error.code, 'upstream', 'Email provider rate limited the request.', 'Layanan email sedang membatasi permintaan. Tunggu sebentar lalu coba lagi.'));
          }
          return next(new ApiError(502, error.code, 'upstream', 'Security verification email could not be delivered.', 'Kode keamanan sesi gagal dikirim. Periksa status provider email server.'));
        }
        return next(error);
      }

      await setChallenge('login', identity.uid, {
        codeHash: hashVerificationCode(code),
        expiresAt: Date.now() + 30 * 60_000,
        attempts: 0,
        sentAt: Date.now(),
      });

      console.info('[SECURITY_CODE_SENT]', {
        uid: identity.uid,
        expiresInSeconds: 1800,
      });

      return res.json({
        success: true,
        required: true,
        expiresInSeconds: 1800,
        retryAfterSeconds: 30,
        alreadySent: false,
      });
    } finally {
      await redisDel(sendLockKey);
    }
  } catch (error) {
    return next(error);
  }
}

router.post('/api/security/send-code', handleSecuritySendCode);
router.post('/api/auth/send-login-code', handleSecuritySendCode);

async function handleSecurityVerifyCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    await requireActiveMember(identity.uid);
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    
    const security = await getTwoFactorSecretRecord(identity.uid);
    if (security?.two_factor_enabled) {
      if (!security.two_factor_secret_ciphertext || !security.two_factor_secret_iv || !security.two_factor_secret_auth_tag) {
        return next(new ApiError(500, '2FA_RECORD_CORRUPTED', 'security', 'Two-factor authentication record is invalid.', 'Record 2FA tidak lengkap. Hubungi dukungan keamanan.'));
      }
      if (!code || !/^\d{6}$/.test(code)) {
        return next(new ApiError(400, 'SECURITY_CODE_INVALID', 'validation', 'Security verification code format is invalid.', 'Kode keamanan sesi harus berupa 6 digit angka.'));
      }
      const secret = decryptSensitiveString({ ciphertext: security.two_factor_secret_ciphertext, iv: security.two_factor_secret_iv, authTag: security.two_factor_secret_auth_tag });
      const verification = verifyServerTotp(code, secret, 1);
      if (!verification.valid || verification.counter === undefined || !(await consumeTotpCounter(identity.uid, verification.counter))) {
        return next(new ApiError(400, 'SECURITY_CODE_INVALID', 'validation', 'Security verification code is invalid.', 'Kode Google Authenticator tidak valid atau sudah digunakan.'));
      }
    } else {
      const challenge = await getChallenge('login', identity.uid);
      if (!challenge || Date.now() > challenge.expiresAt || challenge.attempts >= 5) { await deleteChallenge('login', identity.uid); return next(new ApiError(400, 'SECURITY_CODE_EXPIRED', 'validation', 'Security verification code is missing or expired.', 'Kode keamanan sesi tidak ditemukan atau sudah kedaluwarsa.')); }
      if (!/^\d{6}$/.test(code)) {
        challenge.attempts += 1;
        if (challenge.attempts >= 5) await deleteChallenge('login', identity.uid); else await setChallenge('login', identity.uid, challenge);
        return next(new ApiError(400, 'SECURITY_CODE_INVALID', 'validation', 'Security verification code format is invalid.', 'Kode keamanan sesi harus berupa 6 digit angka.'));
      }
      const suppliedHash = Buffer.from(hashVerificationCode(code), 'hex');
      const expectedHash = Buffer.from(challenge.codeHash, 'hex');
      if (suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) {
        challenge.attempts += 1;
        if (challenge.attempts >= 5) await deleteChallenge('login', identity.uid); else await setChallenge('login', identity.uid, challenge);
        return next(new ApiError(400, 'SECURITY_CODE_INVALID', 'validation', 'Security verification code is invalid.', 'Kode keamanan sesi salah.'));
      }
      await deleteChallenge('login', identity.uid);
    }
    
    const token = await createSessionElevation(identity.uid);
    setSessionElevationCookie(res, token);
    await createAuditEvent({ firebaseUid: identity.uid, eventType: 'auth.security.session_elevated', payload: { method: 'email_otp', purpose: 'security_session' } });
    res.json({ success: true, verified: true, expiresInSeconds: 24 * 60 * 60 });
  } catch (error) { next(error); }
}

router.post('/api/security/verify-code', handleSecurityVerifyCode);
router.post('/api/auth/verify-login-code', handleSecurityVerifyCode);

router.post('/api/auth/verify-email-code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    const challenge = await getChallenge('email', identity.uid);
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';

    if (!challenge || Date.now() > challenge.expiresAt || challenge.attempts >= 5) {
      await deleteChallenge('email', identity.uid);
      return next(new ApiError(
        400,
        'VERIFICATION_CODE_EXPIRED',
        'validation',
        'Verification code is missing or expired.',
        'Kode tidak ditemukan atau sudah kedaluwarsa. Minta kode baru.'
      ));
    }

    const suppliedHash = Buffer.from(hashVerificationCode(code), 'hex');
    const expectedHash = Buffer.from(challenge.codeHash, 'hex');

    if (
      !/^\d{6}$/.test(code) ||
      suppliedHash.length !== expectedHash.length ||
      !timingSafeEqual(suppliedHash, expectedHash)
    ) {
      challenge.attempts += 1;

      if (challenge.attempts >= 5) {
        await deleteChallenge('email', identity.uid);
      } else {
        await setChallenge('email', identity.uid, challenge);
      }

      return next(new ApiError(
        400,
        'VERIFICATION_CODE_INVALID',
        'validation',
        'Verification code is invalid.',
        'Kode verifikasi salah. Periksa email dan coba lagi.'
      ));
    }

    // Phase 4: emailVerified state is now fully maintained in PostgreSQL / DB.
    await dbQuery('UPDATE users SET email_verified = true WHERE firebase_uid = $1', [identity.uid]).catch(() => {});

    await deleteChallenge('email', identity.uid);

    res.json({
      success: true,
      emailVerified: true,
    });
  } catch (error) {
    return next(error);
  }
});

async function handleSecuritySessionLogout(req: Request, res: Response) {
  const token = parseCookies(String(req.headers.cookie || '')).gain_session_elevation;
  if (token) {
    await redisDel(`gain:session:elevated:${token}`);
    localSessionElevation.delete(token);
    try {
      await dbQuery('DELETE FROM auth_session_elevations WHERE token_hash = $1', [hashSessionElevationToken(token)]);
    } catch (error) {
      console.warn('[AUTH_SESSION_DURABLE_DELETE_FAILED]', {
        code: String((error as any)?.code || 'DB_DELETE_FAILED').slice(0, 80),
      });
    }
  }
  clearSessionElevationCookie(res);
  
  // Phase 3: Also clear main auth cookie
  res.setHeader('Set-Cookie', `gain_auth_token=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  
  res.json({ success: true });
}

router.post('/api/security/session-logout', handleSecuritySessionLogout);
router.post('/api/auth/session-logout', handleSecuritySessionLogout);

router.get('/api/security/2fa/setup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    await requireSecuritySession(req, identity.uid);
    const existing = await getTwoFactorSecretRecord(identity.uid);
    const secret = generateServerTotpSecret(32);
    const issuer = 'GAIN Niaga Koin';
    const account = identity.email || identity.uid;
    const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    res.json({
      success: true,
      enabled: existing?.two_factor_enabled === true,
      secret,
      uri,
    });
  } catch (error) { next(error); }
});

router.post('/api/security/2fa', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    await requireSecuritySession(req, identity.uid);
    const enabled = req.body?.enabled === true;
    const secret = typeof req.body?.secret === 'string' ? req.body.secret.replace(/\s+/g, '').toUpperCase() : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\D/g, '').trim() : '';

    if (enabled) {
      if (!/^[A-Z2-7]{16,64}$/.test(secret)) return next(new ApiError(400, '2FA_SECRET_INVALID', 'validation', 'TOTP secret is invalid.', 'Secret 2FA tidak valid. Harus berupa 16-64 karakter Base32.'));
      const verification = verifyServerTotp(code, secret, 1);
      if (!verification.valid) return next(new ApiError(400, '2FA_CODE_INVALID', 'validation', 'TOTP code is invalid.', 'Kode Google Authenticator tidak valid.'));
      const encrypted = encryptSensitiveString(secret);
      await saveTwoFactorSecret(identity.uid, { enabled: true, ...encrypted });
      if (verification.counter !== undefined) await consumeTotpCounter(identity.uid, verification.counter);
      await createAuditEvent({ firebaseUid: identity.uid, eventType: 'security.2fa.enabled', payload: { enabled: true } });
      res.json({ success: true, enabled: true });
      return;
    }

    // DISABLING 2FA: Must verify current 2FA code before disabling!
    const existing = await getTwoFactorSecretRecord(identity.uid);
    if (existing?.two_factor_enabled) {
      if (!existing.two_factor_secret_ciphertext || !existing.two_factor_secret_iv || !existing.two_factor_secret_auth_tag) {
        return next(new ApiError(500, '2FA_RECORD_CORRUPTED', 'security', 'Two-factor authentication record is invalid.', 'Record 2FA tidak lengkap. Hubungi dukungan keamanan.'));
      }
      if (!code || !/^\d{6}$/.test(code)) {
        return next(new ApiError(400, '2FA_CODE_INVALID', 'validation', 'TOTP code is required to disable 2FA.', 'Masukkan 6 digit kode Google Authenticator untuk menonaktifkan 2FA.'));
      }
      const existingSecret = decryptSensitiveString({
        ciphertext: existing.two_factor_secret_ciphertext,
        iv: existing.two_factor_secret_iv,
        authTag: existing.two_factor_secret_auth_tag,
      });
      const verification = verifyServerTotp(code, existingSecret, 1);
      if (!verification.valid || verification.counter === undefined || !(await consumeTotpCounter(identity.uid, verification.counter))) {
        return next(new ApiError(400, '2FA_CODE_INVALID', 'validation', 'TOTP code is invalid or already used.', 'Kode Google Authenticator tidak valid atau sudah digunakan.'));
      }
    }

    await saveTwoFactorSecret(identity.uid, { enabled: false });
    await createAuditEvent({ firebaseUid: identity.uid, eventType: 'security.2fa.disabled', payload: { enabled: false } });
    res.json({ success: true, enabled: false });
  } catch (error) { next(error); }
});

import { OAuth2Client } from 'google-auth-library';
import { signCustomJwt } from '../shared/jwtUtils';

const googleClient = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);

router.post('/api/auth/google/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accessToken, registrationData } = req.body;
    if (!accessToken) {
      return next(new ApiError(400, 'MISSING_TOKEN', 'validation', 'Google Access Token is missing.', 'Token tidak ditemukan.'));
    }
    
    // Fetch profile from Google using access token
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!profileRes.ok) {
      return next(new ApiError(401, 'INVALID_TOKEN', 'security', 'Invalid Google token payload.', 'Token Google tidak valid.'));
    }
    const payload = await profileRes.json();
    
    if (!payload || !payload.email) {
      return next(new ApiError(401, 'INVALID_TOKEN', 'security', 'Invalid Google token payload.', 'Token Google tidak valid.'));
    }
    
    const email = String(payload.email || '').trim().toLowerCase();
    const googleId = String(payload.sub || ''); // Google Account ID
    const name = payload.name || email.split('@')[0];

    const masterEmail = String(process.env.GAIN_MASTER_OWNER_EMAIL || '').trim().toLowerCase();
    const adminEmails = String(process.env.ADMIN_EMAILS || '').toLowerCase();
    const isMaster = (masterEmail && email === masterEmail) || (adminEmails && adminEmails.includes(email));

    // Look up existing user by googleId or email
    let userRecord = await getUserByFirebaseUid(googleId);
    if (!userRecord && email) {
      const byEmail = await dbQuery<any>('SELECT * FROM users WHERE lower(email) = $1 LIMIT 1', [email]);
      if (byEmail.rows[0]) {
        userRecord = byEmail.rows[0];
      }
    }

    let role = userRecord?.role || (isMaster ? 'superadmin' : 'user');
    if (isMaster && role !== 'superadmin') {
      role = 'superadmin';
      if (userRecord) {
        await dbQuery("UPDATE users SET role = 'superadmin', updated_at = now() WHERE id = $1", [userRecord.id]).catch(() => {});
      }
    }

    // Phase 1: Issue custom JWT with role
    const token = signCustomJwt({ uid: googleId, email, name, role });
    
    res.cookie('gain_auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    
    res.json({ 
      success: true, 
      token, 
      user: { uid: googleId, email, name, displayName: name, role, emailVerified: payload.email_verified } 
    });
  } catch (error) {
    console.error('[GOOGLE_AUTH_FAILED]', error);
    next(new ApiError(401, 'GOOGLE_AUTH_FAILED', 'security', 'Failed to authenticate with Google.', 'Otentikasi Google gagal.'));
  }
});

export default router;
