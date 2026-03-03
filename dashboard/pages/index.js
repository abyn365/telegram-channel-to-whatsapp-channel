import { useEffect, useMemo, useState } from 'react';

const REFRESH_SECONDS = 10;

function formatPreview(text = '', max = 220) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '(no text)';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

function formatTime(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
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
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState('all');
  const [mediaFilter, setMediaFilter] = useState('all');
  const [compactMode, setCompactMode] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const storedTheme = typeof window !== 'undefined' ? localStorage.getItem('dashboardTheme') : null;
    const storedCompact = typeof window !== 'undefined' ? localStorage.getItem('dashboardCompactMode') : null;
    if (storedTheme) setTheme(storedTheme);
    if (storedCompact) setCompactMode(storedCompact === '1');
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('dashboardTheme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('dashboardCompactMode', compactMode ? '1' : '0');
  }, [compactMode]);

  async function loadInitial() {
    setIsLoading(true);
    const [settingsRes, channelsRes, cardsRes] = await Promise.all([
      fetch('/api/public/settings').then((r) => r.json()),
      fetch('/api/public/channels').then((r) => r.json()),
      fetch('/api/public/cards?limit=50').then((r) => r.json()),
    ]);

    const cards = cardsRes.cards || [];
    setSettings(settingsRes);
    setChannels(channelsRes.channels || []);
    setItems(cards);
    setLastUpdateAt(new Date());
    setRefreshIn(REFRESH_SECONDS);
    setLastSeen(cards[0]?.createdAt || null);
    setIsLoading(false);
  }

  async function refresh() {
    const since = lastSeen ? `&since=${encodeURIComponent(lastSeen)}` : '';
    const deltaRes = await fetch(`/api/public/cards?limit=50${since}`).then((r) => r.json());
    if (deltaRes.cards?.length) {
      const fullRes = await fetch('/api/public/cards?limit=50').then((r) => r.json());
      const next = fullRes.cards || [];
      setItems(next);
      setLastSeen(next[0]?.createdAt || null);
    }
    setLastUpdateAt(new Date());
    setRefreshIn(REFRESH_SECONDS);
  }

  useEffect(() => {
    loadInitial();
  }, []);

  useEffect(() => {
    if (isLoading) return undefined;
    const refreshTimer = setInterval(refresh, REFRESH_SECONDS * 1000);
    const countdownTimer = setInterval(() => {
      setRefreshIn((v) => (v <= 1 ? REFRESH_SECONDS : v - 1));
    }, 1000);

    return () => {
      clearInterval(refreshTimer);
      clearInterval(countdownTimer);
    };
  }, [isLoading, lastSeen]);

  const mediaOptions = useMemo(() => {
    const all = new Set(items.map((item) => (item.previewType || item.mediaType || 'text').toLowerCase()));
    return ['all', ...Array.from(all)];
  }, [items]);

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      const channelName = (item.channelTitle || item.channel || '').toLowerCase();
      const text = (item.caption || item.text || '').toLowerCase();
      const type = (item.previewType || item.mediaType || 'text').toLowerCase();

      const channelMatch = channelFilter === 'all' || channelName === channelFilter.toLowerCase();
      const mediaMatch = mediaFilter === 'all' || type === mediaFilter;
      const textMatch = !term || text.includes(term) || channelName.includes(term);

      return channelMatch && mediaMatch && textMatch;
    });
  }, [items, search, channelFilter, mediaFilter]);

  const stats = useMemo(() => {
    const mediaBreakdown = items.reduce((acc, item) => {
      const type = (item.previewType || item.mediaType || 'text').toLowerCase();
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});

    const topMedia = Object.entries(mediaBreakdown).sort((a, b) => b[1] - a[1])[0];

    return {
      totalItems: items.length,
      visibleItems: filteredItems.length,
      channels: channels.length,
      newest: items[0]?.createdAt,
      topMedia: topMedia ? `${topMedia[0]} (${topMedia[1]})` : 'n/a',
    };
  }, [items, filteredItems.length, channels.length]);

  return (
    <main className="wrap">
      <header className="hero card">
        <div>
          <p className="badge">Live Forwarding Dashboard</p>
          <h1>{settings?.botName || 'Forward Bot'}</h1>
          <p className="muted">{settings?.infoContent || 'Live forwarded feed with rich filtering and monitoring.'}</p>
          <div className="statusRow">
            <span className="statusPill">Auto refresh in {refreshIn}s</span>
            <span className="statusPill">Updated {lastUpdateAt ? lastUpdateAt.toLocaleTimeString() : '-'}</span>
            <span className="statusPill">Newest {formatTime(stats.newest)}</span>
          </div>
        </div>
        <div className="heroActions">
          <button className="btn secondary" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
            Theme: {theme}
          </button>
          <button className="btn secondary" onClick={() => setCompactMode((v) => !v)}>
            {compactMode ? 'Comfort mode' : 'Compact mode'}
          </button>
          <a href="/admin" className="btn">Admin</a>
        </div>
      </header>

      <section className="statsGrid">
        <article className="card statCard">
          <p className="muted">Total feed items</p>
          <h3>{stats.totalItems}</h3>
        </article>
        <article className="card statCard">
          <p className="muted">Visible after filters</p>
          <h3>{stats.visibleItems}</h3>
        </article>
        <article className="card statCard">
          <p className="muted">Active channels</p>
          <h3>{stats.channels}</h3>
        </article>
        <article className="card statCard">
          <p className="muted">Top media type</p>
          <h3>{stats.topMedia}</h3>
        </article>
      </section>

      <section className="card">
        <div className="sectionHeader">
          <h2>Filters</h2>
          <button className="btn tiny secondary" onClick={() => { setSearch(''); setChannelFilter('all'); setMediaFilter('all'); }}>
            Reset
          </button>
        </div>
        <div className="filtersGrid">
          <label>
            Search
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search text or channel" />
          </label>
          <label>
            Channel
            <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
              <option value="all">All channels</option>
              {channels.map((channel) => (
                <option key={channel} value={channel}>{channel}</option>
              ))}
            </select>
          </label>
          <label>
            Media
            <select value={mediaFilter} onChange={(e) => setMediaFilter(e.target.value)}>
              {mediaOptions.map((media) => (
                <option key={media} value={media}>{media === 'all' ? 'All types' : media.toUpperCase()}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Tracked Channels</h2>
        <div className="chips">{channels.length ? channels.map((c) => <span key={c}>{c}</span>) : <span>No channels configured.</span>}</div>
      </section>

      <section className="card">
        <div className="sectionHeader">
          <h2>Forwarded Feed</h2>
          <p className="muted">Click a card to expand Telegram embed when available.</p>
        </div>
        <div className={`feed ${compactMode ? 'compact' : ''}`}>
          {filteredItems.map((item) => {
            const key = item.messageKey || `${item.createdAt}-${item.messageId}`;
            const canEmbed = item.embed?.channel && item.embed?.postId;

            return (
              <article className="post" key={key}>
                <div className="postHeader">
                  <strong>{item.channelTitle || item.channel || 'Unknown channel'}</strong>
                  <span className="muted">{formatTime(item.createdAt)}</span>
                </div>
                <div className="metaRow">
                  <span className="mediaBadge">{(item.previewType || item.mediaType || 'text').toUpperCase()}</span>
                  {item.sourceLink ? (
                    <a className="link" href={item.sourceLink} target="_blank" rel="noreferrer">Source</a>
                  ) : null}
                </div>
                <p className="postText">{formatPreview(item.caption || item.text, compactMode ? 140 : 240)}</p>
                {canEmbed ? (
                  <button className="btn tiny" onClick={() => setOpenEmbeds((p) => ({ ...p, [key]: !p[key] }))}>
                    {openEmbeds[key] ? 'Hide embed' : 'Show embed'}
                  </button>
                ) : (
                  <p className="muted small">Embed unavailable for this item.</p>
                )}
                {canEmbed && openEmbeds[key] ? (
                  <div className="embedWrap">
                    <iframe src={`https://t.me/${item.embed.channel}/${item.embed.postId}?embed=1&mode=tme`} title={key} loading="lazy" />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
        {!filteredItems.length ? <p className="muted">No feed items match your filters.</p> : null}
      </section>
    </main>
  );
}
