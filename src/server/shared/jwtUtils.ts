import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';

let fallbackSecret: string | undefined;

function getJwtSecret(): string {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }
  if (!fallbackSecret) {
    fallbackSecret = randomBytes(32).toString('hex');
    if (process.env.NODE_ENV === 'production') {
      console.warn('[SECURITY WARNING] JWT_SECRET is not set in production. Sessions will be invalidated on server restart.');
    }
  }
  return fallbackSecret;
}

export interface JwtPayload {
  uid: string;
  email?: string;
  name?: string;
  role?: string;
}

export function signCustomJwt(payload: JwtPayload, expiresIn = '7d'): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
}

export function verifyCustomJwt(token: string): JwtPayload {
  try {
    return jwt.verify(token, getJwtSecret()) as JwtPayload;
  } catch (error) {
    throw Object.assign(new Error('Invalid or expired token'), { code: 'INVALID_TOKEN' });
  }
}
