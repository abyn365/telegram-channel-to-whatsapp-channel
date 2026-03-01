const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const logger = require('./logger');

function parseMaybeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function request(baseUrl, method, endpoint, body) {
    const url = `${baseUrl.replace(/\/$/, '')}${endpoint}`;
    const res = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    const rawText = await res.text();
    const data = parseMaybeJson(rawText);

    if (!res.ok) {
        const message = typeof data === 'string' ? data : JSON.stringify(data);
        throw new Error(`WAHA request failed ${method} ${endpoint}: ${res.status} ${message}`);
    }

    return data;
}

async function requestFirst(baseUrl, method, endpoints, body) {
    let lastError;
    for (const endpoint of endpoints) {
        try {
            return await request(baseUrl, method, endpoint, body);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

async function createWahaClient() {
    const baseUrl = process.env.WAHA_BASE_URL || 'http://127.0.0.1:3000/api';
    const session = process.env.WAHA_SESSION || 'default';

    logger.info(`Using WAHA provider (${baseUrl}, session=${session})`);

    const sessionPrefix = [`/sessions/${session}`, `/session/${session}`];

    const client = {
        __provider: 'waha',
        __baseUrl: baseUrl,
        __session: session,

        async getChats() {
            const data = await requestFirst(baseUrl, 'GET', [
                `${sessionPrefix[0]}/chats`,
                `${sessionPrefix[1]}/chats`,
                '/chats',
            ]);

            const chats = Array.isArray(data) ? data : (Array.isArray(data?.chats) ? data.chats : []);

            return chats.map((chat) => {
                const id = chat.id || chat.chatId || chat._id || chat?.jid || '';
                const name = chat.name || chat.title || chat.pushName || id;
                const isGroup = Boolean(chat.isGroup || String(id).endsWith('@g.us'));
                return {
                    id: { _serialized: id },
                    name,
                    isGroup,
                };
            });
        },

        async getChatById(chatId) {
            const chats = await this.getChats();
            const found = chats.find((c) => c.id._serialized === chatId);
            if (!found) {
                throw new Error(`Chat ${chatId} not found in WAHA session`);
            }
            return found;
        },

        async getChannels() {
            const chats = await this.getChats();
            return chats
                .filter((c) => String(c.id._serialized).includes('@newsletter'))
                .map((c) => ({
                    id: c.id,
                    name: c.name,
                }));
        },

        async sendText(chatId, text) {
            await requestFirst(baseUrl, 'POST', [
                `${sessionPrefix[0]}/messages/text`,
                `${sessionPrefix[1]}/messages/text`,
                '/messages/text',
            ], {
                chatId,
                text,
                session,
            });
            return true;
        },

        async sendMedia(chatId, filePath, caption = '') {
            const data = await fs.readFile(filePath);
            const filename = path.basename(filePath);
            const mimetype = mime.lookup(filePath) || 'application/octet-stream';
            const file = `data:${mimetype};base64,${data.toString('base64')}`;

            await requestFirst(baseUrl, 'POST', [
                `${sessionPrefix[0]}/messages/media`,
                `${sessionPrefix[1]}/messages/media`,
                '/messages/media',
            ], {
                chatId,
                file,
                filename,
                caption,
                session,
            });
            return true;
        },

        async sendMessage(chatId, content, options = {}) {
            if (typeof content === 'string') {
                return this.sendText(chatId, content);
            }

            if (content?.data) {
                await requestFirst(baseUrl, 'POST', [
                    `${sessionPrefix[0]}/messages/media`,
                    `${sessionPrefix[1]}/messages/media`,
                    '/messages/media',
                ], {
                    chatId,
                    file: `data:${content.mimetype || 'application/octet-stream'};base64,${content.data}`,
                    filename: content.filename || 'file',
                    caption: options.caption || '',
                    session,
                });
                return true;
            }

            throw new Error('Unsupported WAHA message content');
        },

        async subscribeToChannel() {
            throw new Error('WAHA does not support subscribeToChannel in this project. Follow channel manually in WhatsApp app.');
        },

        async getChannelByInviteCode() {
            throw new Error('WAHA does not expose getChannelByInviteCode in this project.');
        },

        async destroy() {
            return true;
        },
    };

    return client;
}

module.exports = {
    createWahaClient,
};
