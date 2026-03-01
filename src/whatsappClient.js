const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const mime = require('mime-types');
const path = require('path');
const logger = require('./logger');

async function createWhatsAppClient() {
    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(__dirname, '../sessions/whatsapp'),
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
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

        client.on('ready', () => {
            clearTimeout(timeout);
            logger.info('WhatsApp userbot ready.');
            resolve();
        });

        client.on('auth_failure', (msg) => {
            clearTimeout(timeout);
            reject(new Error(`WhatsApp auth failure: ${msg}`));
        });

        client.on('disconnected', (reason) => {
            logger.warn(`WhatsApp disconnected: ${reason}`);
        });

        client.initialize().catch(reject);
    });

    return client;
}

async function listChats(client) {
    const chats = await client.getChats();
    return chats.map((c) => ({
        id: c.id._serialized,
        name: c.name,
        type: c.isGroup ? 'group' : c.isChannel ? 'channel' : 'chat',
    }));
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
