const fetch = require('node-fetch');
const { pool } = require('../db');

async function getAccessToken() {
  // Try to use the most recent OAuth token in DB
  const { rows } = await pool.query(
    'SELECT access_token FROM users ORDER BY created_at DESC LIMIT 1'
  );
  return rows[0]?.access_token || process.env.ASANA_PERSONAL_ACCESS_TOKEN;
}

async function resolveUserName(userGid) {
  const token = await getAccessToken();
  try {
    const resp = await fetch(
      `https://app.asana.com/api/1.0/users/${userGid}?opt_fields=name`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`❌ resolveUserName failed for ${userGid}: ${resp.status} ${errText}`);
      return `user-${userGid}`;
    }
    const data = await resp.json();
    return data?.data?.name || `user-${userGid}`;
  } catch (err) {
    console.error(`❌ Error resolving user ${userGid}`, err);
    return `user-${userGid}`;
  }
}

async function resolveTaskName(taskGid) {
  const token = await getAccessToken();
  try {
    const resp = await fetch(
      `https://app.asana.com/api/1.0/tasks/${taskGid}?opt_fields=name`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`❌ resolveTaskName failed for ${taskGid}: ${resp.status} ${errText}`);
      return null;
    }
    const data = await resp.json();
    return data?.data?.name || null;
  } catch (err) {
    console.error(`❌ Error resolving task ${taskGid}`, err);
    return null;
  }
}

async function resolveProjectName(projectGid) {
  const token = await getAccessToken();
  try {
    const resp = await fetch(
      `https://app.asana.com/api/1.0/projects/${projectGid}?opt_fields=name`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`❌ resolveProjectName failed for ${projectGid}: ${resp.status} ${errText}`);
      return null;
    }
    const data = await resp.json();
    return data?.data?.name || null;
  } catch (err) {
    console.error(`❌ Error resolving project ${projectGid}`, err);
    return null;
  }
}

async function resolveStoryText(storyGid) {
  const token = await getAccessToken();
  try {
    const resp = await fetch(
      `https://app.asana.com/api/1.0/stories/${storyGid}?opt_fields=text`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`❌ resolveStoryText failed for ${storyGid}: ${resp.status} ${errText}`);
      return null;
    }
    const data = await resp.json();
    return data?.data?.text || null;
  } catch (err) {
    console.error(`❌ Error resolving story ${storyGid}`, err);
    return null;
  }
}

module.exports = {
  resolveUserName,
  resolveTaskName,
  resolveProjectName,
  resolveStoryText
};
