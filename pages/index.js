import { useEffect, useMemo, useState } from 'react';

const PREVIEW_LIMIT = 280;

function splitTranslatedCaption(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return { translated: '', original: '(no text)' };
  }

  const marker = /\nid\s*:\s*/i;
  const match = normalized.match(marker);
  if (!match || match.index === undefined) {
    return { translated: '', original: normalized };
  }

  const original = normalized.slice(0, match.index).trim();
  const translated = normalized.slice(match.index).replace(/^\nid\s*:\s*/i, '').trim();

  return {
    translated,
    original: original || '(translation only)',
  };
}

function truncateWithEllipsis(text = '', limit = PREVIEW_LIMIT) {
  const normalized = String(text || '').trim();
  if (normalized.length <= limit) {
    return { text: normalized, truncated: false };
  }

  const sliced = normalized.slice(0, limit);
  const breakPoint = Math.max(sliced.lastIndexOf(' '), sliced.lastIndexOf('\n'));
  const safeSlice = breakPoint > limit * 0.6 ? sliced.slice(0, breakPoint) : sliced;

  return { text: `${safeSlice.trimEnd()}…`, truncated: true };
}

export default function Home() {
  const [settings, setSettings] = useState(null);
  const [channels, setChannels] = useState([]);
  const [items, setItems] = useState([]);
  const [lastSeen, setLastSeen] = useState(null);
  const [openEmbeds, setOpenEmbeds] = useState({});
  const [theme, setTheme] = useState('dark');
  const [activeChannel, setActiveChannel] = useState('all');
  const [expandedPosts, setExpandedPosts] = useState({});

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
    document.documentElement.style.setProperty('--accent', settings?.ui?.accentColor || '#5f7cff');
    if (typeof window !== 'undefined') {
      localStorage.setItem('dashboardTheme', theme);
    }
  }, [theme, settings]);

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

  const normalizedChannels = useMemo(() => {
    const channelSet = new Set(channels.map((ch) => String(ch || '').toLowerCase()));
    items.forEach((item) => {
      if (item.channel) channelSet.add(String(item.channel).toLowerCase());
    });
    return ['all', ...Array.from(channelSet).filter(Boolean)];
  }, [channels, items]);

  const rows = useMemo(() => {
    const list = items || [];
    if (activeChannel === 'all') return list;
    return list.filter((item) => String(item.channel || '').toLowerCase() === activeChannel);
  }, [items, activeChannel]);

  const toggleTheme = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));

  return (
    <main className="wrap">
      <header className="hero card glassy">
        <div>
          <p className="badge">{settings?.ui?.badgeText || 'Live Forwarding Dashboard'}</p>
          <h1>{settings?.botName || 'Forward Bot'}</h1>
          <p className="muted">{settings?.ui?.heroSubtitle || settings?.infoContent || 'Forwarded updates from Telegram channels.'}</p>
        </div>
        <div className="heroActions">
          <button className="btn secondary" onClick={toggleTheme}>Theme: {theme}</button>
          <a href="/admin" className="btn">Admin</a>
        </div>
      </header>

      <section className="card">
        <h2>{settings?.infoTitle || 'Channels'}</h2>
        <div className="chips channelFilter">
          {normalizedChannels.map((ch) => (
            <button
              key={ch}
              className={`filterBtn ${activeChannel === ch ? 'active' : ''}`}
              onClick={() => setActiveChannel(ch)}
              type="button"
            >
              {ch === 'all' ? 'All channels' : `@${ch}`}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>{settings?.ui?.feedTitle || 'Forwarded Feed'}</h2>
        <p className="muted">{settings?.ui?.feedHint || 'Auto-refresh every 10 seconds. Indonesian translation is shown first when available.'}</p>
        <div className="feed">
          {rows.map((item) => {
            const key = item.messageKey || `${item.createdAt}-${item.messageId}`;
            const canEmbed = item.channel && item.postId;
            const isOpen = !!openEmbeds[key];
            const isExpanded = !!expandedPosts[key];
            const parsed = splitTranslatedCaption(item.text || '');
            const truncatedOriginal = truncateWithEllipsis(parsed.original);
            const truncatedTranslation = truncateWithEllipsis(parsed.translated);
            const shouldOfferExpand = truncatedOriginal.truncated || truncatedTranslation.truncated;

            return (
              <article key={key} className="post waLikeCard">
                <div className="postHeader">
                  <strong>{item.channelTitle || item.channel || 'Unknown channel'}</strong>
                  <span className="muted">{new Date(item.createdAt).toLocaleString()}</span>
                </div>

                <button
                  className="messagePreview"
                  type="button"
                  onClick={() => setExpandedPosts((prev) => ({ ...prev, [key]: !prev[key] }))}
                >
                  {parsed.translated ? (
                    <div className="translationBlock">
                      <p className="translationLabel">🇮🇩 Indonesian translation</p>
                      <p className="postText translationText">{isExpanded ? parsed.translated : truncatedTranslation.text}</p>
                    </div>
                  ) : null}

                  <div className="waOriginal">
                    <p className="translationLabel">Original message</p>
                    <p className="postText">{isExpanded ? parsed.original : truncatedOriginal.text}</p>
                  </div>

                  {shouldOfferExpand ? (
                    <span className="readMore">{isExpanded ? 'Show less' : 'Tap for full details'}</span>
                  ) : (
                    <span className="readMore">Tap to collapse/expand</span>
                  )}
                </button>

                {canEmbed ? (
                  <div className="postActions">
                    <button className="btn tiny secondary" onClick={() => setOpenEmbeds((prev) => ({ ...prev, [key]: !prev[key] }))}>
                      {isOpen ? 'Hide source embed' : 'Show source embed'}
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
          {!rows.length ? <p className="muted">No items for this channel yet.</p> : null}
        </div>
      </section>

      <footer className="footer muted">{settings?.ui?.footerText || settings?.contact || ''}</footer>
    </main>
  );
}
