require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const { pool } = require("./db"); // adjust if you use knex
const {
  getUserName,
  getTaskName,
  getCommentText,
  parseAction,
} = require("./helpers/asana.js");

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

// --- Webhook endpoint
app.post("/webhook", async (req, res) => {
  if (req.headers["x-hook-secret"]) {
    return res
      .set("X-Hook-Secret", req.headers["x-hook-secret"])
      .status(200)
      .send();
  }

  const events = req.body.events || [];

  for (const ev of events) {
    try {
      const eventId = uuidv4();

      const actor_name = await getUserName(ev.user?.gid);
      const task_id =
        ev.resource?.resource_type === "task"
          ? ev.resource.gid
          : ev.parent?.gid;
      const subtask_id =
        ev.parent?.resource_type === "subtask" ? ev.parent.gid : null;
      const task_name = await getTaskName(task_id);

      const { action_type, details } = parseAction(ev);

      let comment_text = null;
      if (action_type === "comment_added" || action_type === "comment_edited") {
        comment_text = await getCommentText(ev.resource.gid);
      }

      let project_id = null;
      if (ev.parent?.resource_type === "project") {
        project_id = ev.parent.gid;
      } else if (ev.change?.added_value?.project?.gid) {
        project_id = ev.change.added_value.project.gid;
      } else if (ev.change?.removed_value?.project?.gid) {
        project_id = ev.change.removed_value.project.gid;
      }

      await pool.query(
      `INSERT INTO events
      (id, project_id, task_id, subtask_id, action_type, actor_name, task_name, subtask_name, comment_text,
        added_user_name, removed_user_name, from_section, to_section, created_at, raw_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        eventId,
        project_id,
        task_id,
        subtask_id,
        action_type,
        actor_name,
        task_name,
        null,
        comment_text,
        details.added_user_name || null,
        details.removed_user_name || null,
        details.from_section || null,
        details.to_section || null,
        ev.created_at, // <-- Asana timestamp
        ev,
      ]
    );

    } catch (err) {
      console.error("Failed to persist event", err, ev);
    }
  }

  res.status(200).send("ok");
});

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