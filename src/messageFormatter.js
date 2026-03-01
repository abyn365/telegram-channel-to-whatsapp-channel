const {
    extractText,
    extractWebPageUrl,
    getMediaType,
    getPollText,
    getLocationText,
    getContactText,
} = require('./telegramClient');

const MEDIA_EMOJI = {
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

    const emoji = MEDIA_EMOJI[mediaType] || '📩';
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

    const body = parts.filter(Boolean).join('\n\n');

    if (!includeQuote) return body;

    const quoteParts = [];
    if (channelTitle) quoteParts.push(`Channel: ${channelTitle}`);
    if (senderInfo?.name) quoteParts.push(`Author: ${senderInfo.name}`);

    if (quoteParts.length > 0) {
        return `${body}\n\n> ${quoteParts.join(' | ')}`;
    }

    return body;
}

function buildPayload(message, filePath, channelTitle, senderInfo) {
    const prefix = process.env.MESSAGE_PREFIX || '';
    const text = buildCaption(message, channelTitle, prefix, senderInfo);
    const mediaType = getMediaType(message);
    return { text, filePath, mediaType };
}

module.exports = { buildPayload };
