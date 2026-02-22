import express from "express";
import crypto from "crypto";
import fetch from "node-fetch"; // Add this line if not present, or use 'axios' if preferred

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";

// --- NEW ENVIRONMENT VARIABLES FOR OPENCLAW HOOK ---
// These should be set in your Railway environment variables for security and flexibility.
// For local testing, defaults are provided.
const OPENCLAW_HOOK_URL = process.env.OPENCLAW_HOOK_URL || "http://127.0.0.1:18789/hooks/agent";
const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || "xK9#mP2$vQ7nL4@wR8jT5&hF3";
// --- END NEW ENVIRONMENT VARIABLES ---

// In-memory queues (MVP). This 'events' queue will no longer be used for new emails.
const events = [];
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
 * MODIFIED: Now forwards directly to OpenClaw Hook for email_event types.
 */
app.post("/events", auth, async (req, res) => { // Marked as 'async'
  const body = req.body || {};
  const item = { id: id(), type: body.type || "email_event", payload: body, created_at: new Date().toISOString(), status: "queued" };

  // Check if it's an email event and process with OpenClaw Hook
  if (item.type === "email_event") {
    // Extract email details from the incoming payload (from Make)
    const from = body.from_name ? `${body.from_name} <${body.from}>` : body.from || "unknown";
    const subject = body.subject || "(no subject)";
    const fullBody = body.full_body || body.snippet || "(no body)";
    const messageId = body.message_id || ""; // Important for replies

    // Construct the 'message' content for OpenClaw Hook
    const openclawMessage = `NEW EMAIL\nFrom: ${from}\nSubject: ${subject}\nBody:\n${fullBody}\nMessage ID: ${messageId}\n\nTASK: Draft a reply email. Output JSON only: {"subject":"...","body":"...","needs_human":true|false}.`;

    const hookPayload = {
      agentId: "main", // Target the main agent
      wakeMode: "now", // Forces immediate agent turn
      deliver: false,  // Prevents the raw hook message from appearing in Telegram
      message: openclawMessage
    };

    try {
      const hookResponse = await fetch(OPENCLAW_HOOK_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENCLAW_HOOK_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(hookPayload)
      });

      if (hookResponse.ok) {
        console.log(`OpenClaw Hook successfully triggered for email: ${subject}`);
        // Respond to Make that the hook was triggered successfully
        return res.json({ ok: true, status: "openclaw_hook_triggered", id: item.id });
      } else {
        const errorText = await hookResponse.text();
        console.error(`Failed to trigger OpenClaw Hook (${hookResponse.status}): ${errorText}`);
        // Fallback or error response if hook fails
        // For robustness, you might want to still push to a queue here for retry mechanisms
        return res.status(hookResponse.status).json({ ok: false, error: "openclaw_hook_failed", details: errorText });
      }
    } catch (e) {
      console.error(`Error while calling OpenClaw Hook: ${e.message}`);
      // Fallback or error response on network issues
      return res.status(500).json({ ok: false, error: "openclaw_hook_exception", details: e.message });
    }
  } else {
    // For non-email events, or if email processing needs to fall back, continue queuing
    events.push(item);
    return res.json({ ok: true, id: item.id });
  }
});

/**
 * OPENCLAW -> BRIDGE: get next unacked event (no longer used for new emails if hook works)
 */
app.get("/events/next", auth, (_req, res) => {
  const item = events.find(e => e.status === "queued");
  if (!item) return res.status(204).send();
  item.status = "leased";
  item.leased_at = new Date().toISOString();
  return res.json({ ok: true, item });
});

/**
 * OPENCLAW -> BRIDGE: ack processed event (no longer used for new emails if hook works)
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
 * This section remains as OpenClaw will likely output replies for Make to handle.
 */
app.post("/actions", auth, (req, res) => {
  const body = req.body || {};
  const item = { id: id(), type: body.type || "email_action", payload: body, created_at: new Date().toISOString(), status: "queued" };
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
