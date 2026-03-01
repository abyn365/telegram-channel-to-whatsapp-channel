const {
    extractText,
    extractWebPageUrl,
    getMediaType,
    getPollText,
    getLocationText,
    getContactText,
} = require('./telegramClient');

const CHANNEL_ORIGIN_EMOJI = {
    photo: '🖼️',
    video: '🎬',
    audio: '🎵',
    gif: '🎞️',
    sticker: '🪄',
    image: '🖼️',
    document: '📎',
    webpage: '🔗',
    poll: '📊',
    location: '📍',
    contact: '👤',
    text: '💬',
    unknown: '📩',
};

function buildCaption(message, channelTitle, prefix, senderInfo) {
    const includeQuote = process.env.INCLUDE_QUOTE !== 'false';
    
    const mediaType = getMediaType(message);
    const rawText = extractText(message);
    const webUrl = extractWebPageUrl(message);
    const parts = [];

    if (prefix) parts.push(prefix);

    const emoji = CHANNEL_ORIGIN_EMOJI[mediaType] || '📩';
    if (channelTitle) parts.push(`${emoji} *${channelTitle}*`);

    if (rawText) parts.push(rawText);

    if (mediaType === 'poll') {
        parts.push(getPollText(message));
    } else if (mediaType === 'location') {
        parts.push(getLocationText(message));
    } else if (mediaType === 'contact') {
        parts.push(getContactText(message));
    }

    if (webUrl) parts.push(`🔗 ${webUrl}`);

    const caption = parts.filter(Boolean).join('\n\n');

    if (!includeQuote) {
        return caption;
    }
    
    const quoteText = buildQuoteText(channelTitle, senderInfo);
    
    if (quoteText) {
        return `${caption}\n\n${quoteText}`;
    }
    
    return caption;
}

function buildQuoteText(channelTitle, senderInfo) {
    if (!channelTitle && !senderInfo?.name && !senderInfo?.phone) {
        return null;
    }

    const parts = [];
    
    if (channelTitle) {
        parts.push(`Channel: ${channelTitle}`);
    }
    
    if (senderInfo?.name) {
        parts.push(`Author: ${senderInfo.name}`);
    }
    
    if (senderInfo?.phone) {
        parts.push(`Number: ${senderInfo.phone}`);
    }

    if (parts.length === 0) {
        return null;
    }

    return `> ${parts.join(' | ')}`;
}

function buildPayload(message, filePath, channelTitle, senderInfo) {
    const prefix = process.env.MESSAGE_PREFIX || '';
    const text = buildCaption(message, channelTitle, prefix, senderInfo);
    const mediaType = getMediaType(message);

    return { text, filePath, mediaType };
}

module.exports = { buildPayload };
