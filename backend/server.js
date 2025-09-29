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
} = require("./helpers");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(bodyParser.json());

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
          ev.created_at,
          ev,
        ]
      );
    } catch (err) {
      console.error("Failed to persist event", err, ev);
    }
  }

  res.status(200).send("ok");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on ${PORT}`));
