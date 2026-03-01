import logger from './logger.js';

const LIBRETRANSLATE_URL = process.env.LIBRETRANSLATE_URL || 'http://127.0.0.1:5000/translate';
const TRANSLATE_TO_ID = String(process.env.TRANSLATE_TO_ID || 'true').toLowerCase() !== 'false';
const TRANSLATE_SOURCE = process.env.TRANSLATE_SOURCE || 'auto';
const TRANSLATE_TARGET = process.env.TRANSLATE_TARGET || 'id';
const TRANSLATION_PREFIX = process.env.TRANSLATION_PREFIX || 'id';
const TRANSLATION_TIMEOUT_MS = Math.max(parseInt(process.env.TRANSLATION_TIMEOUT_MS, 10) || 8000, 1000);

async function translateToIndonesian(text) {
    if (!TRANSLATE_TO_ID) return null;
    if (!text || !text.trim()) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

    try {
        const body = new URLSearchParams({
            q: text,
            source: TRANSLATE_SOURCE,
            target: TRANSLATE_TARGET,
            format: 'text',
        });

        const response = await fetch(LIBRETRANSLATE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
            signal: controller.signal,
        });

        if (!response.ok) {
            logger.warn(`Translation API returned ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json();
        const translated = String(data?.translatedText || '').trim();
        if (!translated) return null;

        if (translated.toLowerCase() === text.trim().toLowerCase()) {
            return null;
        }

        return translated;
    } catch (err) {
        logger.debug(`Translation skipped: ${err.message || err}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function appendTranslation(baseText, translatedText) {
    if (!translatedText) return baseText;
    const prefix = TRANSLATION_PREFIX.endsWith(':') ? TRANSLATION_PREFIX : `${TRANSLATION_PREFIX}:`;
    return `${baseText}\n${prefix} ${translatedText}`;
}

export { translateToIndonesian, appendTranslation };
