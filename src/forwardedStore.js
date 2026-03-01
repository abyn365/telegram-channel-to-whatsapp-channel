import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORE_FILE = path.join(__dirname, '../logs/forwarded-messages.jsonl');
const forwardedKeys = new Set();
let initialized = false;
let persistQueue = [];
let persistTimer = null;

// Configuration
const MAX_STORE_SIZE = parseInt(process.env.MAX_FORWARDED_STORE_SIZE, 10) || 50000;
const PERSIST_INTERVAL = parseInt(process.env.FORWARDED_PERSIST_INTERVAL_MS, 10) || 5000;
const CLEANUP_INTERVAL = parseInt(process.env.FORWARDED_CLEANUP_INTERVAL_MS, 10) || 3600000; // 1 hour

// Periodic cleanup to prevent memory bloat
async function cleanupOldEntries() {
    if (forwardedKeys.size <= MAX_STORE_SIZE) return;
    
    const toRemove = forwardedKeys.size - MAX_STORE_SIZE;
    const keysArray = [...forwardedKeys];
    
    for (let i = 0; i < toRemove; i++) {
        forwardedKeys.delete(keysArray[i]);
    }
    
    logger.info(`Cleaned up ${toRemove} old entries from forwarded store. Current size: ${forwardedKeys.size}`);
}

async function initForwardedStore() {
    if (initialized) return;
    initialized = true;

    try {
        await fs.ensureFile(STORE_FILE);
        const raw = await fs.readFile(STORE_FILE, 'utf-8');
        if (!raw.trim()) return;

        let loadedCount = 0;
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed?.key) {
                    forwardedKeys.add(parsed.key);
                    loadedCount++;
                }
            } catch {
                // ignore malformed historical lines
            }
        }

        logger.info(`Loaded ${loadedCount} forwarded-message keys from store`);
        
        // Schedule periodic cleanup
        setInterval(() => {
            cleanupOldEntries().catch(err => {
                logger.debug(`Cleanup error: ${err.message}`);
            });
        }, CLEANUP_INTERVAL);
        
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

// Batch persist for better performance
async function flushPersistQueue() {
    if (persistQueue.length === 0) return;
    
    const itemsToPersist = [...persistQueue];
    persistQueue = [];
    
    try {
        const lines = itemsToPersist.map(item => JSON.stringify(item)).join('\n') + '\n';
        await fs.appendFile(STORE_FILE, lines, 'utf-8');
    } catch (err) {
        logger.warn(`Failed to persist forwarded keys: ${err.message || err}`);
        // Re-queue failed items
        persistQueue = [...itemsToPersist, ...persistQueue];
    }
}

async function markForwarded(key, metadata = {}) {
    if (!key || forwardedKeys.has(key)) return;
    forwardedKeys.add(key);

    const payload = {
        key,
        timestamp: new Date().toISOString(),
        ...metadata,
    };
    
    // Add to persist queue
    persistQueue.push(payload);
    
    // Schedule flush if not already scheduled
    if (!persistTimer) {
        persistTimer = setTimeout(async () => {
            persistTimer = null;
            await flushPersistQueue();
        }, PERSIST_INTERVAL);
    }
    
    // Immediate flush if queue is getting large
    if (persistQueue.length >= 100) {
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        await flushPersistQueue();
    }
}

// Get store stats for monitoring
function getStoreStats() {
    return {
        size: forwardedKeys.size,
        persistQueueSize: persistQueue.length,
        initialized,
    };
}

// Graceful shutdown - flush any pending items
async function shutdown() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    await flushPersistQueue();
    logger.info('Forwarded store shut down cleanly');
}

export { 
    initForwardedStore, 
    buildForwardKey, 
    hasForwarded, 
    markForwarded, 
    getStoreStats,
    shutdown 
};
