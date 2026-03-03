import { kvGet, kvSet, kvGetForwards, kvGetChannels, kvPushForward, kvAddChannel } from './redisStore.js';
import { signJwt, verifyJwt, hashPassword, verifyPassword } from './security.js';
import logger from './logger.js';

const SETTINGS_KEY = 'dashboard:settings';
const ADMIN_KEY = 'dashboard:admin';

export const defaultSettings = {
  botName: 'Forward Bot',
  infoTitle: 'Sources & Admin Info',
  infoContent: 'Add sources, admin details, and contacts from the admin panel.',
  contact: 'admin@example.com',
  theme: 'dark',
  templates: [{ channel: 'wfwitness', postId: '74427' }],
  ui: {
    badgeText: 'Live Forwarding Dashboard',
    heroSubtitle: 'Forwarded updates from Telegram channels in a cleaner feed.',
    feedTitle: 'Forwarded Feed',
    feedHint: 'Auto-refresh every 10 seconds. Indonesian translation is shown first when available.',
    accentColor: '#5f7cff',
    footerText: 'Powered by Telegram → WhatsApp Forwarder',
  },
};

export async function getSettings() {
  const raw = await kvGet(SETTINGS_KEY);
  if (!raw) return defaultSettings;
  try {
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return defaultSettings;
  }
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    templates: Array.isArray(patch.templates) ? patch.templates : current.templates,
    ui: {
      ...current.ui,
      ...(patch.ui || {}),
    },
  };

  await kvSet(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export async function getForwards(limit = 30, since = null) {
  const rows = await kvGetForwards(Math.min(Math.max(limit, 1), 100));
  return since ? rows.filter((row) => row.createdAt > since) : rows;
}

export async function getChannels() {
  return kvGetChannels();
}

export async function ensureAdminSeeded() {
  const existing = await kvGet(ADMIN_KEY);
  if (existing) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const initialPassword = process.env.ADMIN_PASSWORD || 'ChangeThisNow123!';
  const hash = hashPassword(initialPassword);
  await kvSet(ADMIN_KEY, JSON.stringify({ username, hash }));
  logger.warn(`Admin seeded with default credentials (username=${username}). Set ADMIN_PASSWORD immediately.`);
}

export async function adminLogin(username, password) {
  const userRaw = await kvGet(ADMIN_KEY);
  const admin = userRaw ? JSON.parse(userRaw) : null;

  if (!admin || username !== admin.username || !verifyPassword(password, admin.hash)) {
    return null;
  }

  return signJwt({ sub: admin.username, role: 'admin' });
}

export function requireAdmin(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;

  const token = header.replace('Bearer ', '').trim();
  const claims = verifyJwt(token);
  if (!claims || claims.role !== 'admin') return null;
  return claims;
}

export async function rotatePassword(oldPassword, newPassword) {
  const userRaw = await kvGet(ADMIN_KEY);
  const admin = userRaw ? JSON.parse(userRaw) : null;
  if (!admin || !verifyPassword(oldPassword, admin.hash)) {
    return false;
  }

  admin.hash = hashPassword(newPassword);
  await kvSet(ADMIN_KEY, JSON.stringify(admin));
  return true;
}

export async function storeForwardPreview(preview) {
  const normalized = {
    ...preview,
    createdAt: preview.createdAt || new Date().toISOString(),
  };

  const existing = await kvGetForwards(1);
  if (existing[0] && existing[0].messageKey === normalized.messageKey) {
    return;
  }

  await kvPushForward(normalized, 300);
  if (normalized.channel) {
    await kvAddChannel(normalized.channel);
  }
}
