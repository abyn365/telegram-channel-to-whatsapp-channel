import http from 'http';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { kvGet, kvSet, kvGetForwards, kvGetChannels, kvPushForward, kvAddChannel } from './redisStore.js';
import { signJwt, verifyJwt, hashPassword, verifyPassword } from './security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.join(__dirname, '../web');

const SETTINGS_KEY = 'dashboard:settings';
const ADMIN_KEY = 'dashboard:admin';

const defaultSettings = {
  botName: 'Forward Bot',
  infoTitle: 'Sources & Admin Info',
  infoContent: 'Add sources, admin details, and contacts from the admin panel.',
  contact: 'admin@example.com',
  theme: 'dark',
  templates: [
    { channel: 'wfwitness', postId: '74427' },
  ],
};

async function getSettings() {
  const raw = await kvGet(SETTINGS_KEY);
  if (!raw) return defaultSettings;
  try {
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return defaultSettings;
  }
}

async function writeJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.replace('Bearer ', '').trim();
}

async function ensureAdminSeeded() {
  const existing = await kvGet(ADMIN_KEY);
  if (existing) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const initialPassword = process.env.ADMIN_PASSWORD || 'ChangeThisNow123!';
  const hash = hashPassword(initialPassword);
  await kvSet(ADMIN_KEY, JSON.stringify({ username, hash }));
  logger.warn(`Admin seeded with default credentials (username=${username}). Set ADMIN_PASSWORD immediately.`);
}

async function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.join(WEB_DIR, target);
  if (!fullPath.startsWith(WEB_DIR)) {
    return writeJson(res, 403, { error: 'Forbidden' });
  }

  if (!(await fs.pathExists(fullPath))) {
    return writeJson(res, 404, { error: 'Not found' });
  }

  const ext = path.extname(fullPath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
  };
  const contentType = map[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(fullPath).pipe(res);
}

export async function storeForwardPreview(preview) {
  const normalized = {
    ...preview,
    createdAt: preview.createdAt || new Date().toISOString(),
  };
  const existing = await kvGetForwards(1);
  if (existing[0] && existing[0].messageKey === normalized.messageKey) return;
  await kvPushForward(normalized, 300);
  if (normalized.channel) {
    await kvAddChannel(normalized.channel);
  }
}

export async function startDashboardServer() {
  await ensureAdminSeeded();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self' https://telegram.org; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:;");

    try {
      if (pathname === '/api/public/settings' && req.method === 'GET') {
        const settings = await getSettings();
        return writeJson(res, 200, settings);
      }

      if (pathname === '/api/public/forwards' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 30);
        const since = url.searchParams.get('since');
        const rows = await kvGetForwards(Math.min(limit, 100));
        const filtered = since ? rows.filter((row) => row.createdAt > since) : rows;
        return writeJson(res, 200, { items: filtered });
      }

      if (pathname === '/api/public/channels' && req.method === 'GET') {
        const channels = await kvGetChannels();
        return writeJson(res, 200, { channels });
      }

      if (pathname === '/api/admin/login' && req.method === 'POST') {
        const body = await parseBody(req);
        const userRaw = await kvGet(ADMIN_KEY);
        const admin = userRaw ? JSON.parse(userRaw) : null;
        if (!admin || body.username !== admin.username || !verifyPassword(body.password, admin.hash)) {
          return writeJson(res, 401, { error: 'Invalid credentials' });
        }

        const token = signJwt({ sub: admin.username, role: 'admin' });
        return writeJson(res, 200, { token });
      }

      if (pathname.startsWith('/api/admin/')) {
        const token = getToken(req);
        const claims = verifyJwt(token);
        if (!claims || claims.role !== 'admin') {
          return writeJson(res, 401, { error: 'Unauthorized' });
        }
      }

      if (pathname === '/api/admin/settings' && req.method === 'GET') {
        return writeJson(res, 200, await getSettings());
      }

      if (pathname === '/api/admin/settings' && req.method === 'PUT') {
        const body = await parseBody(req);
        const current = await getSettings();
        const next = {
          ...current,
          ...body,
          templates: Array.isArray(body.templates) ? body.templates : current.templates,
        };
        await kvSet(SETTINGS_KEY, JSON.stringify(next));
        return writeJson(res, 200, next);
      }

      if (pathname === '/api/admin/password' && req.method === 'PUT') {
        const body = await parseBody(req);
        const userRaw = await kvGet(ADMIN_KEY);
        const admin = userRaw ? JSON.parse(userRaw) : null;
        if (!admin || !verifyPassword(body.oldPassword, admin.hash)) {
          return writeJson(res, 400, { error: 'Invalid old password' });
        }
        admin.hash = hashPassword(body.newPassword);
        await kvSet(ADMIN_KEY, JSON.stringify(admin));
        return writeJson(res, 200, { ok: true });
      }

      return serveStatic(req, res, pathname);
    } catch (error) {
      logger.error(`Dashboard API error: ${error.message}`);
      return writeJson(res, 500, { error: 'Internal server error' });
    }
  });

  const port = Number(process.env.DASHBOARD_PORT || 8787);
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  logger.info(`Dashboard available at http://0.0.0.0:${port}`);

  return server;
}
