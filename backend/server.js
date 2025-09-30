require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require('cookie-parser');
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
  console.log("=== WEBHOOK RECEIVED ===");
  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));
  
  if (req.headers["x-hook-secret"]) {
    console.log("Handling webhook secret verification");
    return res
      .set("X-Hook-Secret", req.headers["x-hook-secret"])
      .status(200)
      .send();
  }

  const events = req.body.events || [];
  console.log(`Processing ${events.length} events`);
  
  if (events.length === 0) {
    console.log("No events in webhook payload");
    console.log("Full body structure:", Object.keys(req.body));
  }

  for (const ev of events) {
    console.log("Processing event:", JSON.stringify(ev, null, 2));
    try {
      const eventId = uuidv4();

      // Try to find user by Asana user ID, fallback to any user's token or PAT
      let userAccessToken = null;
      let userRefreshToken = null;
      let userId = null;
      
      if (ev.user?.gid) {
        console.log(`Looking for user with Asana ID: ${ev.user.gid}`);
        const userResult = await pool.query('SELECT id, access_token, refresh_token FROM users WHERE asana_user_id = $1', [ev.user.gid]);
        console.log(`Found ${userResult.rows.length} users with that ID`);
        if (userResult.rows.length > 0) {
          userAccessToken = userResult.rows[0].access_token;
          userRefreshToken = userResult.rows[0].refresh_token;
          userId = userResult.rows[0].id;
          console.log(`Using specific user's access token`);
        } else {
          console.log('User not found, trying to use any available user token');
          // Fallback: use any user's token from the database
          const anyUserResult = await pool.query('SELECT id, access_token, refresh_token FROM users WHERE access_token IS NOT NULL LIMIT 1');
          if (anyUserResult.rows.length > 0) {
            userAccessToken = anyUserResult.rows[0].access_token;
            userRefreshToken = anyUserResult.rows[0].refresh_token;
            userId = anyUserResult.rows[0].id;
            console.log('Using any available user token');
          } else {
            console.log('No user tokens available, will use PAT');
          }
        }
      }

      const actor_name = await getUserName(ev.user?.gid, userAccessToken, userRefreshToken, userId);
      const task_id =
        ev.resource?.resource_type === "task"
          ? ev.resource.gid
          : ev.parent?.gid;
      const subtask_id =
        ev.parent?.resource_type === "subtask" ? ev.parent.gid : null;
      const task_name = await getTaskName(task_id, userAccessToken, userRefreshToken, userId);

      console.log(`Event data: actor=${actor_name}, task=${task_name}, task_id=${task_id}`);

      const { action_type, details } = parseAction(ev);
      console.log(`Parsed action: ${action_type}`, details);

      let comment_text = null;
      if (action_type === "comment_added" || action_type === "comment_edited") {
        comment_text = await getCommentText(ev.resource.gid, userAccessToken);
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
        added_user_name, removed_user_name, from_section, to_section, from_position, to_position, created_at, raw_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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
        details.from_position || null,
        details.to_position || null,
        ev.created_at, // <-- Asana timestamp
        ev,
      ]
    );

    } catch (err) {
      console.error("Failed to persist event", err, ev);
    }
  }

  console.log("=== WEBHOOK PROCESSING COMPLETE ===");
  res.status(200).send("ok");
});

app.get('/api/events', async (req, res) => {
  try {
    const project = req.query.project || null;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    
    let rows;
    if (project) {
      rows = (await pool.query(
        'SELECT * FROM events WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', 
        [project, limit, offset]
      )).rows;
    } else {
      rows = (await pool.query(
        'SELECT * FROM events ORDER BY created_at DESC LIMIT $1 OFFSET $2', 
        [limit, offset]
      )).rows;
    }
    
    // Format events for better readability
    const formattedEvents = rows.map(event => ({
      id: event.id,
      timestamp: event.created_at,
      actor: event.actor_name,
      action: event.action_type,
      task: event.task_name,
      project: event.project_id,
      details: {
        comment: event.comment_text,
        from_section: event.from_section,
        to_section: event.to_section,
        from_position: event.from_position,
        to_position: event.to_position,
        added_user: event.added_user_name,
        removed_user: event.removed_user_name
      },
      raw: event.raw_json
    }));
    
    res.json({ 
      data: formattedEvents,
      count: formattedEvents.length,
      hasMore: formattedEvents.length === limit
    });
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

// List existing webhooks
app.get('/api/webhooks/list', async (req, res) => {
  try {
    const { user_id } = req.query;
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [user_id]);
    const user = rows[0];
    if (!user) return res.status(404).send('User not found');

    const resp = await fetch(`https://app.asana.com/api/1.0/webhooks`, {
      headers: {
        Authorization: `Bearer ${user.access_token}`,
        'Content-Type': 'application/json'
      }
    });
    const j = await resp.json();
    res.json(j);
  } catch (err) {
    console.error(err);
    res.status(500).send('error listing webhooks');
  }
});

app.get('/health', async (req, res) => {
  try {
    // Test database connection
    await pool.query('SELECT 1');
    res.json({ 
      ok: true, 
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({ 
      ok: false, 
      database: 'disconnected',
      error: err.message 
    });
  }
});

// Test webhook endpoint
app.post('/test-webhook', (req, res) => {
  console.log("=== TEST WEBHOOK RECEIVED ===");
  console.log("Body:", req.body);
  res.json({ received: true, body: req.body });
});

// Activity summary endpoint
app.get('/api/activity/summary', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    const summary = await pool.query(`
      SELECT 
        action_type,
        COUNT(*) as count,
        COUNT(DISTINCT actor_name) as unique_actors,
        COUNT(DISTINCT task_id) as unique_tasks
      FROM events 
      WHERE created_at >= $1 
      GROUP BY action_type 
      ORDER BY count DESC
    `, [cutoff]);
    
    const recentEvents = await pool.query(`
      SELECT actor_name, action_type, task_name, created_at
      FROM events 
      WHERE created_at >= $1 
      ORDER BY created_at DESC 
      LIMIT 10
    `, [cutoff]);
    
    res.json({
      period: `${hours} hours`,
      summary: summary.rows,
      recent_activity: recentEvents.rows.map(event => ({
        who: event.actor_name,
        did: event.action_type,
        what: event.task_name,
        when: event.created_at
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Test endpoint to verify PAT works
app.get('/test-pat', async (req, res) => {
  try {
    const testUserId = '1210937020161294'; // The user ID from your webhook
    const actor_name = await getUserName(testUserId, null, null, null);
    const task_name = await getTaskName('1211495423706664', null, null, null); // The task ID from your webhook
    
    res.json({
      pat_available: !!process.env.ASANA_PAT,
      test_user_name: actor_name,
      test_task_name: task_name
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`ASANA_PAT available: ${process.env.ASANA_PAT ? 'YES' : 'NO'}`);
  console.log(`Database URL available: ${process.env.DATABASE_URL ? 'YES' : 'NO'}`);
});