import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { spawnSync } from 'child_process';
import logger from './logger.js';
import { ensureAdminSeeded } from './dashboardData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.join(__dirname, '..');
const WEB_DIR = path.join(APP_DIR, 'web');

export { storeForwardPreview } from './dashboardData.js';

function startStaticFallbackServer(port) {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

    const target = pathname === '/' ? '/index.html' : pathname;
    const fullPath = path.join(WEB_DIR, target);

    if (!fullPath.startsWith(WEB_DIR) || !(await fs.pathExists(fullPath))) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Dashboard fallback file not found' }));
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(fullPath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      logger.warn(`Dashboard fallback (static web/) running at http://0.0.0.0:${port}`);
      resolve(server);
    });
  });
}

function ensureNextBuildIfNeeded() {
  const inProduction = process.env.NODE_ENV === 'production';
  const buildIdPath = path.join(APP_DIR, '.next', 'BUILD_ID');

  if (!inProduction || fs.existsSync(buildIdPath)) {
    return true;
  }

  logger.warn('Next.js production build not found. Running "npm run dashboard:build" automatically...');
  const result = spawnSync('npm', ['run', 'dashboard:build'], {
    cwd: APP_DIR,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    logger.error('Automatic dashboard build failed. Falling back to static dashboard.');
    return false;
  }

  return true;
}

export async function startDashboardServer() {
  await ensureAdminSeeded();

  const port = Number(process.env.DASHBOARD_PORT || 8787);
  const shouldTryNext = String(process.env.DASHBOARD_DISABLE_NEXT || 'false').toLowerCase() !== 'true';

  if (!shouldTryNext) {
    logger.warn('DASHBOARD_DISABLE_NEXT=true, using static dashboard fallback.');
    return startStaticFallbackServer(port);
  }

  try {
    const buildReady = ensureNextBuildIfNeeded();
    if (!buildReady) {
      return startStaticFallbackServer(port);
    }

    const { default: next } = await import('next');
    const dev = process.env.NODE_ENV !== 'production';
    const app = next({ dev, dir: APP_DIR });
    const handle = app.getRequestHandler();

    await app.prepare();

    const server = http.createServer(async (req, res) => {
      try {
        await handle(req, res);
      } catch (error) {
        logger.error(`Next dashboard request error: ${error.message}`);
        res.statusCode = 500;
        res.end('Internal server error');
      }
    });

    await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
    logger.info(`Dashboard (Next.js) available at http://0.0.0.0:${port}`);
    return server;
  } catch (error) {
    logger.error(`Next dashboard startup failed: ${error.message}`);
    logger.warn('Falling back to static web/ dashboard so npm start/pm2 remain operational.');
    return startStaticFallbackServer(port);
  }
}
