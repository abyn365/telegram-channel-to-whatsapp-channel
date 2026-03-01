const path = require('path');
const logger = require('./logger');
const { downloadMedia, getMediaType, extractSenderInfo, getSenderName } = require('./telegramClient');
const { sendMessage } = require('./whatsappClient');
const { buildPayload } = require('./messageFormatter');

const TEMP_DIR = path.join(__dirname, '../temp');

const TEXT_ONLY_TYPES = new Set(['text', 'webpage', 'poll', 'location', 'contact', 'unknown']);

async function resolveChannelTitle(telegramClient, chatPeer) {
    try {
        const entity = await telegramClient.getEntity(chatPeer);
        return entity.title || entity.username || String(entity.id);
    } catch {
        return '';
    }
}

async function forwardMessage(telegramClient, whatsappClient, message, targetId, channelTitle) {
    const mediaType = getMediaType(message);
    logger.info(`Forwarding message id=${message.id} type=${mediaType} from "${channelTitle}"`);

    let filePath = null;

    if (!TEXT_ONLY_TYPES.has(mediaType)) {
        filePath = await downloadMedia(telegramClient, message, TEMP_DIR);
    }

    const senderInfo = extractSenderInfo(message, telegramClient);
    
    if (!senderInfo.name && message.fromId) {
        const senderName = await getSenderName(telegramClient, message.fromId);
        if (senderName) {
            senderInfo.name = senderName;
        }
    }

    const payload = buildPayload(message, filePath, channelTitle, senderInfo);

    try {
        await sendMessage(whatsappClient, targetId, payload);
        logger.info(`Message id=${message.id} forwarded to WhatsApp successfully.`);
    } catch (err) {
        logger.error(`Failed to forward message id=${message.id}:`, err);
        if (filePath) {
            const fs = require('fs-extra');
            await fs.remove(filePath).catch(() => {});
        }
    }
}

module.exports = { forwardMessage, resolveChannelTitle };
