import logger from './logger.js';

const LIBRETRANSLATE_URL = process.env.LIBRETRANSLATE_URL || 'http://127.0.0.1:5000/translate';
const TRANSLATE_TO_ID = String(process.env.TRANSLATE_TO_ID || 'true').toLowerCase() !== 'false';
const TRANSLATE_SOURCE = process.env.TRANSLATE_SOURCE || 'auto';
const TRANSLATE_TARGET = process.env.TRANSLATE_TARGET || 'id';
const TRANSLATION_PREFIX = process.env.TRANSLATION_PREFIX || 'id';
const TRANSLATION_TIMEOUT_MS = Math.max(parseInt(process.env.TRANSLATION_TIMEOUT_MS, 10) || 8000, 1000);
const TRANSLATE_USE_CAPTION_WHEN_EMPTY = String(process.env.TRANSLATE_USE_CAPTION_WHEN_EMPTY || 'true').toLowerCase() !== 'false';
const MAX_TRANSLATION_LENGTH = parseInt(process.env.MAX_TRANSLATION_LENGTH, 10) || 5000;

let hasLoggedTranslatorReady = false;
let hasWarnedTranslatorFailure = false;
let translatorHealthy = true;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;

function getTextForTranslation(rawText, captionText) {
    const raw = String(rawText || '').trim();
    if (raw) return raw;

    if (!TRANSLATE_USE_CAPTION_WHEN_EMPTY) return '';
    return String(captionText || '').trim();
}

async function parseTranslatedText(response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const data = await response.json();
        return String(data?.translatedText || '').trim();
    }

    const asText = String(await response.text()).trim();
    if (!asText) return '';

    try {
        const parsed = JSON.parse(asText);
        return String(parsed?.translatedText || '').trim();
    } catch {
        return asText;
    }
}

async function requestTranslation(text, controller, mode = 'form') {
    const common = {
        q: text,
        source: TRANSLATE_SOURCE,
        target: TRANSLATE_TARGET,
        format: 'text',
    };

    const options = {
        method: 'POST',
        signal: controller.signal,
        headers: {},
    };

    if (mode === 'json') {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(common);
    } else {
        options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        options.body = new URLSearchParams(common);
    }

    const response = await fetch(LIBRETRANSLATE_URL, options);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return parseTranslatedText(response);
}

async function translateToIndonesian(rawText, captionText = '') {
    // Skip if translation is disabled
    if (!TRANSLATE_TO_ID) return null;
    
    // Skip if translator has been unhealthy for too many consecutive failures
    if (!translatorHealthy) {
        return null;
    }

    const text = getTextForTranslation(rawText, captionText);
    if (!text) return null;

    // Skip if text is too long
    if (text.length > MAX_TRANSLATION_LENGTH) {
        logger.debug(`Skipping translation - text too long (${text.length} chars)`);
        return null;
    }

    if (!hasLoggedTranslatorReady) {
        hasLoggedTranslatorReady = true;
        logger.info(`Translation enabled → ${LIBRETRANSLATE_URL} (${TRANSLATE_SOURCE} -> ${TRANSLATE_TARGET})`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

    try {
        let translated = '';
        
        // Try form-encoded first (more compatible)
        try {
            translated = await requestTranslation(text, controller, 'form');
        } catch (formErr) {
            // Fallback to JSON
            try {
                translated = await requestTranslation(text, controller, 'json');
            } catch (jsonErr) {
                throw formErr;
            }
        }

        // Reset failure counter on success
        consecutiveFailures = 0;
        translatorHealthy = true;

        if (!translated) return null;

        // Skip if translation is identical to source
        if (translated.toLowerCase() === text.toLowerCase()) {
            return null;
        }

        return translated;
    } catch (err) {
        consecutiveFailures++;
        
        // Mark translator as unhealthy after too many failures
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            translatorHealthy = false;
            if (!hasWarnedTranslatorFailure) {
                hasWarnedTranslatorFailure = true;
                logger.warn(`Translator marked as unhealthy after ${consecutiveFailures} consecutive failures. Translation disabled until restart.`);
                logger.warn(`Ensure LibreTranslate is running: libretranslate --host 0.0.0.0 --port 5000`);
            }
        }
        
        if (!hasWarnedTranslatorFailure) {
            hasWarnedTranslatorFailure = true;
            logger.warn(`Translation failed: ${err.message || err}. Ensure LibreTranslate is running.`);
        } else {
            logger.debug(`Translation skipped: ${err.message || err}`);
        }
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

// Check if translator is available
function isTranslatorHealthy() {
    return translatorHealthy && TRANSLATE_TO_ID;
}

// Reset translator health (useful for manual intervention)
function resetTranslatorHealth() {
    consecutiveFailures = 0;
    translatorHealthy = true;
    hasWarnedTranslatorFailure = false;
    logger.info('Translator health reset');
}

export { 
    translateToIndonesian, 
    appendTranslation, 
    isTranslatorHealthy,
    resetTranslatorHealth 
};
