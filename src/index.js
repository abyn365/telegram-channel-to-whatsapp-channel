import 'dotenv/config';
import logger from './logger.js';
import {
    createTelegramClients,
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
import { startDashboardServer } from './dashboardServer.js';

// Health check interval
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 60000;

// Validate required environment variables
function validateEnvironment() {
    const errors = [];
    const warnings = [];
    
    // Required variables
    const required = [
        { key: 'TELEGRAM_CHANNELS', validate: (v) => (v && v.trim().length > 0) || 'Must not be empty' },
        { key: 'WHATSAPP_TARGET_ID', validate: (v) => (v && v.trim().length > 0) || 'Must not be empty' },
    ];

    if (process.env.TELEGRAM_ACCOUNTS_JSON) {
        try {
            const parsed = JSON.parse(process.env.TELEGRAM_ACCOUNTS_JSON);
            if (!Array.isArray(parsed) || parsed.length === 0) {
                errors.push('TELEGRAM_ACCOUNTS_JSON must be a non-empty JSON array');
            }
        } catch (err) {
            errors.push(`TELEGRAM_ACCOUNTS_JSON invalid JSON: ${err.message}`);
        }
    } else {
        warnings.push('Using legacy TELEGRAM_API_ID/HASH/PHONE config. Prefer TELEGRAM_ACCOUNTS_JSON as default.');
        required.unshift(
            { key: 'TELEGRAM_PHONE', validate: (v) => (v && String(v).split(',')[0].startsWith('+')) || 'Must start with +' },
            { key: 'TELEGRAM_API_HASH', validate: (v) => (v && String(v).split(',')[0].length === 32) || 'Must be 32 characters (first account)' },
            { key: 'TELEGRAM_API_ID', validate: (v) => !isNaN(parseInt(String(v).split(',')[0])) || 'Must be a number' },
        );
    }
    
    for (const { key, validate } of required) {
        const value = process.env[key];
        if (!value) {
            errors.push(`${key} is required but not set`);
        } else {
            const validationResult = validate(value);
            if (validationResult !== true) {
                errors.push(`${key}: ${validationResult}`);
            }
        }
    }
    
    // Optional but recommended
    if (!process.env.NEWSLETTER_MEDIA_MODE) {
        warnings.push('NEWSLETTER_MEDIA_MODE not set, using default "hybrid"');
    }
    
    if (!process.env.MAX_FILE_SIZE_MB) {
        warnings.push('MAX_FILE_SIZE_MB not set, using default 50 MB');
    }
    
    // Validate numeric ranges
    const numericConfigs = [
        { key: 'SEND_DELAY_MS', min: 500, max: 10000, default: 1500 },
        { key: 'MAX_RETRIES', min: 1, max: 10, default: 3 },
        { key: 'MAX_FILE_SIZE_MB', min: 1, max: 100, default: 50 },
        { key: 'HEALTH_CHECK_INTERVAL_MS', min: 10000, max: 600000, default: 60000 },
    ];
    
    for (const { key, min, max, default: defaultVal } of numericConfigs) {
        const val = parseInt(process.env[key], 10);
        if (process.env[key] && (isNaN(val) || val < min || val > max)) {
            warnings.push(`${key} should be between ${min} and ${max}, using default ${defaultVal}`);
        }
    }
    
    // Log warnings
    if (warnings.length > 0) {
        logger.warn('Configuration warnings:');
        warnings.forEach(w => logger.warn(`  - ${w}`));
    }
    
    // Throw on errors
    if (errors.length > 0) {
        logger.error('Configuration errors:');
        errors.forEach(e => logger.error(`  - ${e}`));
        throw new Error(`Invalid configuration: ${errors.join('; ')}`);
    }
    
    logger.info('Configuration validated successfully');
    return true;
}

// Log startup configuration
function logStartupConfig() {
    const config = {
        'Node.js': process.version,
        'Platform': `${process.platform} ${process.arch}`,
        'DDL Mode': process.env.WHATSAPP_DDL_MODE || 'false',
        'Media Mode': process.env.NEWSLETTER_MEDIA_MODE || 'hybrid',
        'Send Delay': `${process.env.SEND_DELAY_MS || 1500}ms`,
        'Max Retries': process.env.MAX_RETRIES || 3,
        'Max File Size': `${process.env.MAX_FILE_SIZE_MB || 50}MB`,
        'Translation': process.env.TRANSLATE_TO_ID !== 'false' ? 'enabled' : 'disabled',
        'Health Check Interval': `${process.env.HEALTH_CHECK_INTERVAL_MS || 60000}ms`,
        'Log Level': process.env.LOG_LEVEL || 'info',
    };
    
    logger.info('='.repeat(60));
    logger.info('Telegram → WhatsApp Forwarder Starting');
    logger.info('='.repeat(60));
    
    for (const [key, value] of Object.entries(config)) {
        logger.info(`  ${key}: ${value}`);
    }
    
    logger.info('='.repeat(60));
}

async function main() {
    logStartupConfig();
    
    // Validate environment before starting
    validateEnvironment();

    const rawChannels = process.env.TELEGRAM_CHANNELS;
    const targetId = process.env.WHATSAPP_TARGET_ID;

    const channels = resolveChannelTargets(rawChannels);

    logger.info('Connecting to Telegram...');
    const telegramClients = await createTelegramClients();

    logger.info('Connecting to WhatsApp (WebSocket — no browser required)...');
    const whatsappSock = await createWhatsAppClientWithReconnect();

    await checkNewsletterAccess(whatsappSock, targetId);

    const dashboardsrv = await startDashboardServer();

    for (const telegramClient of telegramClients) {
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
    startPollingChannels(telegramClient, channelEntities, handleIncomingMessage);
    }

    logger.info('Forwarder + dashboard are running. Waiting for new messages...');
    logger.info('Press Ctrl+C to stop.');

    // Health check interval
    const healthCheckTimer = setInterval(async () => {
        const tgConnected = telegramClients.every((client) => client.connected);
        const waHealthy = await isConnectionHealthy(whatsappSock);
        const queueStats = getQueueStats();

        const status = `Telegram=${tgConnected ? 'OK' : 'DISCONNECTED'}, WhatsApp=${waHealthy ? 'OK' : 'UNHEALTHY'}, Queue=${queueStats.pending} pending, ${queueStats.processed} processed, ${queueStats.failed} failed`;
        
        if (!tgConnected || !waHealthy) {
            logger.warn(`Health check: ${status}`);
        } else {
            logger.info(`Health check: ${status}`);
        }

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
            dashboardsrv.close();
            logger.info('Dashboard server stopped');
        } catch (err) {
            logger.debug(`Error stopping polling: ${err.message}`);
        }
        
        // Disconnect Telegram
        try {
            await Promise.all(telegramClients.map((client) => client.disconnect()));
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
