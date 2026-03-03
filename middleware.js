import { NextResponse } from 'next/server';

export function middleware(req) {
  const response = NextResponse.next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self' https://telegram.org; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; frame-src https://t.me https://telegram.org;"
  );
  return response;
}

export const config = {
  matcher: '/:path*',
};
