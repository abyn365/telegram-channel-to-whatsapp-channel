const state = { settings: null, token: localStorage.getItem('adminToken') || null, lastSeen: null };

const botName = document.getElementById('botName');
const infoBtn = document.getElementById('infoBtn');
const themeBtn = document.getElementById('themeBtn');
const adminBtn = document.getElementById('adminBtn');
const infoDialog = document.getElementById('infoDialog');
const adminDialog = document.getElementById('adminDialog');
const feed = document.getElementById('feed');
const channelsEl = document.getElementById('channels');

function renderSettings() {
  document.documentElement.dataset.theme = state.settings.theme || 'dark';
  botName.textContent = state.settings.botName;
  document.getElementById('infoTitle').textContent = state.settings.infoTitle;
  document.getElementById('infoContent').textContent = state.settings.infoContent;
  document.getElementById('infoContact').textContent = state.settings.contact;
}

function createTelegramEmbed(channel, postId) {
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://telegram.org/js/telegram-widget.js?23';
  script.setAttribute('data-telegram-post', `${channel}/${postId}`);
  script.setAttribute('data-width', '100%');
  return script;
}

function renderFeed(items) {
  feed.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<p><strong>${item.channelTitle || item.channel || 'Unknown Channel'}</strong> · ${new Date(item.createdAt).toLocaleString()}</p><p>${item.text || ''}</p>`;
    if (item.channel && item.postId) {
      card.appendChild(createTelegramEmbed(item.channel, item.postId));
    }
    feed.appendChild(card);
  }
}

async function loadInitial() {
  state.settings = await (await fetch('/api/public/settings')).json();
  renderSettings();

  const channels = await (await fetch('/api/public/channels')).json();
  channelsEl.innerHTML = '';
  channels.channels.forEach((ch) => {
    const span = document.createElement('span');
    span.textContent = ch;
    channelsEl.appendChild(span);
  });

  const rows = await (await fetch('/api/public/forwards?limit=40')).json();
  if (rows.items[0]) state.lastSeen = rows.items[0].createdAt;
  renderFeed(rows.items);
}

async function refreshFeed() {
  const rows = await (await fetch(`/api/public/forwards?limit=40${state.lastSeen ? `&since=${encodeURIComponent(state.lastSeen)}` : ''}`)).json();
  if (!rows.items.length) return;
  state.lastSeen = rows.items[0].createdAt;
  const current = Array.from(feed.children).map(() => null); // trigger rerender
  void current;
  const full = await (await fetch('/api/public/forwards?limit=40')).json();
  renderFeed(full.items);
}

infoBtn.onclick = () => infoDialog.showModal();
adminBtn.onclick = () => adminDialog.showModal();
themeBtn.onclick = async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  if (state.token) {
    await fetch('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` }, body: JSON.stringify({ ...state.settings, theme: next }) });
    state.settings.theme = next;
  }
};

document.getElementById('loginSubmit').onclick = async () => {
  const username = document.getElementById('adminUser').value;
  const password = document.getElementById('adminPass').value;
  const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!response.ok) return alert('Invalid login');
  const data = await response.json();
  state.token = data.token;
  localStorage.setItem('adminToken', data.token);
  document.getElementById('adminLogin').hidden = true;
  document.getElementById('adminPanel').hidden = false;
  const settings = await (await fetch('/api/admin/settings', { headers: { Authorization: `Bearer ${state.token}` } })).json();
  document.getElementById('settingsJson').value = JSON.stringify(settings, null, 2);
};

document.getElementById('saveSettings').onclick = async () => {
  const payload = JSON.parse(document.getElementById('settingsJson').value);
  const res = await fetch('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` }, body: JSON.stringify(payload) });
  if (!res.ok) return alert('Save failed');
  state.settings = await res.json();
  renderSettings();
  alert('Saved');
};

await loadInitial();
setInterval(refreshFeed, 10000);
