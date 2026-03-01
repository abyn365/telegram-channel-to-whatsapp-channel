import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import logger from './logger.js';
import { downloadMedia, getMediaType, extractSenderInfo, getSenderName, buildTelegramMessageLink } from './telegramClient.js';
import { sendMessage } from './whatsappClient.js';
import { buildPayload } from './messageFormatter.js';
import { initForwardedStore, buildForwardKey, hasForwarded, markForwarded } from './forwardedStore.js';
import { translateToIndonesian, appendTranslation } from './translator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.join(__dirname, '../temp');
const TEXT_ONLY_TYPES = new Set(['text', 'webpage', 'poll', 'location', 'contact', 'unknown']);

const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS, 10) || 1500;

function buildSourceFallbackText(captionText, sourceLink, mediaType) {
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

const messageQueue = [];
let isProcessing = false;

async function processQueue() {
    if (isProcessing || messageQueue.length === 0) return;
    isProcessing = true;

    while (messageQueue.length > 0) {
        const task = messageQueue.shift();
        try {
            await task();
        } catch (err) {
            logger.error('Queue task failed:', err);
        }
        if (messageQueue.length > 0) {
            await new Promise((res) => setTimeout(res, SEND_DELAY_MS));
        }
    }

    isProcessing = false;
}

function enqueue(task) {
    messageQueue.push(task);
    processQueue();
}

async function forwardMessage(telegramClient, whatsappSock, message, targetId, channelTitle) {
    await initForwardedStore();

    enqueue(async () => {
        const mediaType = getMediaType(message);
        const forwardKey = buildForwardKey(message, targetId);
        if (hasForwarded(forwardKey)) {
            logger.info(`Skipping duplicate forward for message id=${message.id} from "${channelTitle}"`);
            return;
        }

        logger.info(`Forwarding message id=${message.id} type=${mediaType} from "${channelTitle}"`);

        let filePath = null;

        if (!TEXT_ONLY_TYPES.has(mediaType)) {
            filePath = await downloadMedia(telegramClient, message, TEMP_DIR);
        }

        const senderInfo = extractSenderInfo(message, telegramClient);

        if (!senderInfo.name && message.fromId) {
            const senderName = await getSenderName(telegramClient, message.fromId);
            if (senderName) senderInfo.name = senderName;
        }

        const sourceLink = await buildTelegramMessageLink(telegramClient, message);
        const payload = buildPayload(message, filePath, channelTitle, senderInfo);

        const translated = await translateToIndonesian(payload.rawText || '');
        if (translated) {
            payload.text = appendTranslation(payload.text, translated);
        }

        try {
            await sendMessage(whatsappSock, targetId, payload);

            const sendLinkFallback = String(process.env.WHATSAPP_SEND_SOURCE_LINK || 'true').toLowerCase() !== 'false';
            if (sendLinkFallback && filePath && sourceLink) {
                const fallbackText = buildSourceFallbackText(payload.text, sourceLink, mediaType);
                if (fallbackText) {
                    await sendMessage(whatsappSock, targetId, {
                        text: fallbackText,
                        filePath: null,
                        mediaType: 'text',
                    });
                }
            }

            await markForwarded(forwardKey, {
                messageId: message.id,
                channelTitle,
                mediaType,
                sourceLink,
            });

            logger.info(`Message id=${message.id} forwarded to WhatsApp successfully.`);
        } catch (err) {
            logger.error(`Failed to forward message id=${message.id}:`, err);
            if (filePath) {
                await fs.remove(filePath).catch(() => {});
            }
        }
    });
}

export { forwardMessage };
