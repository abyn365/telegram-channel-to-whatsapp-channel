import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { combine, timestamp, printf, colorize, errors, json, splat } = winston.format;

// Custom log format for console
const consoleLogFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
    let output = `${timestamp} [${level}]: ${stack || message}`;
    
    // Add metadata if present
    const metaKeys = Object.keys(metadata);
    if (metaKeys.length > 0 && level === 'debug') {
        output += ` ${JSON.stringify(metadata)}`;
    }
    
    return output;
});

// File format - structured JSON for easier parsing
const fileLogFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
    return JSON.stringify({
        timestamp,
        level,
        message: stack || message,
        ...metadata,
    });
});

// Determine log level from environment
const logLevel = process.env.LOG_LEVEL || 'info';

// Create transports array
const transports = [
    // Console transport with colors
    new winston.transports.Console({
        format: combine(
            colorize(),
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            errors({ stack: true }),
            splat(),
            consoleLogFormat
        ),
        handleExceptions: true,
        handleRejections: true,
    }),
    
    // Error log file
    new winston.transports.File({
        filename: path.join(__dirname, '../logs/error.log'),
        level: 'error',
        format: combine(
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            errors({ stack: true }),
            fileLogFormat
        ),
        maxsize: 10 * 1024 * 1024, // 10 MB
        maxFiles: 5,
        tailable: true,
    }),
    
    // Combined log file (all levels)
    new winston.transports.File({
        filename: path.join(__dirname, '../logs/combined.log'),
        format: combine(
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            errors({ stack: true }),
            fileLogFormat
        ),
        maxsize: 50 * 1024 * 1024, // 50 MB
        maxFiles: 10,
        tailable: true,
    }),
];

// Create the logger
const logger = winston.createLogger({
    level: logLevel,
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        errors({ stack: true }),
        splat(),
    ),
    transports,
    exitOnError: false,
});

// Add a simple performance tracking utility
const performanceMarks = new Map();

logger.startTimer = (label) => {
    performanceMarks.set(label, Date.now());
};

logger.endTimer = (label) => {
    const start = performanceMarks.get(label);
    if (start) {
        const elapsed = Date.now() - start;
        performanceMarks.delete(label);
        logger.debug(`Timer [${label}]: ${elapsed}ms`);
        return elapsed;
    }
    return null;
};

// Log startup information
logger.info(`Logger initialized with level: ${logLevel}`);

export default logger;
