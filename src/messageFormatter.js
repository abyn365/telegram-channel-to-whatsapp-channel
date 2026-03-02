import {
    extractText,
    extractWebPageUrl,
    getMediaType,
    getMediaMetadata,
    getPollText,
    getLocationText,
    getContactText,
} from './telegramClient.js';

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

// Maximum caption length for WhatsApp (1024 characters)
const MAX_CAPTION_LENGTH = parseInt(process.env.MAX_CAPTION_LENGTH, 10) || 1024;

// Truncate text to fit within limits while preserving important content
function truncateText(text, maxLength = MAX_CAPTION_LENGTH) {
    if (!text || text.length <= maxLength) return text;
    
    // Try to truncate at a word boundary
    const truncated = text.substring(0, maxLength - 3);
    const lastSpace = truncated.lastIndexOf(' ');
    
    if (lastSpace > maxLength * 0.7) {
        return truncated.substring(0, lastSpace) + '...';
    }
    
    return truncated + '...';
}

// Clean text for WhatsApp - remove problematic characters
function cleanTextForWhatsApp(text) {
    if (!text) return '';
    
    return text
        // Remove null characters
        .replace(/\0/g, '')
        // Remove other control characters except newlines and tabs
        .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Normalize whitespace
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // Remove excessive newlines (max 2 consecutive)
        .replace(/\n{3,}/g, '\n\n')
        // Trim whitespace from each line
        .split('\n')
        .map(line => line.trim())
        .join('\n')
        .trim();
}

function buildCaption(message, channelTitle, prefix, senderInfo) {
    const includeQuote = process.env.INCLUDE_QUOTE !== 'false';
    const mediaType = getMediaType(message);
    const rawText = extractText(message);
    const webUrl = extractWebPageUrl(message);
    const parts = [];

    // Add prefix if configured
    if (prefix) {
        const cleanPrefix = cleanTextForWhatsApp(prefix);
        if (cleanPrefix) parts.push(cleanPrefix);
    }

    // Add channel header with emoji
    const emoji = MEDIA_EMOJI[mediaType] || '📩';
    if (channelTitle) {
        // Escape markdown special characters in title
        const escapedTitle = channelTitle.replace(/([*_~`])/g, '\\$1');
        parts.push(`${emoji} *${escapedTitle}*`);
    }

    // Add the main text/caption from Telegram
    const cleanedRawText = cleanTextForWhatsApp(rawText);
    if (cleanedRawText) {
        parts.push(cleanedRawText);
    }

    // Add formatted content for special types
    if (mediaType === 'poll') {
        parts.push(getPollText(message));
    } else if (mediaType === 'location') {
        parts.push(getLocationText(message));
    } else if (mediaType === 'contact') {
        parts.push(getContactText(message));
    }

    // Add webpage URL if present
    if (webUrl) {
        parts.push(`🔗 ${webUrl}`);
    }

    const body = parts.filter(Boolean).join('\n\n');

    if (!includeQuote) {
        return truncateText(body);
    }

    // Add quote block with metadata
    const quoteParts = [];
    if (channelTitle) quoteParts.push(`Channel: ${channelTitle}`);
    if (senderInfo?.name) quoteParts.push(`Author: ${senderInfo.name}`);
    if (senderInfo?.username) quoteParts.push(`@${senderInfo.username}`);

    if (quoteParts.length > 0) {
        const fullText = `${body}\n\n> ${quoteParts.join(' | ')}`;
        return truncateText(fullText);
    }

    return truncateText(body);
}

// Build caption specifically for media (optimized for viewability)
function buildMediaCaption(message, channelTitle, senderInfo) {
    const rawText = extractText(message);
    const cleanedText = cleanTextForWhatsApp(rawText);
    
    // For media, we want a cleaner caption without too much metadata
    const parts = [];
    
    if (cleanedText) {
        parts.push(cleanedText);
    }
    
    // Add author if available
    if (senderInfo?.name) {
        parts.push(`— ${senderInfo.name}`);
    }
    
    return truncateText(parts.join('\n\n'), MAX_CAPTION_LENGTH);
}

function buildPayload(message, filePath, channelTitle, senderInfo, sourceLink = null) {
    const prefix = process.env.MESSAGE_PREFIX || '';
    const text = buildCaption(message, channelTitle, prefix, senderInfo);
    const mediaType = getMediaType(message);
    const rawText = extractText(message);
    const mediaMetadata = getMediaMetadata(message);
    
    return { 
        text, 
        filePath, 
        mediaType, 
        rawText,
        metadata: mediaMetadata,
        sourceLink,
    };
}

// Build a text-only representation for messages that couldn't be forwarded with media
function buildFallbackText(message, channelTitle, senderInfo, sourceLink, error) {
    const parts = [];
    
    const rawText = extractText(message);
    if (rawText) {
        parts.push(cleanTextForWhatsApp(rawText));
    }
    
    if (error) {
        parts.push(`⚠️ Media could not be forwarded: ${error}`);
    }
    
    if (sourceLink) {
        parts.push(`🔗 View original: ${sourceLink}`);
    }
    
    if (channelTitle || senderInfo?.name) {
        const metaParts = [];
        if (channelTitle) metaParts.push(channelTitle);
        if (senderInfo?.name) metaParts.push(`by ${senderInfo.name}`);
        parts.push(`(${metaParts.join(' ')})`);
    }
    
    return parts.filter(Boolean).join('\n\n');
}

export { 
    buildPayload, 
    buildCaption, 
    buildMediaCaption, 
    buildFallbackText,
    truncateText, 
    cleanTextForWhatsApp,
    MAX_CAPTION_LENGTH 
};
