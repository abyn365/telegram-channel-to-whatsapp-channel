import { useEffect, useState } from 'react';

const REFRESH_SECONDS = 15;

export default function Admin() {
  const [token, setToken] = useState(typeof window !== 'undefined' ? localStorage.getItem('adminToken') || '' : '');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [settingsJson, setSettingsJson] = useState('{}');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [status, setStatus] = useState('Not logged in');
  const [stats, setStats] = useState({ channels: 0, forwards: 0 });
  const [refreshIn, setRefreshIn] = useState(REFRESH_SECONDS);

  const authHeader = token ? { Authorization: `Bearer ${token}` } : {};

  const loadAdminData = async () => {
    if (!token) return;
    try {
      const [settings, channels, forwards] = await Promise.all([
        fetch('/api/admin/settings', { headers: authHeader }).then((r) => r.json()),
        fetch('/api/public/channels').then((r) => r.json()),
        fetch('/api/public/forwards?limit=20').then((r) => r.json()),
      ]);
      setSettingsJson(JSON.stringify(settings, null, 2));
      setStats({ channels: (channels.channels || []).length, forwards: (forwards.items || []).length });
      setStatus('Authenticated');
      setRefreshIn(REFRESH_SECONDS);
    } catch {
      setStatus('Failed to load admin data');
    }
  };

  useEffect(() => {
    if (!token) return;
    loadAdminData();
    const refreshTimer = setInterval(loadAdminData, REFRESH_SECONDS * 1000);
    const countdownTimer = setInterval(() => setRefreshIn((v) => (v <= 1 ? REFRESH_SECONDS : v - 1)), 1000);
    return () => {
      clearInterval(refreshTimer);
      clearInterval(countdownTimer);
    };
  }, [token]);

  const login = async () => {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) return alert('Invalid login');
    const data = await res.json();
    setToken(data.token);
    localStorage.setItem('adminToken', data.token);
    setStatus('Authenticated');
  };

  const save = async () => {
    const payload = JSON.parse(settingsJson);
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return alert('Save failed');
    const updated = await res.json();
    setSettingsJson(JSON.stringify(updated, null, 2));
    setStatus('Settings saved');
  };

  const rotatePassword = async () => {
    const res = await fetch('/api/admin/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    if (!res.ok) return alert('Password change failed');
    setOldPassword('');
    setNewPassword('');
    setStatus('Password updated');
  };

  return (
    <main className="wrap">
      <header className="hero card">
        <div>
          <p className="badge">Admin Panel</p>
          <h1>Dashboard Controls</h1>
          <p className="muted">Status: {status}</p>
          <div className="statusRow">
            <span className="statusPill">Channels: {stats.channels}</span>
            <span className="statusPill">Latest forwards loaded: {stats.forwards}</span>
            <span className="statusPill">Refresh in {refreshIn}s</span>
          </div>
        </div>
        <a href="/" className="btn">Back</a>
      </header>

      <section className="card">
        <h2>Login</h2>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
        <button className="btn" onClick={login}>Login</button>
      </section>

      <section className="card">
        <h2>Settings JSON</h2>
        <textarea rows={16} value={settingsJson} onChange={(e) => setSettingsJson(e.target.value)} />
        <button className="btn" onClick={save}>Save Settings</button>
      </section>

      <section className="card">
        <h2>Rotate Admin Password</h2>
        <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} placeholder="Old password" />
        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password" />
        <button className="btn secondary" onClick={rotatePassword}>Update Password</button>
      </section>
    </main>
  );
}
