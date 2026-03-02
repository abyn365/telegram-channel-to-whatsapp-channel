import makeWASocket from '@whiskeysockets/baileys';
import { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs-extra';
import mime from 'mime-types';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import logger from './logger.js';

// Configuration for video handling
const VIDEO_UPLOAD_RETRIES = parseInt(process.env.VIDEO_UPLOAD_RETRIES, 10) || 2;
const VIDEO_UPLOAD_RETRY_DELAY_MS = parseInt(process.env.VIDEO_UPLOAD_RETRY_DELAY_MS, 10) || 3000;
const VIDEO_DDL_FALLBACK = String(process.env.VIDEO_DDL_FALLBACK || 'true').toLowerCase() === 'true';
const MAX_VIDEO_SIZE_MB = parseInt(process.env.MAX_VIDEO_SIZE_MB, 10) || 16;
const WHATSAPP_SEND_SOURCE_LINK = String(process.env.WHATSAPP_SEND_SOURCE_LINK || 'true').toLowerCase() === 'true';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let _isConnected = false;
let _reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

const SESSION_DIR = path.join(__dirname, '../sessions/baileys');

// Cache for resolved newsletter JIDs
const newsletterJidCache = new Map();

// Media types that WhatsApp channels/newsletters support
const NEWSLETTER_SUPPORTED_MEDIA = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/3gpp', 'video/quicktime', 'video/webm',
]);

function normalizeWhatsAppId(targetId) {
    if (!targetId) return targetId;

    const sanitized = String(targetId).trim().replace(/^['"]+|['"]+$/g, '');
    if (!sanitized) return sanitized;

    if (/@newsletter$/i.test(sanitized)) {
        return sanitized;
    }

    if (sanitized.includes('@')) {
        return sanitized;
    }

    const channelUrlMatch = sanitized.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/i);
    if (channelUrlMatch) {
        return `${channelUrlMatch[1]}@newsletter`;
    }

    if (/^120\d{10,}$/.test(sanitized)) {
        return `${sanitized}@g.us`;
    }

    if (/^[a-zA-Z0-9_-]{15,}$/.test(sanitized) && !sanitized.includes('@')) {
        return `${sanitized}@newsletter`;
    }

    return sanitized;
}

function extractInviteCode(targetId) {
    if (!targetId) return null;

    const sanitized = String(targetId).trim();
    const urlMatch = sanitized.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/i);
    if (urlMatch) return urlMatch[1];

    if (/^[a-zA-Z0-9_-]{15,}$/.test(sanitized) && !sanitized.includes('@')) {
        return sanitized;
    }

    if (/@newsletter$/i.test(sanitized)) {
        return sanitized.replace(/@newsletter$/i, '');
    }

    return null;
}

// Check if media type is supported by WhatsApp newsletters
function isNewsletterSupportedMedia(mimeType) {
    if (!mimeType) return false;
    const normalized = mimeType.toLowerCase();
    if (normalized.startsWith('image/')) return true;
    if (normalized.startsWith('video/')) return true;
    return false;
}

async function generateThumbnail(buffer, mimeType) {
    try {
        if (!mimeType?.startsWith('image/')) return null;

        const thumbnailBuffer = await sharp(buffer)
            .resize(100, 100, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 40 })
            .toBuffer();

        return thumbnailBuffer;
    } catch (err) {
        logger.debug(`Could not generate thumbnail: ${err.message}`);
        return null;
    }
}

async function createWhatsAppClient(onReconnect) {
    await fs.ensureDir(SESSION_DIR);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    logger.info(`Using Baileys v${version.join('.')} (WebSocket-based, no Chrome required)`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('TG-WA Forwarder'),
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
        fireInitQueries: true,
        shouldIgnoreJid: (jid) => false,
    });

    sock.ev.on('creds.update', saveCreds);

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('WhatsApp connection timed out after 5 minutes'));
        }, 300_000);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                logger.info('WhatsApp QR code — scan with your phone:');
                qrcode.generate(qr, { small: true });
                logger.info('(Open WhatsApp → Linked Devices → Link a Device → scan QR)');
            }

            if (connection === 'open') {
                clearTimeout(timeout);
                _isConnected = true;
                _reconnectAttempts = 0;
                logger.info('WhatsApp connected successfully via Baileys (WebSocket).');
                resolve();
            }

            if (connection === 'close') {
                _isConnected = false;
                const statusCode = lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output?.statusCode
                    : null;
                const loggedOut = statusCode === DisconnectReason.loggedOut;

                if (loggedOut) {
                    clearTimeout(timeout);
                    logger.error('WhatsApp session logged out. Delete sessions/baileys/ and restart to re-authenticate.');
                    const error = new Error('WhatsApp logged out');
                    error.isLoggedOut = true;
                    reject(error);
                    return;
                }

                if (!_isConnected) {
                    clearTimeout(timeout);
                    logger.warn(`WhatsApp connection closed during init (code ${statusCode}). Retrying...`);
                    const error = new Error(`WhatsApp connection closed: ${statusCode}`);
                    error.statusCode = statusCode;
                    reject(error);
                    return;
                }

                logger.warn(`WhatsApp disconnected (code ${statusCode}). Will reconnect...`);
                if (typeof onReconnect === 'function') {
                    onReconnect();
                }
            }
        });

        sock.ev.on('auth-state-update', () => {
            saveCreds().catch(() => {});
        });
    });

    return sock;
}

async function createWhatsAppClientWithReconnect() {
    let sock = null;
    let resolveReady;
    let rejectReady;
    let isReady = false;
    const readyPromise = new Promise((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
    });

    const scheduleReconnect = async (reason) => {
        _reconnectAttempts++;
        if (_reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            logger.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Exiting.`);
            process.exit(1);
        }
        const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts), 60_000);
        if (reason) {
            logger.warn(`WhatsApp connection failed (${reason}). Reconnecting in ${delay / 1000}s (attempt ${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        } else {
            logger.info(`Reconnecting WhatsApp in ${delay / 1000}s (attempt ${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        }
        await sleep(delay);
        await connect();
    };

    const connect = async () => {
        try {
            sock = await createWhatsAppClient(async () => {
                await scheduleReconnect('disconnected');
            });
            _reconnectAttempts = 0;
            if (!isReady) {
                isReady = true;
                resolveReady(sock);
            }
        } catch (err) {
            if (err?.isLoggedOut) {
                if (!isReady) {
                    rejectReady(err);
                }
                return;
            }
            const reason = err?.message || 'unknown error';
            await scheduleReconnect(reason);
        }
    };

    await connect();
    return readyPromise;
}

async function resolveNewsletterJid(sock, targetId) {
    const normalizedId = normalizeWhatsAppId(targetId);
    if (!/@newsletter$/i.test(normalizedId)) return normalizedId;

    if (newsletterJidCache.has(normalizedId)) {
        return newsletterJidCache.get(normalizedId);
    }

    const inviteCode = extractInviteCode(targetId);
    if (!inviteCode) return normalizedId;

    if (typeof sock.newsletterMetadata !== 'function') {
        logger.debug(`newsletterMetadata not available, using normalized ID: ${normalizedId}`);
        return normalizedId;
    }

    try {
        const metadata = await sock.newsletterMetadata('invite', inviteCode);
        if (metadata?.id) {
            const jid = metadata.id.includes('@newsletter') ? metadata.id : `${metadata.id}@newsletter`;
            logger.info(`Resolved newsletter "${metadata.name || inviteCode}" → ${jid}`);
            newsletterJidCache.set(normalizedId, jid);
            return jid;
        }
    } catch (err) {
        if (err.message?.includes('GraphQL')) {
            logger.debug(`GraphQL error when resolving newsletter ${inviteCode}: ${err.message}`);
        } else {
            logger.debug(`Could not resolve newsletter invite code ${inviteCode}: ${err.message}`);
        }
    }

    return normalizedId;
}

function assertWhatsAppSendResult(result, jid, contextLabel) {
    const messageId = result?.key?.id || result?.key?.remoteJid || result?.status;

    if (!messageId && !result) {
        throw new Error(`WhatsApp returned an empty send result for ${contextLabel} -> ${jid}`);
    }

    const status = result?.status;
    if (status === 'error' || status === 'failed') {
        throw new Error(`WhatsApp send failed with status: ${status} for ${contextLabel} -> ${jid}`);
    }

    if (/@newsletter$/i.test(jid)) {
        logger.info(`Newsletter message sent successfully: ${messageId || 'pending'} (${contextLabel})`);
    } else {
        logger.debug(`WhatsApp message sent: ${messageId || 'pending'} (${contextLabel})`);
    }
}

async function sendText(sock, targetId, text) {
    if (!text || !text.trim()) return;
    const jid = await resolveNewsletterJid(sock, targetId);
    const result = await sock.sendMessage(jid, { text });
    assertWhatsAppSendResult(result, jid, 'text');
}

// ============================================================
// FIXED: Send image or video to newsletter
// Root cause: Baileys newsletter requires media to be uploaded
// via the correct method with proper content-type and fields.
// Missing: fileLength, seconds (video), proper thumbnail base64.
// ============================================================
async function sendImageOrVideoToNewsletter(sock, jid, fileBuffer, mimeType, caption, filename = 'media', sourceLink = null) {
    const isGif = mimeType === 'image/gif' || (mimeType === 'video/mp4' && filename.endsWith('.gif'));
    const isVideo = mimeType.startsWith('video/') || isGif;
    const isImage = mimeType.startsWith('image/') && !isGif;
    const fileSizeMB = fileBuffer.length / (1024 * 1024);

    logger.info(`Sending ${isImage ? 'image' : 'video'} to newsletter ${jid} (${mimeType}, ${fileSizeMB.toFixed(2)} MB)`);

    if (isVideo && fileSizeMB > MAX_VIDEO_SIZE_MB) {
        logger.warn(`Video file size (${fileSizeMB.toFixed(2)} MB) exceeds limit (${MAX_VIDEO_SIZE_MB} MB), may fail to upload`);
    }

    // Generate thumbnail for images
    let jpegThumbnail = null;
    if (isImage) {
        try {
            jpegThumbnail = await sharp(fileBuffer)
                .resize(100, 100, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 40 })
                .toBuffer();
        } catch (e) {
            logger.debug(`Thumbnail generation failed: ${e.message}`);
        }
    }

    // Build message content
    // KEY FIX: For newsletters, Baileys needs these exact fields to properly
    // publish the media. Without fileLength/mediaType set correctly, the server
    // accepts the upload but doesn't render it in the channel feed.
    let messageContent;

    if (isImage) {
        messageContent = {
            image: fileBuffer,
            mimetype: mimeType,
            fileLength: fileBuffer.length,
            ...(jpegThumbnail ? { jpegThumbnail } : {}),
        };
    } else {
        // Video / GIF
        const videoMime = isGif ? 'video/mp4' : mimeType;
        messageContent = {
            video: fileBuffer,
            mimetype: videoMime,
            fileLength: fileBuffer.length,
            gifPlayback: isGif,
            ...(jpegThumbnail ? { jpegThumbnail } : {}),
        };
    }

    let lastError = null;
    const maxRetries = isVideo ? VIDEO_UPLOAD_RETRIES : 1;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 1) {
                logger.info(`Retrying ${isVideo ? 'video' : 'image'} upload (attempt ${attempt}/${maxRetries})...`);
                await sleep(VIDEO_UPLOAD_RETRY_DELAY_MS * (attempt - 1));
            }

            const result = await sock.sendMessage(jid, messageContent);
            assertWhatsAppSendResult(result, jid, isImage ? 'image' : 'video');

            // Send caption + optional source link as separate text message
            const captionParts = [];
            if (caption && caption.trim()) captionParts.push(caption.trim());
            if (WHATSAPP_SEND_SOURCE_LINK && sourceLink) captionParts.push(`🔗 ${sourceLink}`);

            if (captionParts.length > 0) {
                try {
                    await sleep(800); // small delay before caption
                    const captionText = captionParts.join('\n\n');
                    const captionResult = await sock.sendMessage(jid, { text: captionText });
                    assertWhatsAppSendResult(captionResult, jid, 'caption');
                    logger.debug('Caption sent as separate text message to newsletter');
                } catch (captionErr) {
                    logger.warn(`Failed to send caption to newsletter: ${captionErr.message}`);
                }
            }

            return { success: true, captionSent: captionParts.length > 0, strategy: 'newsletter-media' };

        } catch (err) {
            lastError = err;
            const isLastAttempt = attempt === maxRetries;

            if (
                err.message?.includes('Media upload failed') ||
                err.message?.includes('upload') ||
                err.message?.includes('media')
            ) {
                logger.warn(`Media upload failed on attempt ${attempt}/${maxRetries}: ${err.message}`);
                if (isLastAttempt) break;
            } else {
                // Non-upload error, don't retry
                throw err;
            }
        }
    }

    throw lastError || new Error('Media upload failed after all retries');
}

// Send media to regular chat (supports all types including documents and audio)
async function sendMediaToChat(sock, jid, fileBuffer, mimeType, filename, caption) {
    logger.info(`Sending media to chat ${jid}: ${filename} (${mimeType})`);

    const isImage = mimeType.startsWith('image/');
    const isGif = mimeType === 'image/gif';
    const isVideo = mimeType.startsWith('video/') || isGif;
    const isAudio = mimeType.startsWith('audio/');

    let thumbnail = null;
    if (isImage) {
        thumbnail = await generateThumbnail(fileBuffer, mimeType);
    }

    let messageContent;

    if (isImage && !isGif) {
        messageContent = {
            image: fileBuffer,
            mimetype: mimeType,
            caption: caption || undefined,
            jpegThumbnail: thumbnail,
            fileLength: fileBuffer.length,
        };
    } else if (isVideo) {
        messageContent = {
            video: fileBuffer,
            mimetype: isGif ? 'video/mp4' : mimeType,
            gifPlayback: isGif,
            caption: caption || undefined,
            jpegThumbnail: thumbnail,
            fileLength: fileBuffer.length,
        };
    } else if (isAudio) {
        const isPtt = mimeType === 'audio/ogg' || mimeType === 'audio/oga';
        messageContent = {
            audio: fileBuffer,
            mimetype: mimeType,
            ptt: isPtt,
            fileLength: fileBuffer.length,
        };
    } else {
        // Document for other file types
        messageContent = {
            document: fileBuffer,
            mimetype: mimeType,
            fileName: filename,
            caption: caption || undefined,
            jpegThumbnail: thumbnail,
            fileLength: fileBuffer.length,
        };
    }

    const result = await sock.sendMessage(jid, messageContent);
    assertWhatsAppSendResult(result, jid, 'chat-media');

    return { success: true, captionSent: !!caption, strategy: 'chat-native' };
}

async function sendMediaFile(sock, targetId, filePath, caption, options = {}) {
    const jid = await resolveNewsletterJid(sock, targetId);
    const isNewsletter = /@newsletter$/i.test(jid);
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const filename = path.basename(filePath);
    const fileBuffer = await fs.readFile(filePath);
    const fileSizeMB = fileBuffer.length / (1024 * 1024);
    const isVideo = mimeType.startsWith('video/');
    const sourceLink = options.sourceLink || null;

    logger.info(`Sending media to ${isNewsletter ? 'newsletter' : 'chat'}: ${filename} (${mimeType}), size: ${fileSizeMB.toFixed(2)} MB`);

    // For newsletters, check if media type is supported
    if (isNewsletter) {
        if (!isNewsletterSupportedMedia(mimeType)) {
            logger.warn(`Media type "${mimeType}" is not supported by WhatsApp newsletters. Only images and videos are accepted.`);

            const parts = [];
            if (caption && caption.trim()) parts.push(caption.trim());
            if (WHATSAPP_SEND_SOURCE_LINK && sourceLink) parts.push(`🔗 ${sourceLink}`);

            const msg = parts.length > 0
                ? `[Media tidak didukung: ${filename}]\n\n${parts.join('\n\n')}`
                : `[Media tidak didukung: ${filename}]`;

            await sendText(sock, jid, msg);
            return { success: true, captionSent: true, strategy: 'text-only', mediaSkipped: true };
        }

        // Send image or video to newsletter
        try {
            return await sendImageOrVideoToNewsletter(sock, jid, fileBuffer, mimeType, caption, filename, sourceLink);
        } catch (err) {
            logger.error(`Failed to send media to newsletter: ${err.message}`);

            // DDL fallback for videos
            if (isVideo && VIDEO_DDL_FALLBACK && sourceLink) {
                logger.info(`Using DDL fallback for video: ${filename}`);
                const fallbackParts = [];
                if (caption && caption.trim()) fallbackParts.push(caption.trim());
                fallbackParts.push(`🎥 Video (upload gagal): ${sourceLink}`);
                await sendText(sock, jid, fallbackParts.join('\n\n'));
                return { success: true, captionSent: true, strategy: 'video-ddl-fallback', mediaSkipped: true };
            }

            throw err;
        }
    }

    // For regular chats
    try {
        return await sendMediaToChat(sock, jid, fileBuffer, mimeType, filename, caption);
    } catch (err) {
        logger.error(`Failed to send media to chat: ${err.message}`);
        throw err;
    }
}

async function sendStickerFile(sock, targetId, filePath) {
    const jid = await resolveNewsletterJid(sock, targetId);
    const isNewsletter = /@newsletter$/i.test(jid);
    const fileBuffer = await fs.readFile(filePath);

    if (isNewsletter) {
        logger.info(`Sending sticker to newsletter as image: ${path.basename(filePath)}`);
        try {
            const result = await sock.sendMessage(jid, {
                image: fileBuffer,
                mimetype: 'image/webp',
                fileLength: fileBuffer.length,
            });
            assertWhatsAppSendResult(result, jid, 'sticker-as-image');
            return { success: true, strategy: 'image' };
        } catch (err) {
            logger.warn(`Could not send sticker to newsletter: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    try {
        const result = await sock.sendMessage(jid, {
            sticker: fileBuffer,
            mimetype: 'image/webp',
        });
        assertWhatsAppSendResult(result, jid, 'sticker');
        return { success: true, strategy: 'sticker' };
    } catch (err) {
        logger.warn(`Sticker send failed, trying as image: ${err.message}`);
        const imageResult = await sock.sendMessage(jid, {
            image: fileBuffer,
            mimetype: 'image/webp',
            fileLength: fileBuffer.length,
        });
        assertWhatsAppSendResult(imageResult, jid, 'sticker-as-image');
        return { success: true, strategy: 'image' };
    }
}

async function sendMessage(sock, targetId, payload) {
    const { text, filePath, mediaType, sourceLink } = payload;

    if (filePath && (await fs.pathExists(filePath))) {
        const hasCaption = text && text.trim();

        try {
            if (mediaType === 'sticker') {
                const result = await sendStickerFile(sock, targetId, filePath);
                if (hasCaption) {
                    try {
                        await sendText(sock, targetId, text);
                    } catch (err) {
                        logger.warn(`Failed to send sticker caption: ${err.message}`);
                    }
                }
            } else {
                const result = await sendMediaFile(
                    sock,
                    targetId,
                    filePath,
                    hasCaption ? text : null,
                    { sourceLink }
                );

                if (result?.mediaSkipped) return;

                // If caption was not sent with media, send separately
                if (hasCaption && result && !result.captionSent) {
                    try {
                        await sendText(sock, targetId, text);
                    } catch (err) {
                        logger.warn(`Failed to send media caption: ${err.message}`);
                    }
                }
            }
        } catch (err) {
            logger.error(`Failed to send media: ${err.message}`);
            if (hasCaption) {
                try {
                    await sendText(sock, targetId, text);
                    logger.info('Sent message text as fallback after media failure');
                } catch (textErr) {
                    logger.error(`Failed to send text fallback: ${textErr.message}`);
                    throw err;
                }
            } else {
                throw err;
            }
        } finally {
            await fs.remove(filePath).catch(() => {});
        }
        return;
    }

    if (text && text.trim()) {
        await sendText(sock, targetId, text);
    }
}

async function listChats(sock) {
    const chats = [];

    try {
        const groups = await sock.groupFetchAllParticipating();
        for (const [jid, meta] of Object.entries(groups)) {
            chats.push({ id: jid, name: meta.subject || 'Unknown Group', type: 'group' });
        }
    } catch (err) {
        logger.debug(`Could not fetch groups: ${err.message}`);
    }

    return chats;
}

async function checkNewsletterAccess(sock, targetId) {
    const normalizedId = normalizeWhatsAppId(targetId);
    const inviteCode = extractInviteCode(targetId);

    if (!/@newsletter$/i.test(normalizedId)) {
        logger.info(`WhatsApp target is a group/chat: ${normalizedId}`);
        return true;
    }

    if (!inviteCode) {
        logger.warn(`Cannot verify newsletter — no invite code found in: ${targetId}`);
        return false;
    }

    if (typeof sock.newsletterMetadata !== 'function') {
        logger.info(`newsletterMetadata not available, skipping verification for: ${inviteCode}`);
        return true;
    }

    try {
        const metadata = await sock.newsletterMetadata('invite', inviteCode);
        if (metadata) {
            logger.info(`WhatsApp newsletter verified: "${metadata.name || inviteCode}" (${inviteCode})`);
            logger.info(`  Subscribers: ${metadata.subscriberCount || 'unknown'}`);
            logger.info(`  Newsletter JID: ${metadata.id}`);
            return true;
        }
    } catch (err) {
        if (err.message?.includes('GraphQL')) {
            logger.warn(`Could not verify newsletter ${inviteCode}: GraphQL API error`);
            logger.warn(`  Will attempt to send messages anyway.`);
            return true;
        } else {
            logger.warn(`Could not verify newsletter ${inviteCode}: ${err.message}`);
        }
    }

    return false;
}

function getConnectionState() {
    return _isConnected;
}

async function isConnectionHealthy(sock) {
    if (!sock) return false;
    if (_isConnected) return true;

    try {
        const ws = sock.ws || sock._ws;
        if (ws && typeof ws.readyState === 'number') {
            return ws.readyState === 1;
        }
    } catch {
        // ignore
    }

    try {
        if (sock.user && sock.user.id) return true;
    } catch {
        // ignore
    }

    return false;
}

export {
    createWhatsAppClientWithReconnect,
    sendMessage,
    sendText,
    sendMediaFile,
    sendStickerFile,
    listChats,
    normalizeWhatsAppId,
    extractInviteCode,
    resolveNewsletterJid,
    checkNewsletterAccess,
    isConnectionHealthy,
    getConnectionState,
    isNewsletterSupportedMedia,
};
