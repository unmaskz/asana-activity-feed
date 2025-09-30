const fetch = require("node-fetch");

const ASANA_TOKEN = process.env.ASANA_PAT;

// Token refresh function
async function refreshAccessToken(refreshToken, userId = null) {
  try {
    const response = await fetch('https://app.asana.com/-/oauth_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.ASANA_CLIENT_ID,
        client_secret: process.env.ASANA_CLIENT_SECRET,
        refresh_token: refreshToken
      })
    });
    
    const data = await response.json();
    if (data.access_token) {
      // Update database if userId provided
      if (userId) {
        const { pool } = require('./db');
        await pool.query(
          'UPDATE users SET access_token = $1, refresh_token = $2 WHERE id = $3',
          [data.access_token, data.refresh_token || refreshToken, userId]
        );
        console.log('Updated tokens in database for user:', userId);
      }
      return data;
    } else {
      console.log('Token refresh failed:', data);
      return null;
    }
  } catch (err) {
    console.log('Token refresh error:', err.message);
    return null;
  }
}

async function getUserName(gid, accessToken = null, refreshToken = null, userId = null) {
  if (!gid) return "Unknown";
  const token = accessToken || ASANA_TOKEN;
  if (!token) {
    console.log(`No token available for user ${gid}`);
    return "Unknown";
  }
  try {
    console.log(`Fetching user name for ${gid} with token: ${accessToken ? 'user token' : 'PAT'}`);
    const res = await fetch(`https://app.asana.com/api/1.0/users/${gid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    console.log(`User API response status: ${res.status}`);
    
    if (res.status === 200 && data?.data?.name) {
      return data.data.name;
    } else if (res.status === 401 && data?.errors?.[0]?.message?.includes('expired') && refreshToken) {
      console.log('Token expired, attempting refresh...');
      const refreshData = await refreshAccessToken(refreshToken, userId);
      if (refreshData?.access_token) {
        console.log('Token refreshed successfully, retrying API call');
        const retryRes = await fetch(`https://app.asana.com/api/1.0/users/${gid}`, {
          headers: { Authorization: `Bearer ${refreshData.access_token}` },
        });
        const retryData = await retryRes.json();
        if (retryRes.status === 200 && retryData?.data?.name) {
          return retryData.data.name;
        }
      }
    }
    
    console.log(`User API error:`, data);
    return "Unknown";
  } catch (err) {
    console.log(`Error fetching user ${gid}:`, err.message);
    return "Unknown";
  }
}

async function getTaskName(gid, accessToken = null, refreshToken = null, userId = null) {
  if (!gid) return null;
  const token = accessToken || ASANA_TOKEN;
  if (!token) {
    console.log(`No token available for task ${gid}`);
    return null;
  }
  try {
    console.log(`Fetching task name for ${gid} with token: ${accessToken ? 'user token' : 'PAT'}`);
    const res = await fetch(`https://app.asana.com/api/1.0/tasks/${gid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    console.log(`Task API response status: ${res.status}`);
    
    if (res.status === 200 && data?.data?.name) {
      return data.data.name;
    } else if (res.status === 401 && data?.errors?.[0]?.message?.includes('expired') && refreshToken) {
      console.log('Token expired, attempting refresh...');
      const refreshData = await refreshAccessToken(refreshToken, userId);
      if (refreshData?.access_token) {
        console.log('Token refreshed successfully, retrying API call');
        const retryRes = await fetch(`https://app.asana.com/api/1.0/tasks/${gid}`, {
          headers: { Authorization: `Bearer ${refreshData.access_token}` },
        });
        const retryData = await retryRes.json();
        if (retryRes.status === 200 && retryData?.data?.name) {
          return retryData.data.name;
        }
      }
    }
    
    console.log(`Task API error:`, data);
    return null;
  } catch (err) {
    console.log(`Error fetching task ${gid}:`, err.message);
    return null;
  }
}

async function getCommentText(storyGid, accessToken = null) {
  if (!storyGid) return null;
  const token = accessToken || ASANA_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(
      `https://app.asana.com/api/1.0/stories/${storyGid}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    return data?.data?.text || null;
  } catch {
    return null;
  }
}

// --- Event parsing --------------------------------------------

function parseAction(ev) {
  let action_type = ev.action || "unknown";
  let details = {};

  if (ev.resource?.resource_type === "task") {
    if (ev.action === "added") {
      action_type = "task_created";
    } else if (ev.action === "removed") {
      action_type = "task_deleted";
    } else if (ev.action === "changed") {
      switch (ev.change?.field) {
        case "memberships":
          action_type = "task_moved";
          if (ev.change?.added_value?.section?.name) {
            details.to_section = ev.change.added_value.section.name;
          }
          if (ev.change?.removed_value?.section?.name) {
            details.from_section = ev.change.removed_value.section.name;
          }
          break;
        case "name":
          action_type = "task_renamed";
          break;
        case "assignee":
          action_type = "task_reassigned";
          break;
      }
    }
  }

  if (ev.resource?.resource_subtype === "comment_added") {
    action_type = "comment_added";
  }
  if (ev.resource?.resource_subtype === "comment_edited") {
    action_type = "comment_edited";
  }
  if (ev.resource?.resource_subtype === "comment_deleted") {
    action_type = "comment_deleted";
  }

  return { action_type, details };
}

module.exports = {
  getUserName,
  getTaskName,
  getCommentText,
  parseAction,
};
