import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORE_FILE = path.join(__dirname, '../logs/forwarded-messages.jsonl');
const forwardedKeys = new Set();
let initialized = false;

async function initForwardedStore() {
    if (initialized) return;
    initialized = true;

    try {
        await fs.ensureFile(STORE_FILE);
        const raw = await fs.readFile(STORE_FILE, 'utf-8');
        if (!raw.trim()) return;

        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed?.key) forwardedKeys.add(parsed.key);
            } catch {
                // ignore malformed historical lines
            }
        }

        logger.info(`Loaded ${forwardedKeys.size} forwarded-message keys from ${STORE_FILE}`);
    } catch (err) {
        logger.warn(`Failed to initialize forwarded store: ${err.message || err}`);
    }
}

function buildForwardKey(message, targetId) {
    const peer = String(message.peerId?.channelId || message.peerId?.chatId || message.peerId?.userId || 'unknown');
    const msgId = String(message.id || 'unknown');
    return `${targetId}::${peer}::${msgId}`;
}

function hasForwarded(key) {
    return forwardedKeys.has(key);
}

async function markForwarded(key, metadata = {}) {
    if (!key || forwardedKeys.has(key)) return;
    forwardedKeys.add(key);

    const payload = {
        key,
        timestamp: new Date().toISOString(),
        ...metadata,
    };

    try {
        await fs.appendFile(STORE_FILE, `${JSON.stringify(payload)}\n`, 'utf-8');
    } catch (err) {
        logger.warn(`Failed to persist forwarded key: ${err.message || err}`);
    }
}

export { initForwardedStore, buildForwardKey, hasForwarded, markForwarded };
