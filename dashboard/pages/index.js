import Head from 'next/head';
import { useEffect, useMemo, useState } from 'react';
import Squares from '../components/Squares';

const REFRESH_SECONDS = 10;
const PAGE_SIZE = 50;

function formatPreview(text = '', max = 220) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .trim();
  if (!normalized) return '(no text)';
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function formatTime(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function getItemType(item) {
  return (item.previewType || item.mediaType || 'text').toLowerCase();
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [expandedItems, setExpandedItems] = useState({});
  const [hasMoreItems, setHasMoreItems] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

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

  async function fetchCards({ limit = PAGE_SIZE, offset = 0, since = '' } = {}) {
    const search = new URLSearchParams({ limit: String(limit) });
    if (offset > 0) search.set('offset', String(offset));
    if (since) search.set('since', since);
    return fetch(`/api/public/cards?${search.toString()}`).then((r) => r.json());
  }

  async function loadInitial() {
    setIsLoading(true);
    setError('');

    try {
      const [settingsRes, channelsRes] = await Promise.all([
        fetch('/api/public/settings').then((r) => r.json()),
        fetch('/api/public/channels').then((r) => r.json()),
      ]);

      const cardsRes = await fetchCards({ limit: PAGE_SIZE });
      const cards = cardsRes.cards || [];
      setItems(cards);
      setLastSeen(cards[0]?.createdAt || null);
      setHasMoreItems(Boolean(cardsRes.hasMore));

      setSettings(settingsRes);
      setChannels(channelsRes.channels || []);
      setLastUpdateAt(new Date());
      setRefreshIn(REFRESH_SECONDS);
    } catch (loadError) {
      setError('Unable to load dashboard data. Please retry in a few seconds.');
    } finally {
      setIsLoading(false);
    }
  }

  async function refresh({ forced = false } = {}) {
    if (isRefreshing) return;

    setIsRefreshing(true);
    setError('');

    try {
      const deltaRes = await fetchCards({ limit: PAGE_SIZE, since: lastSeen || '' });
      const newCards = deltaRes.cards || [];
      if (forced || newCards.length) {
        if (forced) {
          const latestRes = await fetchCards({ limit: PAGE_SIZE });
          setItems(latestRes.cards || []);
          setHasMoreItems(Boolean(latestRes.hasMore));
          setLastSeen(latestRes.cards?.[0]?.createdAt || null);
        } else {
          setItems((current) => {
            const known = new Set(current.map((item) => item.id || item.messageKey || `${item.createdAt}-${item.messageId}`));
            const uniqueIncoming = newCards.filter((item) => {
              const incomingKey = item.id || item.messageKey || `${item.createdAt}-${item.messageId}`;
              return !known.has(incomingKey);
            });
            return uniqueIncoming.length ? [...uniqueIncoming, ...current] : current;
          });
          setLastSeen(newCards[0]?.createdAt || lastSeen);
        }
      }
      setLastUpdateAt(new Date());
      setRefreshIn(REFRESH_SECONDS);
    } catch (refreshError) {
      setError('Auto refresh failed. Data may be stale until the next successful fetch.');
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    loadInitial();
  }, []);

  async function loadOlder() {
    if (isLoadingOlder || !hasMoreItems) return;
    setIsLoadingOlder(true);
    try {
      const response = await fetchCards({ limit: PAGE_SIZE, offset: items.length });
      const olderCards = response.cards || [];
      setItems((current) => [...current, ...olderCards]);
      setHasMoreItems(Boolean(response.hasMore));
    } catch {
      setError('Failed to load older events. Please try again.');
    } finally {
      setIsLoadingOlder(false);
    }
  }

  useEffect(() => {
    const refreshTimer = setInterval(() => {
      refresh();
    }, REFRESH_SECONDS * 1000);

    const countdownTimer = setInterval(() => {
      setRefreshIn((value) => (value <= 1 ? REFRESH_SECONDS : value - 1));
    }, 1000);

    return () => {
      clearInterval(refreshTimer);
      clearInterval(countdownTimer);
    };
  }, [lastSeen, isRefreshing]);

  const mediaOptions = useMemo(() => {
    const all = new Set(items.map((item) => getItemType(item)));
    return ['all', ...Array.from(all)];
  }, [items]);

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      const channelName = (item.channelTitle || item.channel || '').toLowerCase();
      const text = (item.caption || item.text || '').toLowerCase();
      const type = getItemType(item);
      const channelMatch = channelFilter === 'all' || channelName === channelFilter.toLowerCase();
      const mediaMatch = mediaFilter === 'all' || type === mediaFilter;
      const textMatch = !term || text.includes(term) || channelName.includes(term);
      return channelMatch && mediaMatch && textMatch;
    });
  }, [items, search, channelFilter, mediaFilter]);

  const stats = useMemo(() => {
    const mediaBreakdown = items.reduce((acc, item) => {
      const type = getItemType(item);
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});

    const topMedia = Object.entries(mediaBreakdown).sort((a, b) => b[1] - a[1])[0];

    return {
      totalItems: items.length,
      visibleItems: filteredItems.length,
      channels: channels.length,
      topMedia: topMedia ? `${topMedia[0]} (${topMedia[1]})` : 'n/a',
    };
  }, [items, filteredItems.length, channels.length]);

  const latestItem = items[0];

  return (
    <>
      <Head>
        <title>{settings?.botName ? `${settings.botName} Dashboard` : 'Forwarding Dashboard'}</title>
      </Head>
      <div className="pageShell">
        <div className="backgroundCanvas" aria-hidden="true">
          <Squares speed={0.5} squareSize={40} direction="diagonal" borderColor="#999" hoverFillColor="#222" />
        </div>
        <main className="wrap">
        <header className="hero card">
          <div>
            <p className="badge">Live Forwarding Dashboard</p>
            <h1>{settings?.botName || 'Forward Bot'}</h1>
            <p className="muted">{settings?.infoContent || 'Live forwarded feed with production-focused monitoring.'}</p>
            <div className="statusRow">
              <span className="statusPill">Auto refresh in {refreshIn}s</span>
              <span className="statusPill">Updated {lastUpdateAt ? lastUpdateAt.toLocaleTimeString() : '-'}</span>
              <span className="statusPill">Items {stats.totalItems}</span>
              <span className="statusPill">Visible {stats.visibleItems}</span>
            </div>
          </div>
          <div className="heroActions">
            <button className="btn secondary" onClick={() => refresh({ forced: true })} disabled={isRefreshing}>
              {isRefreshing ? 'Refreshing…' : 'Refresh now'}
            </button>
            <button className="btn secondary" onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}>
              Theme: {theme}
            </button>
            <button className="btn secondary" onClick={() => setCompactMode((value) => !value)}>
              {compactMode ? 'Comfort mode' : 'Compact mode'}
            </button>
          </div>
        </header>

        {error ? <p className="errorBanner">{error}</p> : null}

        <section className="statsGrid statsGridExtended mobileStatsRow">
          <article className="card statCard">
            <p className="muted">Active channels</p>
            <h3>{stats.channels}</h3>
          </article>
          <article className="card statCard">
            <p className="muted">Top media type</p>
            <h3>{stats.topMedia}</h3>
          </article>
          <article className="card statCard">
            <p className="muted">Latest channel</p>
            <h3>{latestItem?.channelTitle || latestItem?.channel || 'n/a'}</h3>
          </article>
          <article className="card statCard">
            <p className="muted">Latest event</p>
            <h3>{latestItem ? formatTime(latestItem.createdAt) : '-'}</h3>
          </article>
        </section>

        <section className="card filtersSection">
          <div className="sectionHeader">
            <h2>Smart Filters</h2>
            <button
              className="btn tiny secondary"
              onClick={() => {
                setSearch('');
                setChannelFilter('all');
                setMediaFilter('all');
              }}
            >
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
                  <option key={channel} value={channel}>
                    {channel}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Media
              <select value={mediaFilter} onChange={(e) => setMediaFilter(e.target.value)}>
                {mediaOptions.map((media) => (
                  <option key={media} value={media}>
                    {media === 'all' ? 'All types' : media.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="card trackedChannelsSection">
          <h2>Tracked Channels</h2>
          <div className="chips">
            {channels.length ? channels.map((value) => <span key={value}>{value}</span>) : <span>No channels configured.</span>}
          </div>
        </section>

        <section className="card feedSection">
          <div className="sectionHeader">
            <h2>Forwarded Feed</h2>
            <span className="muted small">Newest 50 events</span>
          </div>
          {isLoading ? <p className="muted">Loading feed…</p> : null}
          {!isLoading && !filteredItems.length ? <p className="muted">No items match the current filters.</p> : null}
          <div className={`feed ${compactMode ? 'compact' : ''}`}>
            {filteredItems.map((item) => {
              const key = item.messageKey || `${item.createdAt}-${item.messageId}`;
              const canEmbed = item.embed?.channel && item.embed?.postId;
              const fullPreview = String(item.caption || item.text || '')
                .replace(/\r\n/g, '\n')
                .replace(/[\t\f\v]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .split('\n')
                .map((line) => line.replace(/\s+$/g, ''))
                .join('\n')
                .trim();
              const previewLimit = compactMode ? 140 : 240;
              const isLongPreview = fullPreview.length > previewLimit;
              const isExpanded = !!expandedItems[key];
              const previewText = isExpanded ? (fullPreview || '(no text)') : formatPreview(fullPreview, previewLimit);
              return (
                <article className="post" key={key}>
                  <div className="postHeader">
                    <strong>{item.channelTitle || item.channel || 'Unknown channel'}</strong>
                    <span className="muted">{formatTime(item.createdAt)}</span>
                  </div>
                  <div className="metaRow">
                    <span className="mediaBadge">{getItemType(item).toUpperCase()}</span>
                    {item.sourceLink ? (
                      <a className="link" href={item.sourceLink} target="_blank" rel="noreferrer">
                        Source
                      </a>
                    ) : null}
                  </div>
                  <button
                    className={`previewToggle ${isLongPreview ? '' : 'static'}`}
                    type="button"
                    disabled={!isLongPreview}
                    onClick={() => setExpandedItems((current) => ({ ...current, [key]: !current[key] }))}
                  >
                    <p className="postText">{previewText}</p>
                    {isLongPreview ? <span className="muted small">{isExpanded ? 'Show less' : 'Click to expand'}</span> : null}
                  </button>
                  {canEmbed ? (
                    <button className="btn tiny secondary" onClick={() => setOpenEmbeds((current) => ({ ...current, [key]: !current[key] }))}>
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
          {hasMoreItems ? (
            <div className="loadMoreWrap">
              <button className="btn secondary" onClick={loadOlder} disabled={isLoadingOlder}>
                {isLoadingOlder ? 'Loading…' : 'Load older events'}
              </button>
            </div>
          ) : null}
        </section>
        </main>
      </div>
    </>
  );
}
