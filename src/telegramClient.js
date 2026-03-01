const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram');
const readline = require('readline');
const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

const SESSION_FILE = path.join(__dirname, '../sessions/telegram.session');

async function promptInput(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function loadSession() {
    try {
        if (await fs.pathExists(SESSION_FILE)) {
            const data = await fs.readFile(SESSION_FILE, 'utf-8');
            return new StringSession(data.trim());
        }
    } catch {
        // ignore
    }
    return new StringSession('');
}

async function saveSession(client) {
    const sessionStr = client.session.save();
    await fs.ensureDir(path.dirname(SESSION_FILE));
    await fs.writeFile(SESSION_FILE, sessionStr, 'utf-8');
    logger.info('Telegram session saved.');
}

async function createTelegramClient() {
    const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
    const apiHash = process.env.TELEGRAM_API_HASH;
    const phone = process.env.TELEGRAM_PHONE;

    if (!apiId || !apiHash || !phone) {
        throw new Error('TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_PHONE must be set in .env');
    }

    const session = await loadSession();
    const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        retryDelay: 3000,
        autoReconnect: true,
        useWSS: false,
    });

    await client.start({
        phoneNumber: async () => phone,
        password: async () => promptInput('Enter your Telegram 2FA password: '),
        phoneCode: async () => promptInput('Enter the Telegram verification code: '),
        onError: (err) => logger.error('Telegram auth error:', err),
    });

    await saveSession(client);
    logger.info('Telegram userbot connected successfully.');
    return client;
}

function resolveChannelTargets(raw) {
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

async function resolveChannelEntities(client, channels) {
    const channelEntities = [];
    const channelTitles = {};

    for (const raw of channels) {
        if (!raw) continue;
        try {
            const entity = await client.getEntity(raw);
            if (!entity) {
                logger.warn(`Could not resolve Telegram channel: ${raw}`);
                continue;
            }

            channelEntities.push(entity);

            const title = entity.title || entity.username || String(entity.id);
            channelTitles[raw] = title;

            if (entity.username) {
                channelTitles[entity.username] = title;
                channelTitles[`@${entity.username}`] = title;
            }

            if (entity.id) {
                const idValue = String(entity.id);
                channelTitles[idValue] = title;
                channelTitles[`-100${idValue}`] = title;
            }
        } catch (err) {
            logger.warn(`Failed to resolve Telegram channel "${raw}": ${err.message || err}`);
        }
    }

    if (channelEntities.length === 0) {
        throw new Error('No Telegram channels could be resolved. Check TELEGRAM_CHANNELS in .env.');
    }

    return { channelEntities, channelTitles };
}

async function downloadMedia(client, message, tempDir) {
    const maxBytes = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 50) * 1024 * 1024;
    let media = message.media;
    if (!media) return null;

    try {
        let fileSize = 0;
        let fileName = 'media_file';
        let ext = '';

        if (media.photo) {
            ext = '.jpg';
            fileName = `photo_${message.id}${ext}`;
        } else if (media.document) {
            const doc = media.document;
            fileSize = doc.size || 0;
            if (fileSize > maxBytes) {
                logger.warn(`Skipping file — size ${fileSize} exceeds limit.`);
                return null;
            }
            const nameAttr = doc.attributes?.find((a) => a.fileName);
            const rawName = nameAttr?.fileName || `document_${message.id}`;
            fileName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
            if (!path.extname(fileName)) {
                const mime = doc.mimeType || '';
                const mimeExt = require('mime-types').extension(mime);
                if (mimeExt) fileName += `.${mimeExt}`;
            }
        } else if (media.webpage) {
            return null;
        } else {
            return null;
        }

        await fs.ensureDir(tempDir);
        const destPath = path.join(tempDir, fileName);
        logger.info(`Downloading media: ${fileName}`);

        const buffer = await client.downloadMedia(message, { workers: 4 });
        if (!buffer || buffer.length === 0) return null;

        await fs.writeFile(destPath, buffer);
        logger.info(`Media saved to ${destPath}`);
        return destPath;
    } catch (err) {
        logger.error('Failed to download media:', err);
        return null;
    }
}

function extractText(message) {
    return message.message || '';
}

function extractWebPageUrl(message) {
    if (message.media?.webpage) {
        return message.media.webpage.url || null;
    }
    return null;
}

function getMediaType(message) {
    const media = message.media;
    if (!media) return 'text';
    if (media.photo) return 'photo';
    if (media.document) {
        const mime = media.document.mimeType || '';
        if (mime.startsWith('video/')) return 'video';
        if (mime.startsWith('audio/')) return 'audio';
        if (mime === 'image/gif' || media.document.attributes?.find((a) => a.className === 'DocumentAttributeAnimated')) return 'gif';
        if (media.document.attributes?.find((a) => a.className === 'DocumentAttributeSticker')) return 'sticker';
        if (mime.startsWith('image/')) return 'image';
        return 'document';
    }
    if (media.webpage) return 'webpage';
    if (media.poll) return 'poll';
    if (media.geo || media.geoLive) return 'location';
    if (media.contact) return 'contact';
    return 'unknown';
}

function getPollText(message) {
    const poll = message.media?.poll;
    if (!poll) return '';
    const question = poll.question?.text || poll.question || 'Poll';
    const answers = (poll.answers || []).map((a, i) => `  ${i + 1}. ${a.text?.text || a.text}`).join('\n');
    return `📊 *Poll: ${question}*\n${answers}`;
}

function getLocationText(message) {
    const geo = message.media?.geo || message.media?.geoLive?.geo;
    if (!geo) return '';
    return `📍 Location: https://maps.google.com/?q=${geo.lat},${geo.long}`;
}

function getContactText(message) {
    const c = message.media?.contact;
    if (!c) return '';
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
    const phone = c.phoneNumber || '';
    return `👤 Contact: ${name}${phone ? ` — ${phone}` : ''}`;
}

function extractSenderInfo(message, client) {
    const info = {
        name: null,
        phone: null,
    };

    if (message.postAuthor) {
        info.name = message.postAuthor;
    }

    if (message.fromId) {
        const fromIdStr = String(message.fromId);
        if (fromIdStr.startsWith('user')) {
            const userId = fromIdStr.replace('user', '');
            info.phone = userId;
        }
    }

    return info;
}

function getSenderName(client, fromId) {
    if (!fromId) return null;
    
    try {
        const entity = client.getEntity(fromId);
        if (entity) {
            if (entity.firstName) {
                const fullName = [entity.firstName, entity.lastName].filter(Boolean).join(' ');
                return fullName || entity.username || null;
            }
            return entity.username || null;
        }
    } catch {
        // ignore
    }
    return null;
}

function startListener(client, channels, onMessage) {
    client.addEventHandler(async (event) => {
        try {
            const msg = event.message;
            if (!msg) return;
            await onMessage(msg);
        } catch (err) {
            logger.error('Error handling Telegram message event:', err);
        }
    }, new NewMessage({ chats: channels }));

    const channelLabels = channels.map((channel) => {
        if (typeof channel === 'string') return channel;
        if (channel?.title) return channel.title;
        if (channel?.username) return `@${channel.username}`;
        if (channel?.id) return String(channel.id);
        return 'unknown';
    });

    logger.info(`Listening on Telegram channels: ${channelLabels.join(', ')}`);
}

module.exports = {
    createTelegramClient,
    resolveChannelTargets,
    resolveChannelEntities,
    downloadMedia,
    extractText,
    extractWebPageUrl,
    getMediaType,
    getPollText,
    getLocationText,
    getContactText,
    extractSenderInfo,
    getSenderName,
    startListener,
};
