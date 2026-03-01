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

function buildCaption(message, channelTitle, prefix) {
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

    return parts.filter(Boolean).join('\n\n');
}

function buildPayload(message, filePath, channelTitle) {
    const prefix = process.env.MESSAGE_PREFIX || '';
    const text = buildCaption(message, channelTitle, prefix);
    const mediaType = getMediaType(message);

    return { text, filePath, mediaType };
}

module.exports = { buildPayload };
