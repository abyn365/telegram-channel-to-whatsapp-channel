# Dashboard (Vercel)

Standalone Next.js dashboard for Telegram→WhatsApp forwarder data.

## Run locally
```bash
npm install
npm run dev
```

## Required env
```env
UPSTASH_REDIS_REST_URL=https://<your-instance>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<your-token>
JWT_SECRET=replace-with-long-random-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeThisNow123!
NEXT_TELEMETRY_DISABLED=1
```

## Deploy
- Deploy this folder to Vercel.
- Ensure env vars are set.
