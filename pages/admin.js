import { useState } from 'react';

export default function Admin() {
  const [token, setToken] = useState(typeof window !== 'undefined' ? localStorage.getItem('adminToken') || '' : '');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [settingsJson, setSettingsJson] = useState('{}');

  const login = async () => {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) return alert('Invalid credentials');

    const data = await res.json();
    setToken(data.token);
    localStorage.setItem('adminToken', data.token);

    const settingsRes = await fetch('/api/admin/settings', {
      headers: { Authorization: `Bearer ${data.token}` },
    });
    const settings = await settingsRes.json();
    setSettingsJson(JSON.stringify(settings, null, 2));
  };

  const saveSettings = async () => {
    const parsed = JSON.parse(settingsJson);
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(parsed),
    });

    if (!res.ok) return alert('Save failed');
    const updated = await res.json();
    setSettingsJson(JSON.stringify(updated, null, 2));
    alert('Saved');
  };

  return (
    <main className="wrap">
      <header className="topbar">
        <h1>Admin Panel</h1>
        <a href="/" className="btn">Back</a>
      </header>

      <section className="card">
        <h2>Login</h2>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" />
        <button className="btn" onClick={login}>Login</button>
      </section>

      <section className="card">
        <h2>Settings JSON</h2>
        <textarea rows={18} value={settingsJson} onChange={(e) => setSettingsJson(e.target.value)} />
        <button className="btn" onClick={saveSettings}>Save</button>
      </section>
    </main>
  );
}
