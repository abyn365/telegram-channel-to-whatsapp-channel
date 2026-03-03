import crypto from 'crypto';
import { getAdmin, setAdmin } from './kv.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

const b64 = (v) => Buffer.from(v).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const ub64 = (v) => {
  const n = v.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(n + '='.repeat((4 - (n.length % 4)) % 4), 'base64').toString('utf8');
};

export function signJwt(payload, expSec = 60 * 60 * 8) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...payload, iat: now, exp: now + expSec }));
  const data = `${head}.${body}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${data}.${sig}`;
}

export function verifyJwt(token) {
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (sig !== s) return null;
  const body = JSON.parse(ub64(p));
  if (body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, oldHash] = String(stored || '').split(':');
  if (!salt || !oldHash) return false;
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(oldHash, 'hex'));
}

export async function ensureAdminSeeded() {
  const existing = await getAdmin();
  if (existing) return;
  await setAdmin({
    username: process.env.ADMIN_USERNAME || 'admin',
    hash: hashPassword(process.env.ADMIN_PASSWORD || 'ChangeThisNow123!'),
  });
}
