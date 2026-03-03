import { useEffect, useMemo, useState } from 'react';

function parsePriorityTranslation(text = '') {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const idIndex = lines.findIndex((line) => /^id\s*:/i.test(line));
  if (idIndex === -1) return { priority: '', original: text || '(no text)' };

  const priority = lines[idIndex].replace(/^id\s*:/i, '').trim();
  const original = lines.filter((_, index) => index !== idIndex).join('\n').trim();
  return {
    priority,
    original: original || '(translation only)',
  };
}

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
    if (settings?.theme && !localStorage.getItem('dashboardTheme')) {
      setTheme(settings.theme);
    }
  }, [settings]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (typeof window !== 'undefined') {
      localStorage.setItem('dashboardTheme', theme);
    }
  }, [theme]);

  const loadInitial = async () => {
    const [settingsRes, channelsRes, forwardsRes] = await Promise.all([
      fetch('/api/public/settings'),
      fetch('/api/public/channels'),
      fetch('/api/public/forwards?limit=40'),
    ]);

    const settingsData = await settingsRes.json();
    const channelsData = await channelsRes.json();
    const forwardsData = await forwardsRes.json();

    setSettings(settingsData);
    setChannels(channelsData.channels || []);
    setItems(forwardsData.items || []);
    if (forwardsData.items?.[0]?.createdAt) setLastSeen(forwardsData.items[0].createdAt);
  };

  const refresh = async () => {
    const since = lastSeen ? `&since=${encodeURIComponent(lastSeen)}` : '';
    const res = await fetch(`/api/public/forwards?limit=40${since}`);
    const data = await res.json();
    if (!data.items?.length) return;

    const full = await (await fetch('/api/public/forwards?limit=40')).json();
    setItems(full.items || []);
    setLastSeen(full.items?.[0]?.createdAt || null);
  };

  useEffect(() => {
    loadInitial();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [lastSeen]);

  const toggleTheme = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));

  const rows = useMemo(() => items || [], [items]);

  return (
    <main className="wrap">
      <header className="hero card">
        <div>
          <p className="badge">Live Forwarding Dashboard</p>
          <h1>{settings?.botName || 'Forward Bot'}</h1>
          <p className="muted">{settings?.infoContent || 'Forwarded updates from Telegram channels.'}</p>
        </div>
        <div className="heroActions">
          <button className="btn secondary" onClick={toggleTheme}>Theme: {theme}</button>
          <a href="/admin" className="btn">Admin</a>
        </div>
      </header>

      <section className="card">
        <h2>Channels</h2>
        <div className="chips">{channels.map((ch) => <span key={ch}>{ch}</span>)}</div>
      </section>

      <section className="card">
        <h2>Forwarded Feed</h2>
        <p className="muted">Auto-refresh every 10 seconds. Click "Show embed" to expand Telegram preview inline.</p>
        <div className="feed">
          {rows.map((item) => {
            const key = item.messageKey || `${item.createdAt}-${item.messageId}`;
            const canEmbed = item.channel && item.postId;
            const isOpen = !!openEmbeds[key];
            const parsed = parsePriorityTranslation(item.text || '');
            return (
              <article key={key} className="post">
                <div className="postHeader">
                  <strong>{item.channelTitle || item.channel || 'Unknown channel'}</strong>
                  <span className="muted">{new Date(item.createdAt).toLocaleString()}</span>
                </div>
                {parsed.priority ? (
                  <div className="translationBlock">
                    <p className="translationLabel">🇮🇩 Indonesian (prioritized)</p>
                    <p className="postText translationText">{parsed.priority}</p>
                    <details>
                      <summary>Show original message</summary>
                      <p className="postText">{parsed.original}</p>
                    </details>
                  </div>
                ) : (
                  <p className="postText">{parsed.original}</p>
                )}
                {canEmbed ? (
                  <div className="postActions">
                    <button className="btn tiny" onClick={() => setOpenEmbeds((prev) => ({ ...prev, [key]: !prev[key] }))}>
                      {isOpen ? 'Hide embed' : 'Show embed'}
                    </button>
                    {item.sourceLink ? <a className="link" href={item.sourceLink} target="_blank" rel="noreferrer">Open source</a> : null}
                  </div>
                ) : null}

                {isOpen && canEmbed ? (
                  <div className="embedWrap">
                    <iframe
                      title={`telegram-${key}`}
                      src={`https://t.me/${item.channel}/${item.postId}?embed=1&mode=tme`}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
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
