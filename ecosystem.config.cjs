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
            max_memory_restart: '500M',
            restart_delay: 5000,
            exp_backoff_restart_delay: true,
            max_restarts: 10,
            kill_timeout: 5000,
            wait_ready: true,
            listen_timeout: 10000,
            env: {
                NODE_ENV: 'production',
            },
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            out_file: './logs/pm2-translator-out.log',
            error_file: './logs/pm2-translator-error.log',
            merge_logs: true,
            combine_logs: true,
            time: true,
        },
        {
            name: 'tg-wa-forwarder',
            script: './src/index.js',
            cwd: __dirname,
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '500M',
            restart_delay: 5000,
            exp_backoff_restart_delay: true,
            max_restarts: 10,
            kill_timeout: 10000,
            wait_ready: false,
            env: {
                NODE_ENV: 'production',
            },
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            out_file: './logs/pm2-out.log',
            error_file: './logs/pm2-error.log',
            merge_logs: true,
            combine_logs: true,
            time: true,
            // Cron restart for periodic health (optional)
            // cron_restart: '0 4 * * *', // Restart at 4 AM daily
        },
    ],
};
