require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const { pool, runMigrations } = require('./db');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: '*', // allow any origin
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With']
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(process.env.COOKIE_SECRET || 'devsecret'));

const PORT = process.env.PORT || 4000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

runMigrations().then(() => console.log('Migrations applied')).catch(console.error);

// OAuth
app.get('/auth', (req, res) => {
  const clientId = process.env.ASANA_CLIENT_ID;
  const redirectUri = `${PUBLIC_BASE_URL}/oauth/callback`;
  const state = uuidv4();
  res.cookie('oauth_state', state, { signed: true });
  const url = `https://app.asana.com/-/oauth_authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${state}`;
  res.redirect(url);
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const saved = req.signedCookies.oauth_state;
    if (!saved || saved !== state) return res.status(400).send('Invalid state');

    const tokenResp = await fetch('https://app.asana.com/-/oauth_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.ASANA_CLIENT_ID,
        client_secret: process.env.ASANA_CLIENT_SECRET,
        redirect_uri: `${PUBLIC_BASE_URL}/oauth/callback`,
        code
      })
    });
    const tokenJson = await tokenResp.json();
    if (tokenJson.error) return res.status(400).json(tokenJson);

    const userId = uuidv4();
    await pool.query(
      'INSERT INTO users (id, asana_user_id, access_token, refresh_token, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [userId, tokenJson.data?.id || tokenJson.authed_user?.gid || 'unknown', tokenJson.access_token, tokenJson.refresh_token || null, null]
    );

    res.cookie('user_id', userId, { signed: true });
    res.send('Auth complete — close this window and return to Asana app.');
  } catch (err) {
    console.error(err);
    res.status(500).send('OAuth error');
  }
});

// Webhook
app.post('/webhook', async (req, res) => {
  const hookSecret = req.header('X-Hook-Secret');
  if (hookSecret) {
    res.set('X-Hook-Secret', hookSecret);
    return res.status(200).send('Handshake');
  }

  const events = req.body.events || [];
  for (const ev of events) {
    try {
      const id = uuidv4();
      const project_id = ev.resource?.gid || null;
      const task_id = ev.parent ? ev.parent.gid : (ev.resource?.resource_type === 'task' ? ev.resource.gid : null);
      const action_type = ev.action || 'unknown';
      const actor_name = ev.user?.name || ev.created_by?.name || 'someone';
      await pool.query(
        'INSERT INTO events (id, project_id, task_id, action_type, actor_name, raw_json) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, project_id, task_id, action_type, actor_name, ev]
      );
    } catch (err) {
      console.error('Failed to persist event', err);
    }
  }
  res.status(200).send('OK');
});

// API
app.get('/api/events', async (req, res) => {
  try {
    const project = req.query.project || null;
    let rows;
    if (project) {
      rows = (await pool.query('SELECT * FROM events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 500', [project])).rows;
    } else {
      rows = (await pool.query('SELECT * FROM events ORDER BY created_at DESC LIMIT 500')).rows;
    }
    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('error');
  }
});

app.post('/api/webhooks/create', async (req, res) => {
  try {
    const { user_id, project_id } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [user_id]);
    const user = rows[0];
    if (!user) return res.status(404).send('User not found');

    const resp = await fetch(`https://app.asana.com/api/1.0/webhooks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: { resource: project_id, target: `${PUBLIC_BASE_URL}/webhook` } })
    });
    const j = await resp.json();
    res.json(j);
  } catch (err) {
    console.error(err);
    res.status(500).send('error creating webhook');
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));