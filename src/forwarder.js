import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import logger from './logger.js';
import { downloadMedia, getMediaType, extractSenderInfo, getSenderName, buildTelegramMessageLink } from './telegramClient.js';
import { sendMessage, isConnectionHealthy, getConnectionState } from './whatsappClient.js';
import { buildPayload } from './messageFormatter.js';
import { initForwardedStore, buildForwardKey, hasForwarded, markForwarded } from './forwardedStore.js';
import { translateToIndonesian, appendTranslation } from './translator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.join(__dirname, '../temp');
const TEXT_ONLY_TYPES = new Set(['text', 'webpage', 'poll', 'location', 'contact', 'unknown']);

// DDL Mode: Send Telegram link instead of downloading and re-uploading media
const DDL_MODE = String(process.env.WHATSAPP_DDL_MODE || 'false').toLowerCase() === 'true';

const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS, 10) || 1500;
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE, 10) || 100;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES, 10) || 3;
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS, 10) || 5000;
const HEALTH_CHECK_RETRIES = parseInt(process.env.HEALTH_CHECK_RETRIES, 10) || 3;
const HEALTH_CHECK_RETRY_DELAY_MS = parseInt(process.env.HEALTH_CHECK_RETRY_DELAY_MS, 10) || 3000;

const sentSourceKeys = new Set();

function buildSourceDedupKey(message, targetId) {
    const peer = String(message.peerId?.channelId || message.peerId?.chatId || message.peerId?.userId || 'unknown');
    if (message.groupedId) {
        return `${targetId}::${peer}::grouped::${message.groupedId}`;
    }
    return `${targetId}::${peer}::single::${message.id || 'unknown'}`;
}

function shouldSendSourceFallback(message, targetId) {
    const key = buildSourceDedupKey(message, targetId);
    if (sentSourceKeys.has(key)) {
        return false;
    }

    sentSourceKeys.add(key);
    if (sentSourceKeys.size > 20000) {
        const stale = [...sentSourceKeys].slice(0, 2000);
        for (const item of stale) {
            sentSourceKeys.delete(item);
        }
    }

    return true;
}

function buildSourceFallbackText(captionText, sourceLink, mediaType) {
    // If there's a caption, combine it with source link instead of sending separately
    if (captionText && captionText.trim() && sourceLink) {
        const mediaLabel = mediaType || 'media';
        return `${captionText.trim()}\n\n🔗 Source (${mediaLabel}): ${sourceLink}`;
    }

    const parts = [];
    if (captionText && captionText.trim()) {
        parts.push(captionText.trim());
    }

    const mediaLabel = mediaType || 'media';
    if (sourceLink) {
        parts.push(`🔗 Source (${mediaLabel}): ${sourceLink}`);
    }

    return parts.filter(Boolean).join('\n\n');
}

// Message queue with priority and retry support
const messageQueue = [];
let isProcessing = false;
let queueStats = { processed: 0, failed: 0, retried: 0 };

async function processQueue(whatsappSock) {
    if (isProcessing || messageQueue.length === 0) return;
    isProcessing = true;

    while (messageQueue.length > 0) {
        // Check WhatsApp connection health with retries
        let healthCheckPassed = false;
        let healthCheckAttempts = 0;
        
        while (!healthCheckPassed && healthCheckAttempts < HEALTH_CHECK_RETRIES) {
            healthCheckAttempts++;
            
            if (await isConnectionHealthy(whatsappSock)) {
                healthCheckPassed = true;
                break;
            }
            
            if (healthCheckAttempts === 1) {
                logger.debug(`WhatsApp connection health check failed (internal state: ${getConnectionState()}), retrying...`);
            }
            
            if (healthCheckAttempts < HEALTH_CHECK_RETRIES) {
                await new Promise((res) => setTimeout(res, HEALTH_CHECK_RETRY_DELAY_MS));
            }
        }
        
        if (!healthCheckPassed) {
            logger.warn('WhatsApp connection appears unhealthy after multiple checks, pausing queue processing...');
            // Wait longer and retry once more
            await new Promise((res) => setTimeout(res, 10000));
            if (!await isConnectionHealthy(whatsappSock)) {
                logger.error('WhatsApp connection still unhealthy, stopping queue processing');
                break;
            }
        }

        const task = messageQueue.shift();
        try {
            await task();
            queueStats.processed++;
        } catch (err) {
            logger.error('Queue task failed:', err);
            queueStats.failed++;
        }

        // Log queue stats periodically
        if (queueStats.processed % 50 === 0) {
            logger.info(`Queue stats: processed=${queueStats.processed}, failed=${queueStats.failed}, pending=${messageQueue.length}`);
        }

        if (messageQueue.length > 0) {
            await new Promise((res) => setTimeout(res, SEND_DELAY_MS));
        }
    }

    isProcessing = false;
}

function enqueue(task, whatsappSock) {
    if (messageQueue.length >= MAX_QUEUE_SIZE) {
        logger.warn(`Message queue full (${MAX_QUEUE_SIZE}), dropping oldest message`);
        messageQueue.shift();
    }
    messageQueue.push(task);
    processQueue(whatsappSock);
}

async function forwardMessage(telegramClient, whatsappSock, message, targetId, channelTitle) {
    await initForwardedStore();

    enqueue(async () => {
        const mediaType = getMediaType(message);
        const forwardKey = buildForwardKey(message, targetId);
        
        if (hasForwarded(forwardKey)) {
            logger.debug(`Skipping duplicate forward for message id=${message.id} from "${channelTitle}"`);
            return;
        }

        logger.info(`Forwarding message id=${message.id} type=${mediaType} from "${channelTitle}" (DDL Mode: ${DDL_MODE})`);

        let filePath = null;
        let retryCount = 0;
        let success = false;

        // In DDL mode, we don't download media - we send the link instead
        // Only download if not in DDL mode and media type is not text-only
        if (!DDL_MODE && !TEXT_ONLY_TYPES.has(mediaType)) {
            filePath = await downloadMedia(telegramClient, message, TEMP_DIR);
            if (!filePath) {
                logger.warn(`Failed to download media for message ${message.id}, will forward text only if available`);
            }
        }

        const senderInfo = extractSenderInfo(message, message);

        if (!senderInfo.name && message.fromId) {
            try {
                const senderName = await getSenderName(telegramClient, message.fromId);
                if (senderName) senderInfo.name = senderName;
            } catch (err) {
                logger.debug(`Could not get sender name: ${err.message}`);
            }
        }

        const sourceLink = await buildTelegramMessageLink(telegramClient, message);
        
        // In DDL mode, build payload without filePath - we'll send link instead
        const payload = buildPayload(message, DDL_MODE ? null : filePath, channelTitle, senderInfo, sourceLink);

        // Translation
        try {
            const translated = await translateToIndonesian(payload.rawText || '', payload.text || '');
            if (translated) {
                payload.text = appendTranslation(payload.text, translated);
            }
        } catch (err) {
            logger.debug(`Translation failed: ${err.message}`);
        }

        // Retry loop
        while (!success && retryCount < MAX_RETRIES) {
            try {
                if (retryCount > 0) {
                    logger.info(`Retry attempt ${retryCount}/${MAX_RETRIES} for message ${message.id}`);
                    await new Promise((res) => setTimeout(res, RETRY_DELAY_MS * retryCount));
                }

                // In DDL mode, combine text and source link into single message
                let messagePayload = payload;
                if (DDL_MODE && sourceLink) {
                    const combinedText = buildSourceFallbackText(payload.text, sourceLink, mediaType);
                    messagePayload = {
                        text: combinedText,
                        filePath: null,
                        mediaType: 'text',
                    };
                }

                await sendMessage(whatsappSock, targetId, messagePayload);
                success = true;

                logger.info(`Message id=${message.id} forwarded to WhatsApp successfully (type: ${mediaType}, media: ${filePath ? 'yes' : 'no'})`);
                
            } catch (err) {
                retryCount++;
                queueStats.retried++;
                logger.error(`Failed to forward message id=${message.id} (attempt ${retryCount}):`, err.message);

                if (retryCount >= MAX_RETRIES) {
                    logger.error(`Giving up on message ${message.id} after ${MAX_RETRIES} attempts`);
                    
                    // Try to send a fallback text message with source link combined
                    if (payload.text && payload.text.trim()) {
                        try {
                            // Use the same function for consistency - combine text with source link
                            const fallbackText = buildSourceFallbackText(
                                `[Failed to forward media]\n\n${payload.text}`,
                                sourceLink,
                                mediaType
                            );
                            await sendMessage(whatsappSock, targetId, {
                                text: fallbackText,
                                filePath: null,
                                mediaType: 'text',
                            });
                            logger.info(`Sent fallback text for message ${message.id}`);
                        } catch (fallbackErr) {
                            logger.error(`Failed to send fallback text: ${fallbackErr.message}`);
                        }
                    }
                }
            }
        }

        // Mark as forwarded only if successful
        if (success) {
            await markForwarded(forwardKey, {
                messageId: message.id,
                channelTitle,
                mediaType,
                sourceLink,
                timestamp: new Date().toISOString(),
            });
        }

        // Clean up temp file
        if (filePath) {
            await fs.remove(filePath).catch(() => {});
        }
    }, whatsappSock);
}

// Export stats for monitoring
function getQueueStats() {
    return {
        ...queueStats,
        pending: messageQueue.length,
        isProcessing,
    };
}

export { forwardMessage, getQueueStats };
