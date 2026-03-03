import Head from 'next/head';
import { useEffect, useState } from 'react';

const REFRESH_SECONDS = 15;

function normalizeTemplates(input) {
  return String(input || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [channel, postId] = line.split('/').map((value) => value?.trim()).filter(Boolean);
      if (!channel || !postId) return null;
      return { channel, postId };
    })
    .filter(Boolean);
}

export default function Admin() {
  const [token, setToken] = useState(typeof window !== 'undefined' ? localStorage.getItem('adminToken') || '' : '');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [settings, setSettings] = useState({ botName: '', infoTitle: '', infoContent: '', contact: '', theme: 'dark', templates: [] });
  const [templatesText, setTemplatesText] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [status, setStatus] = useState('Not logged in');
  const [stats, setStats] = useState({ channels: 0, forwards: 0 });
  const [refreshIn, setRefreshIn] = useState(REFRESH_SECONDS);
  const [busy, setBusy] = useState(false);

  const authHeader = token ? { Authorization: `Bearer ${token}` } : {};

  const loadAdminData = async () => {
    if (!token) return;
    try {
      const [settingsRes, channelsRes, forwardsRes] = await Promise.all([
        fetch('/api/admin/settings', { headers: authHeader }).then((response) => response.json()),
        fetch('/api/public/channels').then((response) => response.json()),
        fetch('/api/public/forwards?limit=40').then((response) => response.json()),
      ]);
      setSettings(settingsRes);
      setTemplatesText((settingsRes.templates || []).map((template) => `${template.channel}/${template.postId}`).join('\n'));
      setStats({ channels: (channelsRes.channels || []).length, forwards: (forwardsRes.items || []).length });
      setStatus('Authenticated');
      setRefreshIn(REFRESH_SECONDS);
    } catch {
      setStatus('Failed to load admin data');
    }
  };

  useEffect(() => {
    if (!token) return undefined;
    loadAdminData();
    const refreshTimer = setInterval(loadAdminData, REFRESH_SECONDS * 1000);
    const countdownTimer = setInterval(() => setRefreshIn((value) => (value <= 1 ? REFRESH_SECONDS : value - 1)), 1000);
    return () => {
      clearInterval(refreshTimer);
      clearInterval(countdownTimer);
    };
  }, [token]);

  const login = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) return alert('Invalid login');
      const data = await response.json();
      setToken(data.token);
      localStorage.setItem('adminToken', data.token);
      setPassword('');
      setStatus('Authenticated');
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    setToken('');
    localStorage.removeItem('adminToken');
    setStatus('Logged out');
  };

  const saveSettings = async () => {
    const templates = normalizeTemplates(templatesText);
    const payload = {
      botName: settings.botName || '',
      infoTitle: settings.infoTitle || '',
      infoContent: settings.infoContent || '',
      contact: settings.contact || '',
      theme: settings.theme || 'dark',
      templates,
    };

    if (!payload.botName.trim()) return alert('Bot name is required');

    setBusy(true);
    try {
      const response = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(payload),
      });
      if (!response.ok) return alert('Settings save failed');
      const updated = await response.json();
      setSettings(updated);
      setTemplatesText((updated.templates || []).map((template) => `${template.channel}/${template.postId}`).join('\n'));
      setStatus('Settings saved');
    } finally {
      setBusy(false);
    }
  };

  const rotatePassword = async () => {
    if (newPassword.length < 12) return alert('Use at least 12 characters for the new password');
    setBusy(true);
    try {
      const response = await fetch('/api/admin/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      if (!response.ok) return alert('Password change failed');
      setOldPassword('');
      setNewPassword('');
      setStatus('Password updated');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Head>
        <meta name="robots" content="noindex,nofollow" />
        <title>Dashboard Admin</title>
      </Head>
      <main className="wrap adminWrap">
        <header className="hero card">
          <div>
            <p className="badge">Restricted Admin</p>
            <h1>Dashboard Operations</h1>
            <p className="muted">{status}</p>
            <div className="statusRow">
              <span className="statusPill">Auth: {token ? 'Logged in' : 'Logged out'}</span>
              <span className="statusPill">Channels: {stats.channels}</span>
              <span className="statusPill">Latest forwards: {stats.forwards}</span>
              <span className="statusPill">Refresh in {refreshIn}s</span>
            </div>
          </div>
          <div className="heroActions">
            {token ? <button className="btn secondary" onClick={logout}>Logout</button> : null}
          </div>
        </header>

        <section className="gridTwo">
          <article className="card">
            <h2>Admin Login</h2>
            <p className="muted small">Credentials are required to access write operations.</p>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoComplete="username" />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" />
            <button className="btn" onClick={login} disabled={busy}>Login</button>
          </article>

          <article className="card">
            <h2>Rotate Password</h2>
            <p className="muted small">Use 12+ characters with letters, numbers, and symbols.</p>
            <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} placeholder="Current password" autoComplete="current-password" />
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password" autoComplete="new-password" />
            <button className="btn secondary" onClick={rotatePassword} disabled={busy || !token}>Update Password</button>
          </article>
        </section>

        <section className="card">
          <div className="sectionHeader">
            <h2>Dashboard Settings</h2>
            <button className="btn" onClick={saveSettings} disabled={busy || !token}>Save Settings</button>
          </div>

          <section className="formGrid">
            <label>
              Bot Name
              <input
                value={settings.botName || ''}
                onChange={(e) => setSettings((current) => ({ ...current, botName: e.target.value }))}
                placeholder="Forward Bot"
              />
            </label>

            <label>
              Contact
              <input
                value={settings.contact || ''}
                onChange={(e) => setSettings((current) => ({ ...current, contact: e.target.value }))}
                placeholder="admin@example.com"
              />
            </label>

            <label>
              Theme
              <select value={settings.theme || 'dark'} onChange={(e) => setSettings((current) => ({ ...current, theme: e.target.value }))}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>

            <label>
              Info Title
              <input
                value={settings.infoTitle || ''}
                onChange={(e) => setSettings((current) => ({ ...current, infoTitle: e.target.value }))}
                placeholder="Sources & Admin Info"
              />
            </label>
          </section>

          <label>
            Info Content
            <textarea
              rows={4}
              value={settings.infoContent || ''}
              onChange={(e) => setSettings((current) => ({ ...current, infoContent: e.target.value }))}
              placeholder="Live forwarded feed"
            />
          </label>

          <label>
            Embed Templates (one per line as channel/postId)
            <textarea
              rows={6}
              value={templatesText}
              onChange={(e) => setTemplatesText(e.target.value)}
              placeholder="wfwitness/74427"
            />
          </label>
        </section>
      </main>
    </>
  );
}
