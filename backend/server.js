import express from "express";
import bodyParser from "body-parser";
import { v4 as uuidv4 } from "uuid";
import { db } from "./db.js";
import {
  getUserName,
  getTaskName,
  getCommentText,
  parseAction,
} from "./helpers/asana.js";

const app = express();
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
    const eventId = uuidv4();

    const actor_name = await getUserName(ev.user?.gid);
    const task_id =
      ev.resource?.resource_type === "task" ? ev.resource.gid : ev.parent?.gid;
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

    await db("events").insert({
      id: eventId,
      project_id,
      task_id,
      subtask_id,
      action_type,
      actor_name,
      task_name,
      subtask_name: null,
      comment_text,
      added_user_name: details.added_user_name || null,
      removed_user_name: details.removed_user_name || null,
      from_section: details.from_section || null,
      to_section: details.to_section || null,
      created_at: ev.created_at,
      raw_json: JSON.stringify(ev),
    });
  }

  res.status(200).send("ok");
});
