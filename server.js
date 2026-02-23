import express from "express";
import crypto from "crypto";
import fetch from "node-fetch"; // Make sure 'node-fetch' is in your package.json dependencies

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";

// --- OPENCLAW HOOK CONFIGURATION ---
// IMPORTANT: For production, set these as actual environment variables in Railway
// The defaults below are for local testing convenience.
const OPENCLAW_HOOK_URL = process.env.OPENCLAW_HOOK_URL || "http://127.00.1:18789/hooks/wake"; // MODIFIED: Target /hooks/wake
const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || "testtoken"; // Using 'testtoken' as our verified token
// --- END OPENCLAW HOOK CONFIGURATION ---

// In-memory queues (MVP). 'events' queue will no longer be used for new emails if hook works.
const events = [];
const actions = []; // This queue is for OpenClaw to send actions back to Make

function auth(req, res, next) {
  const s = req.header("x-bridge-secret");
  if (!BRIDGE_SECRET || s !== BRIDGE_SECRET) {
    console.warn("Unauthorized access attempt: x-bridge-secret mismatch");
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
 * MODIFIED: Now forwards 'email_event' types directly to OpenClaw's /hooks/wake endpoint.
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
    const rawMessageId = body.raw_message_id || ""; // The standard RFC Message-ID header (for reference)
    const gmailApiMessageId = body.gmail_api_message_id || ""; // The crucial Gmail API message ID for replies

    // Construct the 'text' content for the OpenClaw Hook payload (for /hooks/wake)
    // This message will be what OpenClaw's main agent receives and acts upon.
    const hookTextMessage = `NEW EMAIL\nFrom: ${from}\nSubject: ${subject}\nGmail API Message ID: ${gmailApiMessageId}\nBody:\n${fullBody}\n\nTASK: Draft a reply email based on this content. If you need clarification, ask David one specific question. Use gog cli send email --to --subject --body --reply-to-message-id. Confirm send to chat with brief message.`;

    const hookPayload = {
      mode: "now", // For /hooks/wake, this ensures immediate processing
      text: hookTextMessage // The message content for the agent
    };

    try {
      // Call the OpenClaw Hook endpoint (now /hooks/wake)
      const hookResponse = await fetch(OPENCLAW_HOOK_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENCLAW_HOOK_TOKEN}`, // Use the Bearer token
          "Content-Type": "application/json"
        },
        body: JSON.stringify(hookPayload)
      });

      if (hookResponse.ok) {
        console.log(`OpenClaw Hook (/wake) successfully triggered for email: ${subject}`);
        // Respond to Make (the sender of this POST) that the hook was triggered successfully
        return res.json({ ok: true, status: "openclaw_hook_wake_triggered", id: item.id });
      } else {
        const errorText = await hookResponse.text();
        console.error(`Failed to trigger OpenClaw Hook (/wake) (${hookResponse.status}): ${errorText}`);
        // If hook call fails, return an appropriate error to Make
        return res.status(hookResponse.status).json({ ok: false, error: "openclaw_hook_wake_failed", details: errorText });
      }
    } catch (e) {
      console.error(`Error while calling OpenClaw Hook (/wake): ${e.message}`);
      // Handle network errors or other exceptions during the fetch call
      return res.status(500).json({ ok: false, error: "openclaw_hook_wake_exception", details: e.message });
    }
  } else {
    // For non-'email_event' types, or if email processing needs to fall back to the old queue system,
    // continue pushing to the in-memory 'events' queue.
    events.push(item);
    return res.json({ ok: true, id: item.id });
  }
});

/**
 * OPENCLAW -> BRIDGE: get next unacked event (no longer used for new emails if hook works)
 * This endpoint can remain for other event types or legacy processes.
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
 * This endpoint can remain for other event types or legacy processes.
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
 * IMPORTANT: This section remains as OpenClaw will output *reply drafts* in JSON.
 * Make will then fetch these drafts from this endpoint and send the actual email reply.
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
