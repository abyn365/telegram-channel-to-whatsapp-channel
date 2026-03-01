import 'dotenv/config';
import logger from './logger.js';
import {
    createTelegramClient,
    resolveChannelTargets,
    resolveChannelEntities,
    startListener,
    startPollingChannels,
} from './telegramClient.js';
import {
    createWhatsAppClientWithReconnect,
    checkNewsletterAccess,
    isConnectionHealthy,
} from './whatsappClient.js';
import { forwardMessage, getQueueStats } from './forwarder.js';
import { shutdown as shutdownForwardedStore } from './forwardedStore.js';

// Health check interval
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 60000;

async function main() {
    logger.info('Starting Telegram → WhatsApp forwarder (powered by Baileys — no Chrome needed)...');
    logger.info(`Node.js version: ${process.version}`);
    logger.info(`Platform: ${process.platform} ${process.arch}`);

    const rawChannels = process.env.TELEGRAM_CHANNELS;
    if (!rawChannels) throw new Error('TELEGRAM_CHANNELS is not set in .env');

    const targetId = process.env.WHATSAPP_TARGET_ID;
    if (!targetId) throw new Error('WHATSAPP_TARGET_ID is not set in .env');

    const channels = resolveChannelTargets(rawChannels);

    logger.info('Connecting to Telegram...');
    const telegramClient = await createTelegramClient();

    logger.info('Connecting to WhatsApp (WebSocket — no browser required)...');
    const whatsappSock = await createWhatsAppClientWithReconnect();

    await checkNewsletterAccess(whatsappSock, targetId);

    const { channelEntities, channelTitles } = await resolveChannelEntities(telegramClient, channels);

    for (const ch of channels) {
        const title = channelTitles[ch] || channelTitles[ch.replace(/^@/, '')] || '';
        logger.info(`Watching Telegram channel: ${ch} → "${title || 'Unknown'}"`);
    }

    const processedMessages = new Set();
    const MAX_PROCESSED_SIZE = 10000;

    const handleIncomingMessage = async (message) => {
        const chatKey = String(
            message.peerId?.channelId || message.peerId?.chatId || message.peerId?.userId || ''
        );
        const dedupeKey = `${chatKey}:${message.id || ''}`;
        
        if (processedMessages.has(dedupeKey)) {
            return;
        }
        
        processedMessages.add(dedupeKey);
        
        // Prevent memory leak
        if (processedMessages.size > MAX_PROCESSED_SIZE) {
            const stale = [...processedMessages].slice(0, MAX_PROCESSED_SIZE / 10);
            for (const key of stale) {
                processedMessages.delete(key);
            }
        }

        const titleByPeer = channelTitles[chatKey] || channelTitles[`-100${chatKey}`] || '';

        let title = titleByPeer;
        if (!title) {
            for (const val of Object.values(channelTitles)) {
                if (val) { title = val; break; }
            }
        }

        await forwardMessage(telegramClient, whatsappSock, message, targetId, title);
    };

    startListener(telegramClient, channelEntities, handleIncomingMessage);
    const stopPolling = startPollingChannels(telegramClient, channelEntities, handleIncomingMessage);

    logger.info('Forwarder is running. Waiting for new messages...');

    // Health check interval
    const healthCheckTimer = setInterval(async () => {
        const tgConnected = telegramClient.connected;
        const waHealthy = await isConnectionHealthy(whatsappSock);
        const queueStats = getQueueStats();

        logger.info(`Health check: Telegram=${tgConnected ? 'OK' : 'DISCONNECTED'}, WhatsApp=${waHealthy ? 'OK' : 'UNHEALTHY'}, Queue=${queueStats.pending} pending, ${queueStats.processed} processed, ${queueStats.failed} failed`);

        if (!waHealthy) {
            logger.warn('WhatsApp connection appears unhealthy. Monitor for reconnection.');
        }
    }, HEALTH_CHECK_INTERVAL);

    // Graceful shutdown
    let isShuttingDown = false;
    
    const shutdown = async (signal) => {
        if (isShuttingDown) {
            logger.info('Already shutting down, please wait...');
            return;
        }
        isShuttingDown = true;
        
        logger.info(`${signal} received. Shutting down gracefully...`);
        
        // Stop health checks
        clearInterval(healthCheckTimer);
        
        // Stop polling
        try { 
            stopPolling(); 
            logger.info('Telegram polling stopped');
        } catch (err) {
            logger.debug(`Error stopping polling: ${err.message}`);
        }
        
        // Disconnect Telegram
        try { 
            await telegramClient.disconnect(); 
            logger.info('Telegram disconnected');
        } catch (err) {
            logger.debug(`Error disconnecting Telegram: ${err.message}`);
        }
        
        // Close WhatsApp connection
        try { 
            whatsappSock.end(undefined); 
            logger.info('WhatsApp disconnected');
        } catch (err) {
            logger.debug(`Error disconnecting WhatsApp: ${err.message}`);
        }
        
        // Flush forwarded store
        try {
            await shutdownForwardedStore();
        } catch (err) {
            logger.debug(`Error shutting down forwarded store: ${err.message}`);
        }
        
        logger.info('Shutdown complete. Goodbye!');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
        logger.error('Uncaught exception:', err);
        if (!isShuttingDown) {
            shutdown('UNCAUGHT_EXCEPTION');
        }
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    });

    // Log memory usage periodically
    if (process.env.LOG_MEMORY_USAGE === 'true') {
        setInterval(() => {
            const mem = process.memoryUsage();
            logger.info(`Memory: RSS=${(mem.rss / 1024 / 1024).toFixed(2)}MB, Heap=${(mem.heapUsed / 1024 / 1024).toFixed(2)}MB/${(mem.heapTotal / 1024 / 1024).toFixed(2)}MB`);
        }, 300000); // Every 5 minutes
    }
}

main().catch((err) => {
    logger.error('Fatal error in main:', err);
    process.exit(1);
});
