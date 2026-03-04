import { NextResponse } from 'next/server';

const isProd = process.env.NODE_ENV === 'production';
const scriptSrc = isProd
  ? "script-src 'self' 'unsafe-inline' https://telegram.org https://vercel.live;"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://telegram.org https://vercel.live;";

export function middleware() {
  const response = NextResponse.next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set(
    'Content-Security-Policy',
    `default-src 'self' https://telegram.org; ${scriptSrc} style-src 'self' 'unsafe-inline'; connect-src 'self' https://vercel.live; img-src 'self' data: https:; frame-src https://t.me https://telegram.org;`
  );
  return response;
}

export const config = { matcher: '/:path*' };
