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
    
    // Images
    if (normalized.startsWith('image/')) return true;
    // Videos
    if (normalized.startsWith('video/')) return true;
    
    return false;
}

async function generateThumbnail(buffer, mimeType) {
    try {
        if (!mimeType?.startsWith('image/')) {
            return null;
        }

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

    // Check cache first
    if (newsletterJidCache.has(normalizedId)) {
        return newsletterJidCache.get(normalizedId);
    }

    const inviteCode = extractInviteCode(targetId);
    if (!inviteCode) return normalizedId;

    // If newsletterMetadata is not available, return normalized ID directly
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
        // Handle GraphQL errors gracefully - these are common with newer Baileys versions
        if (err.message?.includes('GraphQL')) {
            logger.debug(`GraphQL error when resolving newsletter ${inviteCode}: ${err.message}`);
            logger.debug(`Falling back to constructed JID: ${inviteCode}@newsletter`);
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
    
    // Check for explicit failure indicators
    const status = result?.status;
    if (status === 'error' || status === 'failed') {
        throw new Error(`WhatsApp send failed with status: ${status} for ${contextLabel} -> ${jid}`);
    }
    
    // For newsletters, log extra info
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

// Send image or video to newsletter
async function sendImageOrVideoToNewsletter(sock, jid, fileBuffer, mimeType, caption) {
    const isImage = mimeType.startsWith('image/');
    const isGif = mimeType === 'image/gif';
    const isVideo = mimeType.startsWith('video/') || isGif;
    
    logger.info(`Sending ${isImage ? 'image' : 'video'} to newsletter ${jid} (${mimeType})`);
    
    // Generate thumbnail for images
    let thumbnail = null;
    if (isImage && !isGif) {
        thumbnail = await generateThumbnail(fileBuffer, mimeType);
    }

    let messageContent;
    
    if (isImage && !isGif) {
        messageContent = {
            image: fileBuffer,
            mimetype: mimeType,
            jpegThumbnail: thumbnail,
        };
    } else {
        // Video or GIF
        messageContent = {
            video: fileBuffer,
            mimetype: isGif ? 'video/mp4' : mimeType,
            gifPlayback: isGif,
            jpegThumbnail: thumbnail,
        };
    }

    // Send media
    const result = await sock.sendMessage(jid, messageContent);
    assertWhatsAppSendResult(result, jid, isImage ? 'image' : 'video');
    
    // For newsletters, send caption as separate message
    let captionSent = false;
    if (caption && caption.trim()) {
        try {
            await sendText(sock, jid, caption);
            captionSent = true;
            logger.debug('Caption sent as separate text message to newsletter');
        } catch (captionErr) {
            logger.warn(`Failed to send caption to newsletter: ${captionErr.message}`);
        }
    }
    
    return { success: true, captionSent, strategy: 'newsletter-media' };
}

// Send media to regular chat (supports all types including documents and audio)
async function sendMediaToChat(sock, jid, fileBuffer, mimeType, filename, caption) {
    logger.info(`Sending media to chat ${jid}: ${filename} (${mimeType})`);
    
    const isImage = mimeType.startsWith('image/');
    const isGif = mimeType === 'image/gif';
    const isVideo = mimeType.startsWith('video/') || isGif;
    const isAudio = mimeType.startsWith('audio/');
    
    // Generate thumbnail for images
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
        };
    } else if (isVideo) {
        messageContent = {
            video: fileBuffer,
            mimetype: isGif ? 'video/mp4' : mimeType,
            gifPlayback: isGif,
            caption: caption || undefined,
            jpegThumbnail: thumbnail,
        };
    } else if (isAudio) {
        const isPtt = mimeType === 'audio/ogg' || mimeType === 'audio/oga';
        messageContent = {
            audio: fileBuffer,
            mimetype: mimeType,
            ptt: isPtt,
        };
    } else {
        // Document for other file types
        messageContent = {
            document: fileBuffer,
            mimetype: mimeType,
            fileName: filename,
            caption: caption || undefined,
            jpegThumbnail: thumbnail,
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
    
    logger.info(`Sending media to ${isNewsletter ? 'newsletter' : 'chat'}: ${filename} (${mimeType}), size: ${(fileBuffer.length / 1024).toFixed(2)} KB`);

    // For newsletters, check if media type is supported
    if (isNewsletter) {
        if (!isNewsletterSupportedMedia(mimeType)) {
            logger.warn(`Media type "${mimeType}" is not supported by WhatsApp newsletters. Only images and videos are accepted.`);
            logger.info(`Sending caption as text message instead for: ${filename}`);
            
            // Send just the caption as text (with a note about the unsupported media)
            if (caption && caption.trim()) {
                const unsupportedText = `[Media not supported: ${filename}]\n\n${caption}`;
                await sendText(sock, jid, unsupportedText);
                return { success: true, captionSent: true, strategy: 'text-only', mediaSkipped: true };
            } else {
                await sendText(sock, jid, `[Media not supported: ${filename}]`);
                return { success: true, captionSent: false, strategy: 'text-only', mediaSkipped: true };
            }
        }

        // Send image or video to newsletter
        try {
            return await sendImageOrVideoToNewsletter(sock, jid, fileBuffer, mimeType, caption);
        } catch (err) {
            logger.error(`Failed to send media to newsletter: ${err.message}`);
            throw err;
        }
    }

    // For regular chats, use standard approach (supports all media types)
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
    
    // For newsletters, stickers may not work - try as image
    if (isNewsletter) {
        logger.info(`Sending sticker to newsletter as image: ${path.basename(filePath)}`);
        try {
            // Try as WebP image
            const result = await sock.sendMessage(jid, {
                image: fileBuffer,
                mimetype: 'image/webp',
            });
            assertWhatsAppSendResult(result, jid, 'sticker-as-image');
            return { success: true, strategy: 'image' };
        } catch (err) {
            logger.warn(`Could not send sticker to newsletter: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
    
    // For regular chats, try sticker format
    try {
        const result = await sock.sendMessage(jid, {
            sticker: fileBuffer,
            mimetype: 'image/webp',
        });
        assertWhatsAppSendResult(result, jid, 'sticker');
        return { success: true, strategy: 'sticker' };
    } catch (err) {
        // Fallback to image
        logger.warn(`Sticker send failed, trying as image: ${err.message}`);
        const imageResult = await sock.sendMessage(jid, {
            image: fileBuffer,
            mimetype: 'image/webp',
        });
        assertWhatsAppSendResult(imageResult, jid, 'sticker-as-image');
        return { success: true, strategy: 'image' };
    }
}

async function sendMessage(sock, targetId, payload) {
    const { text, filePath, mediaType } = payload;

    if (filePath && (await fs.pathExists(filePath))) {
        const hasCaption = text && text.trim();

        try {
            if (mediaType === 'sticker') {
                const result = await sendStickerFile(sock, targetId, filePath);
                // Send caption separately if exists
                if (hasCaption) {
                    try {
                        await sendText(sock, targetId, text);
                    } catch (err) {
                        logger.warn(`Failed to send sticker caption: ${err.message}`);
                    }
                }
            } else {
                const result = await sendMediaFile(sock, targetId, filePath, hasCaption ? text : null);
                
                // If media was skipped (unsupported for newsletters), caption was already sent
                if (result?.mediaSkipped) {
                    return;
                }
                
                // If media sent but caption failed, ensure caption is sent
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
            // Final fallback: send as text
            if (hasCaption) {
                try {
                    await sendText(sock, targetId, text);
                    logger.info('Sent message text as fallback');
                } catch (textErr) {
                    logger.error(`Failed to send text fallback: ${textErr.message}`);
                    throw err;
                }
            } else {
                throw err;
            }
        } finally {
            // Clean up temp file
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

    logger.info('Note: WhatsApp channels (newsletters) must be queried by their invite code or JID directly.');
    logger.info('Use WHATSAPP_TARGET_ID with a channel URL or code, e.g. https://whatsapp.com/channel/xxxx');

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

    // If newsletterMetadata is not available, skip verification
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
            logger.info(`  Note: WhatsApp channels only support images, videos, and text messages.`);
            return true;
        }
    } catch (err) {
        // Handle GraphQL errors gracefully
        if (err.message?.includes('GraphQL')) {
            logger.warn(`Could not verify newsletter ${inviteCode}: GraphQL API error`);
            logger.warn(`  This is a known issue with some Baileys versions.`);
            logger.warn(`  Will attempt to send messages anyway — if you have admin access, it should work.`);
            return true;
        } else {
            logger.warn(`Could not verify newsletter ${inviteCode}: ${err.message}`);
            logger.warn('Make sure WHATSAPP_TARGET_ID is correct and your account has access to post.');
        }
    }

    return false;
}

// Get connection state for external modules
function getConnectionState() {
    return _isConnected;
}

// Health check function
async function isConnectionHealthy(sock) {
    if (!sock) return false;
    
    // First check internal connection state
    if (_isConnected) return true;
    
    // Fallback: check WebSocket readyState if available
    try {
        const ws = sock.ws || sock._ws;
        if (ws && typeof ws.readyState === 'number') {
            // WebSocket.OPEN = 1
            return ws.readyState === 1;
        }
    } catch {
        // Ignore errors
    }
    
    // Last resort: check if socket has active connection via presence
    try {
        // If we can access the socket's user ID, connection is likely active
        if (sock.user && sock.user.id) {
            return true;
        }
    } catch {
        // Ignore errors
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
