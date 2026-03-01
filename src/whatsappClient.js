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

async function generateThumbnail(filePath, mimeType) {
    try {
        if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
            return null;
        }

        const buffer = await fs.readFile(filePath);
        let thumbnailBuffer;

        if (mimeType.startsWith('image/')) {
            // Generate thumbnail for images
            thumbnailBuffer = await sharp(buffer)
                .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 50 })
                .toBuffer();
        } else {
            // For videos, we'd need ffmpeg - skip for now
            return null;
        }

        return thumbnailBuffer;
    } catch (err) {
        logger.debug(`Could not generate thumbnail for ${filePath}: ${err.message}`);
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


// Helper function to wait for message acknowledgment
async function waitForAck(sock, messageId, jid, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve(false);
        }, timeoutMs);

        // Listen for message ack
        const handler = (update) => {
            const msgKey = update.key?.id;
            const remoteJid = update.key?.remoteJid;
            
            if (msgKey === messageKey || (remoteJid === jid && update.update?.receipt)) {
                // Check for final status
                const receipt = update.update?.receipt;
                if (receipt === 'read' || receipt === 'played' || update.update?.status === 'read') {
                    clearTimeout(timeout);
                    sock.ev.off('messages.update', handler);
                    resolve(true);
                }
            }
        };
        
        sock.ev.on('messages.update', handler);
    });
}

// Helper to get message key prefix for matching
let messageKey = '';

function assertWhatsAppSendResult(result, jid, contextLabel) {
    const messageId = result?.key?.id || result?.key?.remoteJid || result?.status;
    messageKey = messageId; // Store for ack checking
    
    if (!messageId) {
        throw new Error(`WhatsApp returned an empty send result for ${contextLabel} -> ${jid}`);
    }
    
    // Check for explicit failure indicators
    const status = result?.status;
    if (status === 'error' || status === 'failed') {
        throw new Error(`WhatsApp send failed with status: ${status} for ${contextLabel} -> ${jid}`);
    }
    
    // For newsletters, log extra info
    if (/@newsletter$/i.test(jid)) {
        logger.debug(`Newsletter message sent: ${messageId} (${contextLabel}), status: ${status}, remoteJid: ${result?.key?.remoteJid}`);
    } else {
        logger.debug(`WhatsApp message sent: ${messageId} (${contextLabel}), status: ${status}`);
    }
}

async function sendText(sock, targetId, text) {
    if (!text || !text.trim()) return;
    const jid = await resolveNewsletterJid(sock, targetId);
    const result = await sock.sendMessage(jid, { text });
    assertWhatsAppSendResult(result, jid, 'text');
}

// Media upload options for different scenarios
const MEDIA_UPLOAD_STRATEGIES = {
    // Native media - best for in-app viewing
    native: async (sock, jid, fileBuffer, mimeType, filename, caption, thumbnail) => {
        const isNewsletter = /@newsletter$/i.test(jid);
        
        if (mimeType.startsWith('image/') && mimeType !== 'image/gif') {
            const messageContent = {
                image: fileBuffer,
                mimetype: mimeType,
                caption: caption || undefined,
            };
            // For newsletters, use stream upload if possible
            if (isNewsletter) {
                // Try without caption first for newsletters (caption support varies)
                const contentWithoutCaption = { image: fileBuffer, mimetype: mimeType };
                return { content: contentWithoutCaption, hasCaption: false };
            }
            return { content: messageContent, hasCaption: !!caption };
        }

        if (mimeType.startsWith('video/') || mimeType === 'image/gif') {
            const messageContent = {
                video: fileBuffer,
                mimetype: mimeType === 'image/gif' ? 'video/mp4' : mimeType,
                gifPlayback: mimeType === 'image/gif',
                caption: caption || undefined,
            };
            if (isNewsletter) {
                const contentWithoutCaption = {
                    video: fileBuffer,
                    mimetype: mimeType === 'image/gif' ? 'video/mp4' : mimeType,
                    gifPlayback: mimeType === 'image/gif',
                };
                return { content: contentWithoutCaption, hasCaption: false };
            }
            return { content: messageContent, hasCaption: !!caption };
        }

        if (mimeType.startsWith('audio/')) {
            const isPtt = mimeType === 'audio/ogg' || mimeType === 'audio/oga';
            return {
                content: {
                    audio: fileBuffer,
                    mimetype: mimeType,
                    ptt: isPtt,
                },
                hasCaption: false,
            };
        }

        // Documents for other file types
        return {
            content: {
                document: fileBuffer,
                mimetype: mimeType,
                fileName: filename,
                caption: caption || undefined,
            },
            hasCaption: !!caption,
        };
    },

    // Document mode - always sends as downloadable file
    document: async (sock, jid, fileBuffer, mimeType, filename, caption) => {
        return {
            content: {
                document: fileBuffer,
                mimetype: mimeType,
                fileName: filename,
                caption: caption || undefined,
            },
            hasCaption: !!caption,
        };
    },
};

async function sendMediaFile(sock, targetId, filePath, caption, options = {}) {
    const jid = await resolveNewsletterJid(sock, targetId);
    const isNewsletter = /@newsletter$/i.test(jid);
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const filename = path.basename(filePath);
    const fileBuffer = await fs.readFile(filePath);
    
    // Determine media mode
    const mediaMode = (process.env.NEWSLETTER_MEDIA_MODE || 'hybrid').trim().toLowerCase();
    
    logger.info(`Sending media to ${isNewsletter ? 'newsletter' : 'chat'}: ${filename} (${mimeType}), mode: ${mediaMode}`);
    
    // Generate thumbnail for images
    let thumbnail = null;
    if (mimeType.startsWith('image/')) {
        thumbnail = await generateThumbnail(filePath, mimeType);
    }

    // Strategy: Try native first, then fallback to document based on mode
    const strategies = [];
    
    if (isNewsletter) {
        if (mediaMode === 'document') {
            strategies.push('document');
        } else if (mediaMode === 'native') {
            strategies.push('native');
        } else {
            // hybrid - try native first, then fallback to document
            strategies.push('native');
            strategies.push('document');
        }
    } else {
        // For regular chats, always use native
        strategies.push('native');
    }

    let lastError = null;
    let mediaSent = false;
    let captionSent = false;

    for (const strategy of strategies) {
        try {
            const { content, hasCaption } = await MEDIA_UPLOAD_STRATEGIES[strategy](
                sock, jid, fileBuffer, mimeType, filename, caption, thumbnail
            );

            logger.debug(`Attempting to send media with strategy: ${strategy}, hasCaption: ${hasCaption}, jid: ${jid}`);
            
            const result = await sock.sendMessage(jid, content);
            assertWhatsAppSendResult(result, jid, `media-${strategy}`);
            mediaSent = true;
            
            logger.info(`Media sent successfully via ${strategy} strategy to ${jid}`);

            // For newsletters, if caption wasn't sent with media, send as separate text
            if (isNewsletter && caption && caption.trim() && !hasCaption) {
                try {
                    await sendText(sock, targetId, caption);
                    captionSent = true;
                    logger.debug('Caption sent as separate text message');
                } catch (captionErr) {
                    logger.warn(`Failed to send caption as text: ${captionErr.message}`);
                }
            } else if (hasCaption) {
                captionSent = true;
            }

            return { success: true, mediaSent, captionSent, strategy };
        } catch (err) {
            lastError = err;
            logger.warn(`Strategy ${strategy} failed: ${err.message}`);
            if (err.stack) {
                logger.debug(`Stack trace: ${err.stack}`);
            }
            
            // If media was sent but caption failed, try sending caption separately
            if (mediaSent && caption && caption.trim() && !captionSent) {
                try {
                    await sendText(sock, targetId, caption);
                    captionSent = true;
                    logger.debug('Caption sent as separate text after media');
                } catch (captionErr) {
                    logger.warn(`Failed to send caption as text: ${captionErr.message}`);
                }
            }
            
            // Only try next strategy if media wasn't sent
            if (mediaSent) {
                return { success: true, mediaSent, captionSent, strategy };
            }
        }
    }

    // All strategies failed
    logger.error(`All media sending strategies failed. Last error: ${lastError?.message}`);
    throw lastError || new Error('Failed to send media after all attempts');
}

async function sendStickerFile(sock, targetId, filePath) {
    const jid = await resolveNewsletterJid(sock, targetId);
    const fileBuffer = await fs.readFile(filePath);
    
    try {
        const result = await sock.sendMessage(jid, {
            sticker: fileBuffer,
            mimetype: 'image/webp',
        });
        assertWhatsAppSendResult(result, jid, 'sticker');
    } catch (err) {
        // For newsletters, try sending as image if sticker fails
        if (/@newsletter$/i.test(jid)) {
            logger.warn(`Sticker send failed for newsletter, trying as image: ${err.message}`);
            const imageResult = await sock.sendMessage(jid, {
                image: fileBuffer,
                mimetype: 'image/webp',
            });
            assertWhatsAppSendResult(imageResult, jid, 'sticker-as-image');
            return;
        }
        throw err;
    }
}

async function sendMessage(sock, targetId, payload) {
    const { text, filePath, mediaType } = payload;

    if (filePath && (await fs.pathExists(filePath))) {
        const hasCaption = text && text.trim();

        try {
            if (mediaType === 'sticker') {
                await sendStickerFile(sock, targetId, filePath);
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
            logger.error(`Failed to send media after all attempts: ${err.message}`);
            // Final fallback: send as text with source link if available
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
            return true;
        }
    } catch (err) {
        // Handle GraphQL errors gracefully
        if (err.message?.includes('GraphQL')) {
            logger.warn(`Could not verify newsletter ${inviteCode}: GraphQL API error`);
            logger.warn(`  This is a known issue with some Baileys versions.`);
            logger.warn(`  Will attempt to send messages anyway — if you have admin access, it should work.`);
            return true; // Return true to allow sending attempts
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
};
