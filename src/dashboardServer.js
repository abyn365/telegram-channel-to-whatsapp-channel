import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import next from 'next';
import logger from './logger.js';
import { ensureAdminSeeded } from './dashboardData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.join(__dirname, '..');

export { storeForwardPreview } from './dashboardData.js';

export async function startDashboardServer() {
  await ensureAdminSeeded();

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

  const port = Number(process.env.DASHBOARD_PORT || 8787);
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  logger.info(`Dashboard (Next.js) available at http://0.0.0.0:${port}`);

  return server;
}
