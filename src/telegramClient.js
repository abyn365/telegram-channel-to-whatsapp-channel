import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Api } from 'telegram';
import readline from 'readline';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import mime from 'mime-types';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSIONS_DIR = path.join(__dirname, '../sessions');

// Track download progress for large files
const downloadProgressCallbacks = new Map();

async function promptInput(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function buildSessionFile(accountIndex = 0) {
    return path.join(SESSIONS_DIR, `telegram.${accountIndex}.session`);
}

async function loadSession(sessionFile) {
    try {
        if (await fs.pathExists(sessionFile)) {
            const data = await fs.readFile(sessionFile, 'utf-8');
            return new StringSession(data.trim());
        }
    } catch {}
    return new StringSession('');
}

async function saveSession(client, sessionFile) {
    const sessionStr = client.session.save();
    await fs.ensureDir(path.dirname(sessionFile));
    await fs.writeFile(sessionFile, sessionStr, 'utf-8');
    logger.info(`Telegram session saved (${path.basename(sessionFile)}).`);
}


function parseTelegramAccountsJson(rawJson) {
    const trimmed = String(rawJson || '').trim();
    if (!trimmed) return null;

    try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
            throw new Error('must be a JSON array');
        }
        return parsed;
    } catch (err) {
        return { error: err };
    }
}

function getTelegramAccountConfigs() {
    const parsedJson = parseTelegramAccountsJson(process.env.TELEGRAM_ACCOUNTS_JSON);
    if (parsedJson && !parsedJson.error) {
        const configs = parsedJson
            .map((cfg) => ({
                apiId: parseInt(cfg?.apiId, 10),
                apiHash: String(cfg?.apiHash || '').trim(),
                phone: String(cfg?.phone || '').trim(),
            }))
            .filter((cfg) => cfg.apiId && cfg.apiHash && cfg.phone);

        if (configs.length > 0) {
            return configs;
        }

        logger.warn('TELEGRAM_ACCOUNTS_JSON was provided but has no valid entries. Falling back to legacy env variables if available.');
    }

    if (parsedJson?.error) {
        logger.warn(`Invalid TELEGRAM_ACCOUNTS_JSON (${parsedJson.error.message}). Falling back to legacy TELEGRAM_API_ID/HASH/PHONE values if available.`);
    }

    const ids = String(process.env.TELEGRAM_API_ID || '').split(',').map((v) => v.trim()).filter(Boolean);
    const hashes = String(process.env.TELEGRAM_API_HASH || '').split(',').map((v) => v.trim()).filter(Boolean);
    const phones = String(process.env.TELEGRAM_PHONE || '').split(',').map((v) => v.trim()).filter(Boolean);

    const count = Math.max(ids.length, hashes.length, phones.length);
    const configs = [];
    for (let i = 0; i < count; i++) {
        configs.push({ apiId: parseInt(ids[i], 10), apiHash: hashes[i], phone: phones[i] });
    }

    const valid = configs.filter((cfg) => cfg.apiId && cfg.apiHash && cfg.phone);
    if (valid.length > 0) {
        logger.warn('Using legacy TELEGRAM_API_ID/TELEGRAM_API_HASH/TELEGRAM_PHONE format. Prefer TELEGRAM_ACCOUNTS_JSON.');
    }
    return valid;
}

async function createTelegramClient(accountConfig, accountIndex = 0) {
    const apiId = parseInt(accountConfig.apiId, 10);
    const apiHash = accountConfig.apiHash;
    const phone = accountConfig.phone;

    if (!apiId || !apiHash || !phone) {
        throw new Error('Telegram account config missing apiId/apiHash/phone');
    }

    const sessionFile = buildSessionFile(accountIndex);
    const session = await loadSession(sessionFile);
    const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 10,
        retryDelay: 3000,
        autoReconnect: true,
        useWSS: false,
        requestRetries: 5,
        downloadRetries: 3,
    });

    await client.start({
        phoneNumber: async () => phone,
        password: async () => promptInput('Enter your Telegram 2FA password: '),
        phoneCode: async () => promptInput('Enter the Telegram verification code: '),
        onError: (err) => logger.error('Telegram auth error:', err),
    });

    await saveSession(client, sessionFile);
    logger.info('Telegram userbot connected successfully.');
    
    // Log some info about the connected user
    try {
        const me = await client.getMe();
        logger.info(`Logged in as: ${me.firstName || ''} ${me.lastName || ''} (@${me.username || 'N/A'})`);
    } catch {
        // ignore
    }
    
    return client;
}

async function createTelegramClients() {
    const configs = getTelegramAccountConfigs();
    if (configs.length === 0) {
        throw new Error('No valid Telegram account configs found.');
    }

    const clients = [];
    for (let i = 0; i < configs.length; i++) {
        clients.push(await createTelegramClient(configs[i], i));
    }
    return clients;
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
            
            logger.debug(`Resolved channel "${raw}" -> "${title}" (ID: ${entity.id})`);
        } catch (err) {
            logger.warn(`Failed to resolve Telegram channel "${raw}": ${err.message || err}`);
        }
    }

    if (channelEntities.length === 0) {
        throw new Error('No Telegram channels could be resolved. Check TELEGRAM_CHANNELS in .env.');
    }

    return { channelEntities, channelTitles };
}

// Improved media download with better error handling and progress logging
async function downloadMedia(client, message, tempDir) {
    const maxBytes = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 50) * 1024 * 1024;
    const downloadTimeout = parseInt(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS, 10) || 300000; // 5 minutes default
    let media = message.media;
    if (!media) return null;

    try {
        let fileSize = 0;
        let fileName = 'media_file';
        let ext = '';
        let mimeType = 'application/octet-stream';

        if (media.photo) {
            // Photos - determine best size to download
            ext = '.jpg';
            fileName = `photo_${message.id}${ext}`;
            mimeType = 'image/jpeg';
        } else if (media.document) {
            const doc = media.document;
            fileSize = doc.size || 0;
            
            if (fileSize > maxBytes) {
                logger.warn(`Skipping file — size ${(fileSize / 1024 / 1024).toFixed(2)} MB exceeds limit of ${maxBytes / 1024 / 1024} MB`);
                return null;
            }
            
            mimeType = doc.mimeType || 'application/octet-stream';
            
            // Try to get filename from document attributes
            const nameAttr = doc.attributes?.find((a) => a.fileName);
            const rawName = nameAttr?.fileName || `document_${message.id}`;
            
            // Sanitize filename but preserve extension
            const parsedPath = path.parse(rawName);
            const sanitizedName = parsedPath.name.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
            ext = parsedPath.ext || '';
            
            // Determine extension from MIME type if not present
            if (!ext) {
                const mimeExt = mime.extension(mimeType);
                if (mimeExt) ext = `.${mimeExt}`;
            }
            
            fileName = `${sanitizedName}${ext}`;
            
            // Log document info
            logger.debug(`Document: ${fileName}, MIME: ${mimeType}, Size: ${(fileSize / 1024).toFixed(2)} KB`);
        } else if (media.webpage) {
            // Webpage previews - don't download
            return null;
        } else {
            return null;
        }

        await fs.ensureDir(tempDir);
        const destPath = path.join(tempDir, fileName);
        
        // Check if file already exists (from grouped media)
        if (await fs.pathExists(destPath)) {
            const existingStat = await fs.stat(destPath);
            if (existingStat.size > 0) {
                logger.debug(`Media file already exists: ${destPath}`);
                return destPath;
            }
        }

        logger.info(`Downloading media: ${fileName} (${fileSize > 0 ? `${(fileSize / 1024 / 1024).toFixed(2)} MB` : 'unknown size'})`);

        // Download with progress callback for large files
        const downloadStartTime = Date.now();
        
        const downloadPromise = client.downloadMedia(message, { 
            workers: 4,
            progressCallback: (downloaded, total) => {
                if (total > 0 && total > 5 * 1024 * 1024) { // Log progress for files > 5MB
                    const percent = ((downloaded / total) * 100).toFixed(1);
                    const elapsed = (Date.now() - downloadStartTime) / 1000;
                    const speed = elapsed > 0 ? (downloaded / 1024 / 1024 / elapsed).toFixed(2) : 0;
                    logger.debug(`Download progress: ${percent}% (${speed} MB/s)`);
                }
            }
        });
        
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Media download timeout after ${downloadTimeout / 1000} seconds`)), downloadTimeout);
        });

        const buffer = await Promise.race([downloadPromise, timeoutPromise]);

        if (!buffer || buffer.length === 0) {
            logger.warn(`Downloaded media buffer is empty for message ${message.id}`);
            return null;
        }

        await fs.writeFile(destPath, buffer);
        const elapsed = ((Date.now() - downloadStartTime) / 1000).toFixed(2);
        logger.info(`Media saved: ${destPath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB in ${elapsed}s)`);
        
        return destPath;
    } catch (err) {
        logger.error(`Failed to download media for message ${message.id}:`, err.message || err);
        return null;
    }
}

// Get media metadata for better handling
function getMediaMetadata(message) {
    const media = message.media;
    if (!media) return null;
    
    const metadata = {
        type: getMediaType(message),
        mimeType: null,
        fileName: null,
        fileSize: null,
        width: null,
        height: null,
        duration: null,
    };
    
    if (media.document) {
        const doc = media.document;
        metadata.mimeType = doc.mimeType || 'application/octet-stream';
        metadata.fileSize = doc.size || 0;
        
        // Try to get filename
        const nameAttr = doc.attributes?.find((a) => a.fileName);
        if (nameAttr) metadata.fileName = nameAttr.fileName;
        
        // Get dimensions for images/videos
        const videoAttr = doc.attributes?.find((a) => a.className === 'DocumentAttributeVideo');
        const imageAttr = doc.attributes?.find((a) => a.className === 'DocumentAttributeImageSize');
        
        if (videoAttr) {
            metadata.width = videoAttr.w || null;
            metadata.height = videoAttr.h || null;
            metadata.duration = videoAttr.duration || null;
        } else if (imageAttr) {
            metadata.width = imageAttr.w || null;
            metadata.height = imageAttr.h || null;
        }
    } else if (media.photo) {
        metadata.mimeType = 'image/jpeg';
        metadata.type = 'photo';
    }
    
    return metadata;
}


async function buildTelegramMessageLink(client, message) {
    const msgId = message?.id;
    if (!msgId) return null;

    try {
        const chatEntity = message.chat || (message.peerId ? await client.getEntity(message.peerId) : null);
        if (chatEntity?.username) {
            return `https://t.me/${chatEntity.username}/${msgId}`;
        }

        const rawChannelId = message.peerId?.channelId || chatEntity?.id;
        if (rawChannelId) {
            const id = String(rawChannelId).replace(/^-100/, '');
            return `https://t.me/c/${id}/${msgId}`;
        }
    } catch {
        // ignore link build failures
    }

    return null;
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
        username: null,
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

    // Try to get sender from forward info
    if (message.forward) {
        if (message.forward.sender) {
            info.name = message.forward.sender.title || message.forward.sender.username || info.name;
        } else if (message.forward.fromName) {
            info.name = message.forward.fromName;
        }
    }

    return info;
}

async function getSenderName(client, fromId) {
    if (!fromId) return null;

    try {
        const entity = await client.getEntity(fromId);
        if (entity) {
            if (entity.firstName) {
                const fullName = [entity.firstName, entity.lastName].filter(Boolean).join(' ');
                return fullName || entity.username || null;
            }
            return entity.username || entity.title || null;
        }
    } catch {
        // ignore
    }
    return null;
}

function startListener(client, channelFilters, onMessage, channelLabels = channelFilters) {
    const allowedChatIds = new Set(
        (channelFilters || [])
            .map((channel) => {
                if (typeof channel === 'string') return channel.replace(/^@/, '');
                if (channel?.username) return String(channel.username).replace(/^@/, '');
                if (channel?.id) return String(channel.id);
                return String(channel || '');
            })
            .filter(Boolean)
    );

    client.addEventHandler(async (event) => {
        try {
            const msg = event.message;
            if (!msg) return;

            const peerId = String(msg.peerId?.channelId || msg.peerId?.chatId || msg.peerId?.userId || '');
            const peerIdWithPrefix = peerId ? `-100${peerId}` : '';
            const peerUsername = String(msg.chat?.username || msg.chat?.title || '').replace(/^@/, '');

            const isAllowed =
                !allowedChatIds.size ||
                allowedChatIds.has(peerId) ||
                allowedChatIds.has(peerIdWithPrefix) ||
                allowedChatIds.has(peerUsername);

            if (!isAllowed) {
                return;
            }

            await onMessage(msg);
        } catch (err) {
            logger.error('Error handling Telegram message event:', err);
        }
    }, new NewMessage({}));

    const labels = (channelLabels || []).map((channel) => {
        if (typeof channel === 'string') return channel;
        if (channel?.title) return channel.title;
        if (channel?.username) return `@${channel.username}`;
        if (channel?.id) return String(channel.id);
        return 'unknown';
    });

    logger.info(`Listening on Telegram channels: ${labels.join(', ')}`);
}


function startPollingChannels(client, channelFilters, onMessage) {
    const pollingEnabled = String(process.env.TELEGRAM_POLLING_ENABLED || 'true').toLowerCase() !== 'false';
    if (!pollingEnabled) {
        logger.info('Telegram polling fallback is disabled (TELEGRAM_POLLING_ENABLED=false).');
        return () => {};
    }

    const intervalMs = Math.max(parseInt(process.env.TELEGRAM_POLL_INTERVAL_MS, 10) || 15000, 5000);
    const entities = (channelFilters || []).filter(Boolean);
    const lastSeenByChannel = new Map();
    let stopped = false;

    const pollOnce = async () => {
        if (stopped) return;

        for (const entity of entities) {
            try {
                const history = await client.getMessages(entity, { limit: 10 });
                if (!history || history.length === 0) continue;

                const channelKey = String(entity?.id || entity?.username || entity);
                const knownMax = lastSeenByChannel.get(channelKey) || 0;
                let latestSeen = knownMax;

                const sortedAsc = [...history].sort((a, b) => (a.id || 0) - (b.id || 0));
                for (const msg of sortedAsc) {
                    if (!msg?.id) continue;
                    latestSeen = Math.max(latestSeen, msg.id);

                    if (knownMax > 0 && msg.id <= knownMax) continue;
                    if (msg.out) continue;

                    await onMessage(msg);
                }

                if (latestSeen > 0) {
                    lastSeenByChannel.set(channelKey, latestSeen);
                }
            } catch (err) {
                logger.warn(`Polling failed for Telegram channel ${entity?.title || entity?.username || entity}: ${err.message || err}`);
            }
        }
    };

    const timer = setInterval(() => {
        pollOnce().catch((err) => {
            logger.warn(`Telegram polling cycle failed: ${err.message || err}`);
        });
    }, intervalMs);

    pollOnce().catch((err) => {
        logger.warn(`Initial Telegram polling failed: ${err.message || err}`);
    });

    logger.info(`Telegram polling fallback enabled every ${intervalMs} ms.`);

    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

export {
    createTelegramClient,
    createTelegramClients,
    resolveChannelTargets,
    resolveChannelEntities,
    downloadMedia,
    extractText,
    extractWebPageUrl,
    getMediaType,
    getMediaMetadata,
    getPollText,
    getLocationText,
    getContactText,
    extractSenderInfo,
    getSenderName,
    buildTelegramMessageLink,
    startListener,
    startPollingChannels,
};
