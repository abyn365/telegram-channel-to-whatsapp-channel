const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const mime = require('mime-types');
const path = require('path');
const logger = require('./logger');
const { execSync } = require('child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        const timeout = setTimeout(() => {
            reject(new Error('WhatsApp connection timed out after 3 minutes'));
        }, 180_000);

        client.on('qr', (qr) => {
            logger.info('WhatsApp QR code generated — scan with your phone:');
            qrcode.generate(qr, { small: true });
        });

        client.on('ready', async () => {
            clearTimeout(timeout);
            logger.info('WhatsApp userbot ready.');
            await sleep(3000);
            resolve();
        });

        client.on('auth_failure', (msg) => {
            clearTimeout(timeout);
            reject(new Error(`WhatsApp auth failure: ${msg}`));
        });

        client.on('disconnected', (reason) => {
            logger.warn(`WhatsApp disconnected: ${reason}`);
        });

        // Handle puppeteer/browser errors during initialization
        client.on('error', (error) => {
            clearTimeout(timeout);
            logger.error('WhatsApp client error during initialization:', error);
            if (error.message.includes('TargetCloseError') || error.message.includes('Session closed')) {
                reject(new Error('Browser closed unexpectedly during initialization. This may be due to resource constraints or Chrome compatibility issues. Try again or check system resources.'));
            } else {
                reject(error);
            }
        });

        client.initialize().catch((err) => {
            clearTimeout(timeout);
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
    
    // Already has @newsletter suffix, no change needed
    if (targetId.includes('@newsletter')) {
        return targetId;
    }
    
    // Check if it's a WhatsApp channel URL
    const channelUrlMatch = targetId.match(/whatsapp\.com\/channel\/([a-zA-Z0-9]+)/i);
    if (channelUrlMatch) {
        return `${channelUrlMatch[1]}@newsletter`;
    }
    
    // Check if it's a raw channel ID (alphanumeric, 15+ characters)
    // WhatsApp channel IDs are typically long alphanumeric strings
    // They can start with letters or digits
    if (/^[a-zA-Z0-9]{15,}$/.test(targetId)) {
        return `${targetId}@newsletter`;
    }
    
    return targetId;
}

async function sendText(client, targetId, text) {
    if (!text || !text.trim()) return;
    const normalizedId = normalizeWhatsAppId(targetId);
    await client.sendMessage(normalizedId, text);
}

async function sendMediaFile(client, targetId, filePath, caption) {
    const normalizedId = normalizeWhatsAppId(targetId);
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const data = await fs.readFile(filePath);
    const base64 = data.toString('base64');
    const filename = path.basename(filePath);
    const media = new MessageMedia(mimeType, base64, filename);
    await client.sendMessage(normalizedId, media, { caption: caption || '' });
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
