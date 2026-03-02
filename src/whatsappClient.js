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

// ============================================================
// ROOT CAUSE: WhatsApp ACK error 479
//
// Semua library WebSocket (Baileys, WAHA NOWEB, whatsmeow) yang
// mencoba upload media ke newsletter/channel WhatsApp akan
// mendapatkan error 479 dari server WhatsApp. API mengembalikan
// sukses (message ID tergenerate) tapi media TIDAK PERNAH muncul
// di channel. Ini bukan bug kode — ini pembatasan server WhatsApp.
//
// Referensi:
//   https://github.com/devlikeapro/waha/issues/1523
//   https://github.com/devlikeapro/waha/issues/1504
//   https://github.com/tulir/whatsmeow/issues/690
//
// SOLUSI: Untuk newsletter, gunakan strategi DDL:
//   - Kirim teks dengan caption + link sumber sebagai pratinjau
//   - Media tetap bisa diklik dari link sumber (Telegram, dll)
//   - Untuk grup/DM biasa, upload media tetap berjalan normal
// ============================================================

const VIDEO_UPLOAD_RETRIES = parseInt(process.env.VIDEO_UPLOAD_RETRIES, 10) || 2;
const VIDEO_UPLOAD_RETRY_DELAY_MS = parseInt(process.env.VIDEO_UPLOAD_RETRY_DELAY_MS, 10) || 3000;
const MAX_VIDEO_SIZE_MB = parseInt(process.env.MAX_VIDEO_SIZE_MB, 10) || 16;
const WHATSAPP_SEND_SOURCE_LINK = String(process.env.WHATSAPP_SEND_SOURCE_LINK || 'true').toLowerCase() === 'true';

// NEWSLETTER_MEDIA_MODE mengontrol perilaku media ke newsletter:
//   'ddl'    (default) - kirim teks+link, tidak upload media (DIREKOMENDASIKAN)
//   'try'    - coba upload dulu, fallback ke ddl jika gagal
//   'native' - hanya coba upload (akan gagal dengan error 479, hanya untuk debugging)
const NEWSLETTER_MEDIA_MODE = (process.env.NEWSLETTER_MEDIA_MODE || 'ddl').toLowerCase();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let _isConnected = false;
let _reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

const SESSION_DIR = path.join(__dirname, '../sessions/baileys');
const newsletterJidCache = new Map();

function normalizeWhatsAppId(targetId) {
    if (!targetId) return targetId;
    const sanitized = String(targetId).trim().replace(/^['"]+|['"]+$/g, '');
    if (!sanitized) return sanitized;
    if (/@newsletter$/i.test(sanitized)) return sanitized;
    if (sanitized.includes('@')) return sanitized;

    const channelUrlMatch = sanitized.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/i);
    if (channelUrlMatch) return `${channelUrlMatch[1]}@newsletter`;
    if (/^120\d{10,}$/.test(sanitized)) return `${sanitized}@g.us`;
    if (/^[a-zA-Z0-9_-]{15,}$/.test(sanitized) && !sanitized.includes('@')) return `${sanitized}@newsletter`;
    return sanitized;
}

function extractInviteCode(targetId) {
    if (!targetId) return null;
    const sanitized = String(targetId).trim();
    const urlMatch = sanitized.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/i);
    if (urlMatch) return urlMatch[1];
    if (/^[a-zA-Z0-9_-]{15,}$/.test(sanitized) && !sanitized.includes('@')) return sanitized;
    if (/@newsletter$/i.test(sanitized)) return sanitized.replace(/@newsletter$/i, '');
    return null;
}

function isNewsletterSupportedMedia(mimeType) {
    if (!mimeType) return false;
    const n = mimeType.toLowerCase();
    return n.startsWith('image/') || n.startsWith('video/');
}

async function generateThumbnail(buffer, mimeType) {
    try {
        if (!mimeType?.startsWith('image/')) return null;
        return await sharp(buffer)
            .resize(100, 100, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 40 })
            .toBuffer();
    } catch (err) {
        logger.debug(`Thumbnail generation failed: ${err.message}`);
        return null;
    }
}

// ============================================================
// Buat pesan DDL untuk newsletter.
// Format: caption + ikon + link sumber
// Contoh output:
//   ⚡️ IDF merilis rekaman serangan di Lebanon.
//   📺 Sumber: https://t.me/wfwitness/73711
// ============================================================
function buildDDLMessage(caption, sourceLink, mimeType, filename) {
    const parts = [];

    if (caption?.trim()) {
        parts.push(caption.trim());
    }

    if (sourceLink || filename) {
        const isVideo = mimeType?.startsWith('video/');
        const isImage = mimeType?.startsWith('image/');
        const icon = isVideo ? '📺' : isImage ? '🖼️' : '📎';
        const label = isVideo ? 'Sumber video' : isImage ? 'Sumber gambar' : 'Sumber media';
        const link = sourceLink || filename;
        parts.push(`${icon} ${label}: ${link}`);
    }

    return parts.join('\n\n');
}

async function createWhatsAppClient(onReconnect) {
    await fs.ensureDir(SESSION_DIR);
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    logger.info(`Using Baileys v${version.join('.')} (WebSocket-based)`);

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
        shouldIgnoreJid: () => false,
    });

    sock.ev.on('creds.update', saveCreds);

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('WhatsApp connection timed out after 5 minutes'));
        }, 300_000);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                logger.info('WhatsApp QR code — scan dengan HP kamu:');
                qrcode.generate(qr, { small: true });
                logger.info('(Buka WhatsApp → Linked Devices → Link a Device → scan QR)');
            }

            if (connection === 'open') {
                clearTimeout(timeout);
                _isConnected = true;
                _reconnectAttempts = 0;
                logger.info('WhatsApp terhubung via Baileys (WebSocket).');
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
                    logger.error('WhatsApp session logout. Hapus sessions/baileys/ dan restart.');
                    const error = new Error('WhatsApp logged out');
                    error.isLoggedOut = true;
                    reject(error);
                    return;
                }

                if (!_isConnected) {
                    clearTimeout(timeout);
                    const error = new Error(`WhatsApp connection closed: ${statusCode}`);
                    error.statusCode = statusCode;
                    reject(error);
                    return;
                }

                logger.warn(`WhatsApp terputus (kode ${statusCode}). Akan reconnect...`);
                if (typeof onReconnect === 'function') onReconnect();
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
    let resolveReady, rejectReady;
    let isReady = false;
    const readyPromise = new Promise((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
    });

    const scheduleReconnect = async (reason) => {
        _reconnectAttempts++;
        if (_reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            logger.error(`Max reconnect attempts reached. Exiting.`);
            process.exit(1);
        }
        const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts), 60_000);
        logger.warn(`WhatsApp reconnecting dalam ${delay / 1000}s (percobaan ${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
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
                if (!isReady) rejectReady(err);
                return;
            }
            await scheduleReconnect(err?.message || 'unknown error');
        }
    };

    await connect();
    return readyPromise;
}

async function resolveNewsletterJid(sock, targetId) {
    const normalizedId = normalizeWhatsAppId(targetId);
    if (!/@newsletter$/i.test(normalizedId)) return normalizedId;
    if (newsletterJidCache.has(normalizedId)) return newsletterJidCache.get(normalizedId);

    const inviteCode = extractInviteCode(targetId);
    if (!inviteCode) return normalizedId;

    if (typeof sock.newsletterMetadata !== 'function') {
        logger.debug(`newsletterMetadata tidak tersedia, menggunakan: ${normalizedId}`);
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
        logger.debug(`Gagal resolve newsletter ${inviteCode}: ${err.message}`);
    }

    return normalizedId;
}

function assertWhatsAppSendResult(result, jid, contextLabel) {
    const messageId = result?.key?.id || result?.key?.remoteJid || result?.status;
    if (!messageId && !result) {
        throw new Error(`WhatsApp returned empty send result for ${contextLabel} -> ${jid}`);
    }
    const status = result?.status;
    if (status === 'error' || status === 'failed') {
        throw new Error(`WhatsApp send failed with status: ${status}`);
    }
    if (/@newsletter$/i.test(jid)) {
        logger.info(`Newsletter message sent: ${messageId || 'pending'} (${contextLabel})`);
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
// Kirim media ke grup atau DM biasa (bukan newsletter)
// Method ini berfungsi normal karena bukan ke newsletter
// ============================================================
async function sendMediaToChat(sock, jid, fileBuffer, mimeType, filename, caption) {
    logger.info(`Mengirim media ke chat ${jid}: ${filename} (${mimeType})`);

    const isImage = mimeType.startsWith('image/');
    const isGif = mimeType === 'image/gif';
    const isVideo = mimeType.startsWith('video/') || isGif;
    const isAudio = mimeType.startsWith('audio/');

    let thumbnail = null;
    if (isImage && !isGif) {
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

// ============================================================
// Coba upload media native ke newsletter.
// PERINGATAN: Ini AKAN GAGAL dengan error 479 dari WhatsApp.
// Hanya digunakan dalam mode 'try' sebagai percobaan pertama,
// atau mode 'native' untuk debugging.
// ============================================================
async function tryNativeNewsletterUpload(sock, jid, fileBuffer, mimeType, filename) {
    const isGif = mimeType === 'image/gif';
    const isVideo = mimeType.startsWith('video/') || isGif;
    const isImage = mimeType.startsWith('image/') && !isGif;

    let jpegThumbnail = null;
    if (isImage) {
        jpegThumbnail = await generateThumbnail(fileBuffer, mimeType);
    }

    const messageContent = isImage
        ? {
            image: fileBuffer,
            mimetype: mimeType,
            fileLength: fileBuffer.length,
            ...(jpegThumbnail ? { jpegThumbnail } : {}),
        }
        : {
            video: fileBuffer,
            mimetype: isGif ? 'video/mp4' : mimeType,
            fileLength: fileBuffer.length,
            gifPlayback: isGif,
            ...(jpegThumbnail ? { jpegThumbnail } : {}),
        };

    const maxRetries = isVideo ? VIDEO_UPLOAD_RETRIES : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 1) {
                await sleep(VIDEO_UPLOAD_RETRY_DELAY_MS * (attempt - 1));
                logger.info(`Retry upload ke newsletter (attempt ${attempt}/${maxRetries})...`);
            }

            const result = await sock.sendMessage(jid, messageContent);
            assertWhatsAppSendResult(result, jid, isImage ? 'image' : 'video');

            // Jika berhasil (jarang terjadi), return sukses
            return { success: true, strategy: 'newsletter-native' };

        } catch (err) {
            lastError = err;
            const shouldRetry = err.message?.includes('upload') || err.message?.includes('media');
            if (!shouldRetry || attempt === maxRetries) break;
            logger.warn(`Upload attempt ${attempt} gagal: ${err.message}`);
        }
    }

    throw lastError || new Error('Native newsletter upload failed');
}

async function sendMediaFile(sock, targetId, filePath, caption, options = {}) {
    const jid = await resolveNewsletterJid(sock, targetId);
    const isNewsletter = /@newsletter$/i.test(jid);
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const filename = path.basename(filePath);
    const sourceLink = options.sourceLink || null;
    const fileSizeMB = (await fs.stat(filePath)).size / (1024 * 1024);

    logger.info(`Mengirim media ke ${isNewsletter ? 'newsletter' : 'chat'}: ${filename} (${mimeType}, ${fileSizeMB.toFixed(2)} MB)`);

    // ============================================================
    // NEWSLETTER: WhatsApp error 479 memblokir semua media upload
    // Gunakan strategi DDL (teks + link sumber) sebagai gantinya
    // ============================================================
    if (isNewsletter) {
        const mode = NEWSLETTER_MEDIA_MODE;

        // Mode DDL: langsung kirim teks tanpa upload (DEFAULT)
        if (mode === 'ddl') {
            logger.info(`Newsletter DDL mode: mengirim teks+link (WA error 479 memblokir media upload)`);
            const ddlMsg = buildDDLMessage(caption, sourceLink, mimeType, filename);
            if (ddlMsg) {
                await sendText(sock, jid, ddlMsg);
                return { success: true, captionSent: true, strategy: 'newsletter-ddl', mediaSkipped: true };
            }
            logger.warn(`Newsletter DDL: tidak ada caption atau source link untuk ${filename}`);
            return { success: true, captionSent: false, strategy: 'newsletter-ddl-empty', mediaSkipped: true };
        }

        // Mode TRY: coba native dulu, fallback ke DDL
        if (mode === 'try') {
            if (!isNewsletterSupportedMedia(mimeType)) {
                logger.info(`Mime type ${mimeType} tidak didukung newsletter, langsung DDL`);
                const ddlMsg = buildDDLMessage(caption, sourceLink, mimeType, filename);
                if (ddlMsg) await sendText(sock, jid, ddlMsg);
                return { success: true, captionSent: !!ddlMsg, strategy: 'newsletter-ddl', mediaSkipped: true };
            }

            const fileBuffer = await fs.readFile(filePath);
            try {
                logger.info(`Newsletter try-mode: mencoba native upload dulu...`);
                await tryNativeNewsletterUpload(sock, jid, fileBuffer, mimeType, filename);

                // Kirim caption jika upload berhasil
                const captionParts = [];
                if (caption?.trim()) captionParts.push(caption.trim());
                if (WHATSAPP_SEND_SOURCE_LINK && sourceLink) captionParts.push(`🔗 ${sourceLink}`);
                if (captionParts.length > 0) {
                    await sleep(800);
                    await sendText(sock, jid, captionParts.join('\n\n'));
                }
                return { success: true, captionSent: captionParts.length > 0, strategy: 'newsletter-native' };

            } catch (err) {
                logger.warn(`Native newsletter upload gagal (${err.message}), fallback ke DDL...`);
                const ddlMsg = buildDDLMessage(caption, sourceLink, mimeType, filename);
                if (ddlMsg) await sendText(sock, jid, ddlMsg);
                return { success: true, captionSent: !!ddlMsg, strategy: 'newsletter-ddl-fallback', mediaSkipped: true };
            }
        }

        // Mode NATIVE: hanya coba upload (untuk debugging, akan gagal dengan error 479)
        if (mode === 'native') {
            logger.warn(`Newsletter native mode: mencoba upload langsung (kemungkinan besar gagal dengan error 479)`);
            if (!isNewsletterSupportedMedia(mimeType)) {
                throw new Error(`Mime type ${mimeType} tidak didukung newsletter`);
            }
            const fileBuffer = await fs.readFile(filePath);
            await tryNativeNewsletterUpload(sock, jid, fileBuffer, mimeType, filename);

            const captionParts = [];
            if (caption?.trim()) captionParts.push(caption.trim());
            if (WHATSAPP_SEND_SOURCE_LINK && sourceLink) captionParts.push(`🔗 ${sourceLink}`);
            if (captionParts.length > 0) {
                await sleep(800);
                await sendText(sock, jid, captionParts.join('\n\n'));
            }
            return { success: true, captionSent: captionParts.length > 0, strategy: 'newsletter-native-forced' };
        }

        // Fallback jika mode tidak dikenal
        logger.warn(`Mode newsletter tidak dikenal: "${mode}", menggunakan DDL`);
        const ddlMsg = buildDDLMessage(caption, sourceLink, mimeType, filename);
        if (ddlMsg) await sendText(sock, jid, ddlMsg);
        return { success: true, captionSent: !!ddlMsg, strategy: 'newsletter-ddl-fallback', mediaSkipped: true };
    }

    // Regular chat: upload media normal
    const fileBuffer = await fs.readFile(filePath);
    try {
        return await sendMediaToChat(sock, jid, fileBuffer, mimeType, filename, caption);
    } catch (err) {
        logger.error(`Gagal kirim media ke chat: ${err.message}`);
        throw err;
    }
}

async function sendStickerFile(sock, targetId, filePath) {
    const jid = await resolveNewsletterJid(sock, targetId);
    const isNewsletter = /@newsletter$/i.test(jid);

    if (isNewsletter) {
        // Sticker tidak didukung newsletter
        logger.info(`Skip sticker untuk newsletter (tidak didukung)`);
        return { success: true, strategy: 'skipped', mediaSkipped: true };
    }

    const fileBuffer = await fs.readFile(filePath);
    try {
        const result = await sock.sendMessage(jid, { sticker: fileBuffer, mimetype: 'image/webp' });
        assertWhatsAppSendResult(result, jid, 'sticker');
        return { success: true, strategy: 'sticker' };
    } catch (err) {
        logger.warn(`Sticker gagal, coba sebagai image: ${err.message}`);
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
                await sendStickerFile(sock, targetId, filePath);
                if (hasCaption) {
                    try { await sendText(sock, targetId, text); } catch (e) {
                        logger.warn(`Gagal kirim caption sticker: ${e.message}`);
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

                if (hasCaption && result && !result.captionSent) {
                    try { await sendText(sock, targetId, text); } catch (e) {
                        logger.warn(`Gagal kirim caption media: ${e.message}`);
                    }
                }
            }
        } catch (err) {
            logger.error(`Gagal kirim media: ${err.message}`);
            if (hasCaption) {
                try {
                    await sendText(sock, targetId, text);
                    logger.info('Teks terkirim sebagai fallback setelah media gagal');
                } catch (textErr) {
                    logger.error(`Gagal kirim teks fallback: ${textErr.message}`);
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
        logger.debug(`Gagal fetch groups: ${err.message}`);
    }
    return chats;
}

async function checkNewsletterAccess(sock, targetId) {
    const normalizedId = normalizeWhatsAppId(targetId);
    const inviteCode = extractInviteCode(targetId);

    if (!/@newsletter$/i.test(normalizedId)) {
        logger.info(`WhatsApp target adalah group/chat: ${normalizedId}`);
        return true;
    }

    if (!inviteCode) {
        logger.warn(`Tidak bisa verifikasi newsletter — tidak ada invite code di: ${targetId}`);
        return false;
    }

    const mode = NEWSLETTER_MEDIA_MODE;
    logger.info(`Newsletter mode: NEWSLETTER_MEDIA_MODE=${mode}`);
    if (mode === 'ddl') {
        logger.info(`  → Media akan dikirim sebagai teks + link (karena WA error 479 memblokir upload)`);
        logger.info(`  → Untuk mencoba native upload, set NEWSLETTER_MEDIA_MODE=try di .env`);
    } else if (mode === 'try') {
        logger.info(`  → Akan coba upload dulu, fallback ke DDL jika error 479`);
    } else if (mode === 'native') {
        logger.warn(`  → NATIVE mode: upload langsung akan dicoba (kemungkinan besar gagal dengan error 479)`);
    }

    if (typeof sock.newsletterMetadata !== 'function') {
        logger.info(`newsletterMetadata tidak tersedia, skip verifikasi`);
        return true;
    }

    try {
        const metadata = await sock.newsletterMetadata('invite', inviteCode);
        if (metadata) {
            logger.info(`Newsletter terverifikasi: "${metadata.name || inviteCode}" (${inviteCode})`);
            logger.info(`  Subscribers: ${metadata.subscriberCount || 'unknown'}`);
            return true;
        }
    } catch (err) {
        if (err.message?.includes('GraphQL')) {
            logger.warn(`GraphQL error verifikasi newsletter — akan tetap mencoba.`);
            return true;
        }
        logger.warn(`Gagal verifikasi newsletter ${inviteCode}: ${err.message}`);
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
        if (ws && typeof ws.readyState === 'number') return ws.readyState === 1;
    } catch {}

    try {
        if (sock.user && sock.user.id) return true;
    } catch {}

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
