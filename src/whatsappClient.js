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
            return chats.map((c) => ({
                id: c.id._serialized,
                name: c.name,
                type: c.isGroup ? 'group' : c.isChannel ? 'channel' : 'chat',
            }));
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

async function sendText(client, targetId, text) {
    if (!text || !text.trim()) return;
    await client.sendMessage(targetId, text);
}

async function sendMediaFile(client, targetId, filePath, caption) {
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const data = await fs.readFile(filePath);
    const base64 = data.toString('base64');
    const filename = path.basename(filePath);
    const media = new MessageMedia(mimeType, base64, filename);
    await client.sendMessage(targetId, media, { caption: caption || '' });
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
};
