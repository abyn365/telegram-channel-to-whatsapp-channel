const path = require('path');

module.exports = {
    apps: [
        {
            name: 'tg-wa-translator',
            script: 'bash',
            args: './scripts/run-libretranslate.sh',
            cwd: __dirname,
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '300M',
            restart_delay: 5000,
            env: {
                NODE_ENV: 'production',
            },
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            out_file: './logs/pm2-translator-out.log',
            error_file: './logs/pm2-translator-error.log',
            merge_logs: true,
        },
        {
            name: 'tg-wa-forwarder',
            script: './src/index.js',
            cwd: __dirname,
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '300M',
            restart_delay: 5000,
            env: {
                NODE_ENV: 'production',
            },
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            out_file: './logs/pm2-out.log',
            error_file: './logs/pm2-error.log',
            merge_logs: true,
        },
    ],
};
