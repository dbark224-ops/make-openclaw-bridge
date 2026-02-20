import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // e.g. -1003765446514
const TELEGRAM_THREAD_ID = process.env.TELEGRAM_THREAD_ID; // e.g. 1 (optional)

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/inbound", async (req, res) => {
try {
const incomingSecret = req.header("x-bridge-secret");
if (!BRIDGE_SECRET || incomingSecret !== BRIDGE_SECRET) {
return res.status(401).json({ ok: false, error: "unauthorized" });
}

const payload = req.body || {};
const text = `[MAKE_EMAIL_EVENT]\n${JSON.stringify(payload)}`;

const body = {
chat_id: TELEGRAM_CHAT_ID,
text
};
if (TELEGRAM_THREAD_ID) body.message_thread_id = Number(TELEGRAM_THREAD_ID);

const tgResp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify(body)
});

const tgJson = await tgResp.json();
if (!tgJson.ok) {
return res.status(502).json({ ok: false, error: "telegram_send_failed", detail: tgJson });
}

return res.json({ ok: true, message_id: tgJson.result?.message_id });
} catch (err) {
return res.status(500).json({ ok: false, error: err.message });
}
});

app.listen(PORT, () => console.log(`Bridge listening on ${PORT}`));
