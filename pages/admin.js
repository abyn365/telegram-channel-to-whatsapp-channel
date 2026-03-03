import { useEffect, useMemo, useState } from 'react';

const EMPTY_TEMPLATE = { channel: '', postId: '' };

function sanitizeTemplates(list) {
  return (list || []).map((item) => ({ channel: String(item.channel || '').trim(), postId: String(item.postId || '').trim() }))
    .filter((item) => item.channel && item.postId);
}

export default function Admin() {
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [settings, setSettings] = useState({
    botName: '',
    infoTitle: '',
    infoContent: '',
    contact: '',
    theme: 'dark',
    templates: [EMPTY_TEMPLATE],
    ui: {
      badgeText: '',
      heroSubtitle: '',
      feedTitle: '',
      feedHint: '',
      accentColor: '#5f7cff',
      footerText: '',
    },
  });

  const isLoggedIn = useMemo(() => Boolean(token), [token]);

  const loadSettings = async (authToken) => {
    const res = await fetch('/api/admin/settings', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) throw new Error('Could not load settings');
    const data = await res.json();
    setSettings({
      ...data,
      templates: data.templates?.length ? data.templates : [EMPTY_TEMPLATE],
      ui: {
        badgeText: data.ui?.badgeText || '',
        heroSubtitle: data.ui?.heroSubtitle || '',
        feedTitle: data.ui?.feedTitle || '',
        feedHint: data.ui?.feedHint || '',
        accentColor: data.ui?.accentColor || '#5f7cff',
        footerText: data.ui?.footerText || '',
      },
    });
  };

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('adminToken') || '' : '';
    if (!saved) return;
    setToken(saved);
    loadSettings(saved).catch(() => {
      setStatus('Session expired. Please login again.');
      setToken('');
      localStorage.removeItem('adminToken');
    });
  }, []);

  const login = async () => {
    setStatus('Signing in...');
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      setStatus('Invalid credentials.');
      return;
    }

    const data = await res.json();
    setToken(data.token);
    localStorage.setItem('adminToken', data.token);
    await loadSettings(data.token);
    setStatus('Logged in successfully.');
    setPassword('');
  };

  const updateField = (field, value) => setSettings((prev) => ({ ...prev, [field]: value }));
  const updateUiField = (field, value) => setSettings((prev) => ({ ...prev, ui: { ...prev.ui, [field]: value } }));

  const updateTemplate = (idx, field, value) => {
    setSettings((prev) => ({
      ...prev,
      templates: prev.templates.map((tpl, i) => (i === idx ? { ...tpl, [field]: value } : tpl)),
    }));
  };

  const addTemplate = () => setSettings((prev) => ({ ...prev, templates: [...prev.templates, { ...EMPTY_TEMPLATE }] }));
  const removeTemplate = (idx) => setSettings((prev) => ({
    ...prev,
    templates: prev.templates.filter((_, i) => i !== idx).length ? prev.templates.filter((_, i) => i !== idx) : [{ ...EMPTY_TEMPLATE }],
  }));

  const saveSettings = async () => {
    setStatus('Saving settings...');
    const payload = {
      ...settings,
      templates: sanitizeTemplates(settings.templates),
      ui: {
        ...settings.ui,
        accentColor: settings.ui.accentColor || '#5f7cff',
      },
    };

    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      setStatus('Save failed.');
      return;
    }

    const updated = await res.json();
    setSettings((prev) => ({ ...prev, ...updated, templates: updated.templates?.length ? updated.templates : prev.templates }));
    setStatus('Settings saved.');
  };

  const logout = () => {
    setToken('');
    localStorage.removeItem('adminToken');
    setStatus('Logged out.');
  };

  return (
    <main className="wrap">
      <header className="topbar card">
        <div>
          <h1>Admin Panel</h1>
          <p className="muted">Manage content, visuals, and defaults for the whole site.</p>
        </div>
        <div className="heroActions">
          <a href="/" className="btn secondary">Back</a>
          {isLoggedIn ? <button className="btn" onClick={logout}>Logout</button> : null}
        </div>
      </header>

      {!isLoggedIn ? (
        <section className="card adminGrid">
          <h2>Login</h2>
          <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" /></label>
          <label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" /></label>
          <button className="btn" onClick={login}>Login</button>
          {status ? <p className="muted">{status}</p> : null}
        </section>
      ) : (
        <>
          <section className="card adminGrid">
            <h2>Brand & Content</h2>
            <label>Bot name<input value={settings.botName || ''} onChange={(e) => updateField('botName', e.target.value)} /></label>
            <label>Header badge<input value={settings.ui.badgeText || ''} onChange={(e) => updateUiField('badgeText', e.target.value)} /></label>
            <label>Hero subtitle<textarea rows={3} value={settings.ui.heroSubtitle || ''} onChange={(e) => updateUiField('heroSubtitle', e.target.value)} /></label>
            <label>Info section title<input value={settings.infoTitle || ''} onChange={(e) => updateField('infoTitle', e.target.value)} /></label>
            <label>Info section content<textarea rows={3} value={settings.infoContent || ''} onChange={(e) => updateField('infoContent', e.target.value)} /></label>
            <label>Contact / footer fallback<input value={settings.contact || ''} onChange={(e) => updateField('contact', e.target.value)} /></label>
          </section>

          <section className="card adminGrid">
            <h2>Visual Customization</h2>
            <label>Default theme
              <select value={settings.theme || 'dark'} onChange={(e) => updateField('theme', e.target.value)}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
            <label>Accent color<input type="color" value={settings.ui.accentColor || '#5f7cff'} onChange={(e) => updateUiField('accentColor', e.target.value)} /></label>
            <label>Feed title<input value={settings.ui.feedTitle || ''} onChange={(e) => updateUiField('feedTitle', e.target.value)} /></label>
            <label>Feed hint<textarea rows={3} value={settings.ui.feedHint || ''} onChange={(e) => updateUiField('feedHint', e.target.value)} /></label>
            <label>Footer text<input value={settings.ui.footerText || ''} onChange={(e) => updateUiField('footerText', e.target.value)} /></label>
          </section>

          <section className="card adminGrid">
            <h2>Embed Templates</h2>
            {settings.templates.map((tpl, idx) => (
              <div className="templateRow" key={`${idx}-${tpl.channel}-${tpl.postId}`}>
                <input placeholder="Telegram channel" value={tpl.channel || ''} onChange={(e) => updateTemplate(idx, 'channel', e.target.value)} />
                <input placeholder="Post ID" value={tpl.postId || ''} onChange={(e) => updateTemplate(idx, 'postId', e.target.value)} />
                <button className="btn secondary" type="button" onClick={() => removeTemplate(idx)}>Remove</button>
              </div>
            ))}
            <button className="btn secondary" type="button" onClick={addTemplate}>Add template</button>
          </section>

          <section className="card">
            <button className="btn" onClick={saveSettings}>Save all settings</button>
            {status ? <p className="muted">{status}</p> : null}
          </section>
        </>
      )}
    </main>
  );
}
