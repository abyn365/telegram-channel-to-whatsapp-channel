import { useEffect, useMemo, useState } from 'react';

const REFRESH_SECONDS = 10;

function formatPreview(text = '', max = 200) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '(no text)';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

export default function Home() {
  const [settings, setSettings] = useState(null);
  const [channels, setChannels] = useState([]);
  const [items, setItems] = useState([]);
  const [lastSeen, setLastSeen] = useState(null);
  const [openEmbeds, setOpenEmbeds] = useState({});
  const [theme, setTheme] = useState('dark');
  const [refreshIn, setRefreshIn] = useState(REFRESH_SECONDS);
  const [lastUpdateAt, setLastUpdateAt] = useState(null);

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem('dashboardTheme') : null;
    if (stored) setTheme(stored);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('dashboardTheme', theme);
  }, [theme]);

  async function loadInitial() {
    const [a, b, c] = await Promise.all([
      fetch('/api/public/settings').then((r) => r.json()),
      fetch('/api/public/channels').then((r) => r.json()),
      fetch('/api/public/cards?limit=40').then((r) => r.json()),
    ]);
    setSettings(a);
    setChannels(b.channels || []);
    setItems(c.cards || []);
    setLastUpdateAt(new Date());
    setRefreshIn(REFRESH_SECONDS);
    if (c.cards?.[0]?.createdAt) setLastSeen(c.cards[0].createdAt);
  }

  async function refresh() {
    const since = lastSeen ? `&since=${encodeURIComponent(lastSeen)}` : '';
    const data = await fetch(`/api/public/cards?limit=40${since}`).then((r) => r.json());
    if (data.cards?.length) {
      const full = await fetch('/api/public/cards?limit=40').then((r) => r.json());
      setItems(full.cards || []);
      setLastSeen(full.cards?.[0]?.createdAt || null);
    }
    setLastUpdateAt(new Date());
    setRefreshIn(REFRESH_SECONDS);
  }

  useEffect(() => {
    loadInitial();
    const refreshTimer = setInterval(refresh, REFRESH_SECONDS * 1000);
    const countdownTimer = setInterval(() => {
      setRefreshIn((v) => (v <= 1 ? REFRESH_SECONDS : v - 1));
    }, 1000);
    return () => {
      clearInterval(refreshTimer);
      clearInterval(countdownTimer);
    };
  }, [lastSeen]);

  const totalItems = useMemo(() => items.length, [items]);

  return (
    <main className="wrap">
      <header className="hero card">
        <div>
          <p className="badge">Live Forwarding Dashboard</p>
          <h1>{settings?.botName || 'Forward Bot'}</h1>
          <p className="muted">{settings?.infoContent || 'Live forwarded feed.'}</p>
          <div className="statusRow">
            <span className="statusPill">Items: {totalItems}</span>
            <span className="statusPill">Channels: {channels.length}</span>
            <span className="statusPill">Next update in {refreshIn}s</span>
            <span className="statusPill">Last update: {lastUpdateAt ? lastUpdateAt.toLocaleTimeString() : '-'}</span>
          </div>
        </div>
        <div className="heroActions">
          <button className="btn secondary" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>Theme: {theme}</button>
          <a href="/admin" className="btn">Admin</a>
        </div>
      </header>

      <section className="card">
        <h2>Channels</h2>
        <div className="chips">{channels.map((c) => <span key={c}>{c}</span>)}</div>
      </section>

      <section className="card">
        <h2>Forwarded Feed</h2>
        <p className="muted">Text preview is shortened. Open embed to see details from Telegram.</p>
        <div className="feed">
          {items.map((item) => {
            const key = item.messageKey || `${item.createdAt}-${item.messageId}`;
            const can = item.embed?.channel && item.embed?.postId;
            return (
              <article className="post" key={key}>
                <div className="postHeader">
                  <strong>{item.channelTitle || item.channel || 'Unknown'}</strong>
                  <span className="muted">{new Date(item.createdAt).toLocaleString()}</span>
                </div>
                <div className="metaRow"><span className="mediaBadge">{(item.previewType || item.mediaType || 'text').toUpperCase()}</span></div><p className="postText">{formatPreview(item.caption || item.text, 220)}</p>
                {can ? (
                  <div className="postActions">
                    <button className="btn tiny" onClick={() => setOpenEmbeds((p) => ({ ...p, [key]: !p[key] }))}>
                      {openEmbeds[key] ? 'Hide embed' : 'Open embed to see details'}
                    </button>
                    {item.sourceLink ? <a className="link" href={item.sourceLink} target="_blank" rel="noreferrer">Open source</a> : null}
                  </div>
                ) : (
                  <p className="muted small">Embed unavailable for this item.</p>
                )}
                {can && openEmbeds[key] ? (
                  <div className="embedWrap">
                    <iframe src={`https://t.me/${item.embed.channel}/${item.embed.postId}?embed=1&mode=tme`} title={key} loading="lazy" />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
