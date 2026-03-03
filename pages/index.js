import { useEffect, useMemo, useState } from 'react';

export default function Home() {
  const [settings, setSettings] = useState(null);
  const [channels, setChannels] = useState([]);
  const [items, setItems] = useState([]);
  const [lastSeen, setLastSeen] = useState(null);

  const theme = settings?.theme || 'dark';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
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
    if (forwardsData.items?.[0]?.createdAt) {
      setLastSeen(forwardsData.items[0].createdAt);
    }
  };

  const refresh = async () => {
    const url = `/api/public/forwards?limit=40${lastSeen ? `&since=${encodeURIComponent(lastSeen)}` : ''}`;
    const res = await fetch(url);
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

  const embedRows = useMemo(() => items.filter((it) => it.channel && it.postId), [items]);

  return (
    <main className="wrap">
      <header className="topbar">
        <h1>{settings?.botName || 'Forward Bot'}</h1>
        <div className="buttons">
          <a href="/admin" className="btn">Admin</a>
        </div>
      </header>

      <section className="card">
        <h2>{settings?.infoTitle || 'Info'}</h2>
        <p>{settings?.infoContent}</p>
        <p className="muted">Contact: {settings?.contact || '-'}</p>
      </section>

      <section className="card">
        <h2>Channels</h2>
        <div className="chips">{channels.map((ch) => <span key={ch}>{ch}</span>)}</div>
      </section>

      <section className="card">
        <h2>Live Telegram Preview</h2>
        <p className="muted">Auto-refresh every 10 seconds from Upstash KV/Redis.</p>

        <div className="feed">
          {items.map((item) => (
            <article key={item.messageKey || `${item.createdAt}-${item.messageId || Math.random()}`} className="post">
              <p><strong>{item.channelTitle || item.channel || 'Unknown channel'}</strong> · {new Date(item.createdAt).toLocaleString()}</p>
              <p>{item.text || ''}</p>
            </article>
          ))}
        </div>

        <div className="feed">
          {embedRows.map((item) => (
            <TelegramEmbed key={`embed-${item.messageKey}`} channel={item.channel} postId={item.postId} />
          ))}
        </div>
      </section>
    </main>
  );
}

function TelegramEmbed({ channel, postId }) {
  useEffect(() => {
    if (!window.Telegram?.Post) {
      const script = document.createElement('script');
      script.src = 'https://telegram.org/js/telegram-widget.js?23';
      script.async = true;
      document.body.appendChild(script);
    }
  }, []);

  return (
    <blockquote
      className="telegram-post"
      data-telegram-post={`${channel}/${postId}`}
      data-width="100%"
    />
  );
}
