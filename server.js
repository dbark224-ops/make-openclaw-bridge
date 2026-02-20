import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";

// In-memory queues (MVP). Good for now; later swap to Redis/Postgres.
const events = []; // Make -> OpenClaw
const actions = []; // OpenClaw -> Make

function auth(req, res, next) {
const s = req.header("x-bridge-secret");
if (!BRIDGE_SECRET || s !== BRIDGE_SECRET) {
return res.status(401).json({ ok: false, error: "unauthorized" });
}
next();
}

function id() {
return crypto.randomUUID();
}

app.get("/health", (_req, res) => res.status(200).send("ok"));

/**
* MAKE -> BRIDGE: push inbound event (email detected, etc.)
*/
app.post("/events", auth, (req, res) => {
const body = req.body || {};
const item = {
id: id(),
type: body.type || "email_event",
payload: body,
created_at: new Date().toISOString(),
status: "queued"
};
events.push(item);
return res.json({ ok: true, id: item.id });
});

/**
* OPENCLAW -> BRIDGE: get next unacked event
*/
app.get("/events/next", auth, (_req, res) => {
const item = events.find(e => e.status === "queued");
if (!item) return res.status(204).send();
item.status = "leased";
item.leased_at = new Date().toISOString();
return res.json({ ok: true, item });
});

/**
* OPENCLAW -> BRIDGE: ack processed event
*/
app.post("/events/:id/ack", auth, (req, res) => {
const item = events.find(e => e.id === req.params.id);
if (!item) return res.status(404).json({ ok: false, error: "not_found" });
item.status = "done";
item.acked_at = new Date().toISOString();
return res.json({ ok: true });
});

/**
* OPENCLAW -> BRIDGE: enqueue action for Make (reply email, etc.)
*/
app.post("/actions", auth, (req, res) => {
const body = req.body || {};
const item = {
id: id(),
type: body.type || "email_action",
payload: body,
created_at: new Date().toISOString(),
status: "queued"
};
actions.push(item);
return res.json({ ok: true, id: item.id });
});

/**
* MAKE -> BRIDGE: get next action to execute
*/
app.get("/actions/next", auth, (_req, res) => {
const item = actions.find(a => a.status === "queued");
if (!item) return res.status(204).send();
item.status = "leased";
item.leased_at = new Date().toISOString();
return res.json({ ok: true, item });
});

/**
* MAKE -> BRIDGE: post execution result
*/
app.post("/actions/:id/result", auth, (req, res) => {
const item = actions.find(a => a.id === req.params.id);
if (!item) return res.status(404).json({ ok: false, error: "not_found" });
item.status = "done";
item.result = req.body || {};
item.completed_at = new Date().toISOString();
return res.json({ ok: true });
});

app.listen(PORT, () => {
console.log(`Bridge listening on ${PORT}`);
});
