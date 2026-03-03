# Telegram → WhatsApp Forwarder (Bot) + Separate Vercel Dashboard

This repository now contains **two separate entities**:

1. **Forwarder bot** (root project): Telegram → WhatsApp forwarding worker.
2. **Dashboard app** (`dashboard/`): Next.js UI/API for live feed/admin, deployable to Vercel.

The bridge between them is **Upstash Redis REST**.

## Architecture
- Bot writes forwarded previews/channels/settings references to Upstash keys:
  - `dashboard:forwards`
  - `dashboard:channels`
  - `dashboard:settings`
  - `dashboard:admin`
- Dashboard reads/writes those keys directly from Vercel serverless API routes.
- Bot no longer depends on embedded dashboard runtime.

## Bot Setup (root)
```bash
npm install
cp .env.example .env
# edit .env
npm start
```

### Required Bot Env
```env
TELEGRAM_ACCOUNTS_JSON=[{"apiId":12345678,"apiHash":"abcdef1234567890abcdef1234567890","phone":"+1234567890"}]
TELEGRAM_CHANNELS=@channel1,@channel2
WHATSAPP_TARGET_ID=120363xxxxxxxxxx@newsletter
UPSTASH_REDIS_REST_URL=https://<your-instance>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<your-token>
```

### Forwarding Tips
- `NEWSLETTER_MEDIA_MODE=ddl` is recommended for WhatsApp channels.
- Valid values: `ddl`, `try`, `native` (avoid typo `hybird`).

## Dashboard Setup (separate app)
```bash
cd dashboard
npm install
npm run dev
```

### Dashboard Env (Vercel)
Set these in Vercel Project Settings → Environment Variables:
```env
UPSTASH_REDIS_REST_URL=https://<your-instance>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<your-token>
JWT_SECRET=replace-with-long-random-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeThisNow123!
NEXT_TELEMETRY_DISABLED=1
```

### Deploy Dashboard to Vercel
- Import the `dashboard/` folder as a Vercel project (or set Root Directory to `dashboard`).
- Framework: Next.js.
- Add env vars above.
- Deploy.

## Live Updates
- Dashboard polls `/api/public/forwards` every 10s.
- New forwards appear in feed quickly after bot writes to Upstash.
- Each item shows forwarded text first, then click-to-expand Telegram embed.

## PM2 (Bot)
```bash
npm run start:pm2
npm run logs:pm2
npm run restart:pm2
npm run stop:pm2
```

## Common Warnings
- `OSError: [Errno 98] Address already in use` (LibreTranslate): usually means instance already running.
- `RequestsDependencyWarning`: usually non-fatal.
- `globalThis.crypto.subtle` issue is patched via `src/webcryptoPolyfill.js`.

## License
GPL-3.0
