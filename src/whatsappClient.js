const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const mime = require('mime-types');
const path = require('path');
const logger = require('./logger');
const { execSync } = require('child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resolvedTargets = new Set();

function findChromeExecutable() {
    const possiblePaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        '/usr/bin/chromium-browser-unstable',
    ];

    for (const chromePath of possiblePaths) {
        if (fs.existsSync(chromePath)) {
            logger.info(`Found Chrome executable at: ${chromePath}`);
            return chromePath;
        }
    }

    // Try to find using which command
    try {
        const chromePath = execSync('which google-chrome-stable || which google-chrome || which chromium-browser || which chromium', {
            encoding: 'utf-8',
        }).trim();
        if (chromePath) {
            logger.info(`Found Chrome executable via which: ${chromePath}`);
            return chromePath;
        }
    } catch (e) {
        // Ignore
    }

    logger.warn('Chrome/Chromium executable not found, relying on Puppeteer bundled Chrome');
    return undefined;
}

async function createWhatsAppClient() {
    const executablePath = findChromeExecutable();

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(__dirname, '../sessions/whatsapp'),
        }),
        puppeteer: {
            headless: 'new',
            executablePath: executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-default-apps',
                '--disable-translate',
                '--disable-sync',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    });

    await new Promise((resolve, reject) => {
        // Use 5 minute timeout to allow time for QR code scanning on first run
        const timeout = setTimeout(() => {
            reject(new Error('WhatsApp connection timed out after 5 minutes'));
        }, 300_000);

        let qrGenerated = false;
        let readyFired = false;

        client.on('loading_screen', (percent, message) => {
            logger.info(`WhatsApp loading: ${percent}% - ${message || 'connecting...'}`);
        });

        client.on('qr', (qr) => {
            qrGenerated = true;
            logger.info('WhatsApp QR code generated — scan with your phone:');
            qrcode.generate(qr, { small: true });
            logger.info('(If QR code is not scannable, try logging into WhatsApp Web manually at web.whatsapp.com)');
        });

        client.on('ready', async () => {
            if (readyFired) return; // Prevent double-firing
            readyFired = true;
            clearTimeout(timeout);
            clearTimeout(timeoutWarning);
            logger.info('WhatsApp userbot ready.');
            await sleep(1000);
            resolve();
        });

        client.on('auth_failure', (msg) => {
            clearTimeout(timeout);
            clearTimeout(timeoutWarning);
            reject(new Error(`WhatsApp auth failure: ${msg}`));
        });

        client.on('disconnected', (reason) => {
            logger.warn(`WhatsApp disconnected: ${reason}`);
        });

        // Add timeout warning after 2 minutes if still connecting
        const timeoutWarning = setTimeout(() => {
            if (!readyFired) {
                logger.warn('WhatsApp is taking longer than 2 minutes to connect. If this is your first run, please scan the QR code now.');
            }
        }, 120_000);

        // Handle puppeteer/browser errors during initialization
        client.on('error', (error) => {
            clearTimeout(timeout);
            clearTimeout(timeoutWarning);
            logger.error('WhatsApp client error during initialization:', error);
            if (error.message.includes('TargetCloseError') || error.message.includes('Session closed')) {
                reject(new Error('Browser closed unexpectedly during initialization. This may be due to resource constraints or Chrome compatibility issues. Try again or check system resources.'));
            } else {
                reject(error);
            }
        });

        client.initialize().catch((err) => {
            clearTimeout(timeout);
            clearTimeout(timeoutWarning);
            reject(err);
        });
    });

    return client;
}

async function listChats(client, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await sleep(2000);
            const chats = await client.getChats();
            
            // Also try to get channels via the newsletter method
            let allItems = chats.map((c) => ({
                id: c.id._serialized,
                name: c.name,
                type: c.isGroup ? 'group' : c.isChannel ? 'channel' : 'chat',
            }));
            
            // Try to get followed channels via the newsletter API (browser context)
            try {
                const newsletterChats = await client.pupPage.evaluate(async () => {
                    const result = [];
                    try {
                        // Try to get newsletters/channels using the internal WhatsApp Web API
                        // Access the Store module that whatsapp-web.js uses
                        const store = window.Store;
                        if (store && store.Newsletter) {
                            const newsletters = await store.Newsletter.getSubscribed();
                            for (const nl of newsletters) {
                                result.push({
                                    id: nl.id?._serialized || nl.id,
                                    name: nl.name || nl.title || 'WhatsApp Channel',
                                });
                            }
                        }
                    } catch (e) {
                        // Newsletter access failed, ignore
                    }
                    return result;
                });
                
                // Add channels that aren't already in the list
                for (const nl of newsletterChats || []) {
                    if (nl.id && !allItems.find(c => c.id === nl.id)) {
                        allItems.push({
                            id: nl.id,
                            name: nl.name,
                            type: 'channel',
                        });
                    }
                }
            } catch (e) {
                // Newsletter store access failed, continue with regular chats
            }
            
            return allItems;
        } catch (err) {
            if (err.message.includes('Execution context was destroyed') && attempt < retries) {
                logger.warn(`listChats attempt ${attempt} failed due to navigation, retrying...`);
                await sleep(2000);
                continue;
            }
            throw err;
        }
    }
}

/**
 * Normalize WhatsApp channel ID from various formats:
 * - https://whatsapp.com/channel/0029Vb7T8V460eBW2gKeNC1x -> 0029Vb7T8V460eBW2gKeNC1x@newsletter
 * - 0029Vb7T8V460eBW2gKeNC1x -> 0029Vb7T8V460eBW2gKeNC1x@newsletter
 * - 0029Vb7T8V460eBW2gKeNC1x@newsletter -> stays the same
 * - regular chat/group ID -> stays the same
 */
function normalizeWhatsAppId(targetId) {
    if (!targetId) return targetId;

    const sanitized = String(targetId).trim().replace(/^['"]+|['"]+$/g, '');
    if (!sanitized) return sanitized;

    if (/@newsletter$/i.test(sanitized)) {
        return sanitized.replace(/@newsletter$/i, '@newsletter');
    }

    if (sanitized.includes('@')) {
        return sanitized;
    }

    const channelUrlMatch = sanitized.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([a-zA-Z0-9]+)/i);
    if (channelUrlMatch) {
        return `${channelUrlMatch[1]}@newsletter`;
    }

    if (/^120\d{10,}$/.test(sanitized)) {
        return `${sanitized}@g.us`;
    }

    if (/^[a-zA-Z0-9]{15,}$/.test(sanitized)) {
        return `${sanitized}@newsletter`;
    }

    return sanitized;
}

async function ensureTargetAvailable(client, targetId) {
    if (!targetId || resolvedTargets.has(targetId)) return;

    let lastError;

    try {
        const chat = await client.getChatById(targetId);
        if (chat) {
            resolvedTargets.add(targetId);
            return;
        }
    } catch (err) {
        lastError = err;
    }

    if (/@newsletter$/i.test(targetId)) {
        const inviteCode = targetId.replace(/@newsletter$/i, '');
        try {
            const channel = await client.getChannelByInviteCode(inviteCode);
            if (channel) {
                resolvedTargets.add(targetId);
                return;
            }
        } catch (err) {
            lastError = err;
        }
    }

    const message = `WhatsApp target ID "${targetId}" could not be resolved. Make sure it matches a chat, group, or channel you can post to.`;
    const error = new Error(message);
    if (lastError) {
        error.cause = lastError;
    }
    throw error;
}

function shouldRetrySend(err) {
    const message = err?.message || '';
    return message.includes('Execution context was destroyed') || message.includes('t: t');
}

async function sendWithRetry(client, targetId, content, options) {
    const normalizedId = normalizeWhatsAppId(targetId);
    await ensureTargetAvailable(client, normalizedId);

    try {
        return await client.sendMessage(normalizedId, content, options);
    } catch (err) {
        if (!shouldRetrySend(err)) {
            throw err;
        }
        logger.warn(`WhatsApp send failed (${err.message}). Retrying once...`);
        resolvedTargets.delete(normalizedId);
        await ensureTargetAvailable(client, normalizedId);
        return client.sendMessage(normalizedId, content, options);
    }
}

async function sendText(client, targetId, text) {
    if (!text || !text.trim()) return;
    await sendWithRetry(client, targetId, text);
}

async function sendMediaFile(client, targetId, filePath, caption) {
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const data = await fs.readFile(filePath);
    const base64 = data.toString('base64');
    const filename = path.basename(filePath);
    const media = new MessageMedia(mimeType, base64, filename);
    await sendWithRetry(client, targetId, media, { caption: caption || '' });
}

async function sendMessage(client, targetId, payload) {
    const { text, filePath, mediaType } = payload;

    if (filePath && (await fs.pathExists(filePath))) {
        try {
            const captionText = text || '';
            await sendMediaFile(client, targetId, filePath, captionText);
        } finally {
            await fs.remove(filePath).catch(() => {});
        }
        return;
    }

    if (text && text.trim()) {
        await sendText(client, targetId, text);
    }
}

module.exports = {
    createWhatsAppClient,
    listChats,
    sendMessage,
    normalizeWhatsAppId,
};
