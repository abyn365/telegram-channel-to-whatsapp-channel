import { useEffect, useState } from 'react';

export default function Home() {
  const [settings, setSettings] = useState(null);
  const [channels, setChannels] = useState([]);
  const [items, setItems] = useState([]);
  const [lastSeen, setLastSeen] = useState(null);
  const [openEmbeds, setOpenEmbeds] = useState({});
  const [theme, setTheme] = useState('dark');

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
      fetch('/api/public/forwards?limit=40').then((r) => r.json()),
    ]);
    setSettings(a);
    setChannels(b.channels || []);
    setItems(c.items || []);
    if (c.items?.[0]?.createdAt) setLastSeen(c.items[0].createdAt);
  }

  async function refresh() {
    const since = lastSeen ? `&since=${encodeURIComponent(lastSeen)}` : '';
    const data = await fetch(`/api/public/forwards?limit=40${since}`).then((r) => r.json());
    if (!data.items?.length) return;
    const full = await fetch('/api/public/forwards?limit=40').then((r) => r.json());
    setItems(full.items || []);
    setLastSeen(full.items?.[0]?.createdAt || null);
  }

  useEffect(() => {
    loadInitial();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [lastSeen]);

  return (
    <main className="wrap">
      <header className="hero card">
        <div>
          <p className="badge">Live Forwarding Dashboard</p>
          <h1>{settings?.botName || 'Forward Bot'}</h1>
          <p className="muted">{settings?.infoContent || 'Live forwarded feed.'}</p>
        </div>
        <div className="heroActions">
          <button className="btn secondary" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>Theme: {theme}</button>
          <a href="/admin" className="btn">Admin</a>
        </div>
      </header>

      <section className="card"><h2>Channels</h2><div className="chips">{channels.map((c)=><span key={c}>{c}</span>)}</div></section>
      <section className="card">
        <h2>Forwarded Feed</h2>
        <p className="muted">Auto-refresh every 10s. Click show embed to expand.</p>
        <div className="feed">
          {items.map((item) => {
            const key = item.messageKey || `${item.createdAt}-${item.messageId}`;
            const can = item.channel && item.postId;
            return (
              <article className="post" key={key}>
                <div className="postHeader"><strong>{item.channelTitle || item.channel || 'Unknown'}</strong><span className="muted">{new Date(item.createdAt).toLocaleString()}</span></div>
                <p className="postText">{item.text || '(no text)'}</p>
                {can ? <div className="postActions"><button className="btn tiny" onClick={() => setOpenEmbeds((p)=>({...p,[key]:!p[key]}))}>{openEmbeds[key] ? 'Hide embed' : 'Show embed'}</button>{item.sourceLink ? <a className="link" href={item.sourceLink} target="_blank" rel="noreferrer">Open source</a> : null}</div> : null}
                {can && openEmbeds[key] ? <div className="embedWrap"><iframe src={`https://t.me/${item.channel}/${item.postId}?embed=1&mode=tme`} title={key} loading="lazy"/></div> : null}
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
