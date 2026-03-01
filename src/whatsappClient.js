import makeWASocket from '@whiskeysockets/baileys';
import { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs-extra';
import mime from 'mime-types';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let _isConnected = false;
let _reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

const SESSION_DIR = path.join(__dirname, '../sessions/baileys');

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

        sock.ev.on('auth-state.update', () => {
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

async function sendText(sock, targetId, text) {
    if (!text || !text.trim()) return;
    const jid = await resolveNewsletterJid(sock, targetId);
    await sock.sendMessage(jid, { text });
}

async function sendMediaFile(sock, targetId, filePath, caption) {
    const jid = await resolveNewsletterJid(sock, targetId);
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const fileBuffer = await fs.readFile(filePath);
    const filename = path.basename(filePath);

    let messageContent;

    if (mimeType.startsWith('image/') && mimeType !== 'image/gif') {
        messageContent = {
            image: fileBuffer,
            caption: caption || '',
            mimetype: mimeType,
        };
    } else if (mimeType.startsWith('video/') || mimeType === 'image/gif') {
        messageContent = {
            video: fileBuffer,
            caption: caption || '',
            mimetype: mimeType.startsWith('image/') ? 'video/mp4' : mimeType,
            gifPlayback: mimeType === 'image/gif',
        };
    } else if (mimeType.startsWith('audio/')) {
        const isPtt = mimeType === 'audio/ogg' || mimeType === 'audio/oga';
        messageContent = {
            audio: fileBuffer,
            mimetype: mimeType,
            ptt: isPtt,
        };
    } else {
        messageContent = {
            document: fileBuffer,
            mimetype: mimeType,
            fileName: filename,
            caption: caption || '',
        };
    }

    try {
        await sock.sendMessage(jid, messageContent);
    } catch (err) {
        // If sending with caption fails, try without caption as fallback
        if (caption && err.message?.includes('caption')) {
            logger.warn(`Failed to send media with caption, retrying without caption...`);
            delete messageContent.caption;
            await sock.sendMessage(jid, messageContent);
        } else {
            throw err;
        }
    }
}

async function sendStickerFile(sock, targetId, filePath) {
    const jid = await resolveNewsletterJid(sock, targetId);
    const fileBuffer = await fs.readFile(filePath);
    await sock.sendMessage(jid, {
        sticker: fileBuffer,
        mimetype: 'image/webp',
    });
}

async function sendMessage(sock, targetId, payload) {
    const { text, filePath, mediaType } = payload;

    if (filePath && (await fs.pathExists(filePath))) {
        try {
            if (mediaType === 'sticker') {
                await sendStickerFile(sock, targetId, filePath);
            } else {
                await sendMediaFile(sock, targetId, filePath, text || '');
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

export {
    createWhatsAppClientWithReconnect,
    sendMessage,
    sendText,
    sendMediaFile,
    listChats,
    normalizeWhatsAppId,
    extractInviteCode,
    resolveNewsletterJid,
    checkNewsletterAccess,
};
