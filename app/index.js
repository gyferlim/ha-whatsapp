/**
 * WhatsApp Bridge — Docker standalone
 * Inspired by FaserF/hassio-addons/whatsapp (Baileys + Node.js)
 * REST API on port 8066
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidNormalizedUser,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");

const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const QRCode = require("qrcode");
const { Boom } = require("@hapi/boom");

// ─── Config from ENV ──────────────────────────────────────────────────────────
const CONFIG = {
  port: parseInt(process.env.PORT || "8066"),
  authToken: process.env.AUTH_TOKEN || "",
  webhookUrl: process.env.WEBHOOK_URL || "",
  webhookToken: process.env.WEBHOOK_TOKEN || "",
  webhookEnabled: process.env.WEBHOOK_ENABLED === "true",
  logLevel: process.env.LOG_LEVEL || "info",
  markOnline: process.env.MARK_ONLINE === "true",
  keepAliveInterval: parseInt(process.env.KEEP_ALIVE_INTERVAL || "30000"),
  sessionDir: process.env.SESSION_DIR || "/data/session",
  resetSession: process.env.RESET_SESSION === "true",
};

// ─── Logger ───────────────────────────────────────────────────────────────────
const logger = pino({ level: CONFIG.logLevel });

// ─── State ────────────────────────────────────────────────────────────────────
let sock = null;
let qrDataUrl = null;
let connectionStatus = "disconnected";
let stats = { messagesSent: 0, messagesReceived: 0, errors: 0 };
let store = makeInMemoryStore({ logger: logger.child({ module: "store" }) });

// ─── Session reset ────────────────────────────────────────────────────────────
if (CONFIG.resetSession && fs.existsSync(CONFIG.sessionDir)) {
  logger.info("Resetting session...");
  fs.rmSync(CONFIG.sessionDir, { recursive: true, force: true });
}
fs.mkdirSync(CONFIG.sessionDir, { recursive: true });

// ─── Webhook helper ───────────────────────────────────────────────────────────
async function sendWebhook(payload) {
  if (!CONFIG.webhookEnabled || !CONFIG.webhookUrl) return;
  try {
    const headers = { "Content-Type": "application/json" };
    if (CONFIG.webhookToken) headers["X-Webhook-Token"] = CONFIG.webhookToken;
    await fetch(CONFIG.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.error({ err }, "Webhook delivery failed");
    stats.errors++;
  }
}

// ─── Baileys connection ───────────────────────────────────────────────────────
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "Using Baileys version");

  sock = makeWASocket({
    version,
    logger: logger.child({ module: "baileys" }),
    printQRInTerminal: true,
    auth: state,
    markOnlineOnConnect: CONFIG.markOnline,
    keepAliveIntervalMs: CONFIG.keepAliveInterval,
    browser: ["WhatsApp Bridge", "Chrome", "120.0"],
  });

  store.bind(sock.ev);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrDataUrl = await QRCode.toDataURL(qr);
      connectionStatus = "scanning";
      logger.info("QR code generated — scan with WhatsApp");
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      connectionStatus = "disconnected";
      qrDataUrl = null;
      logger.warn({ reason }, "Connection closed");

      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        logger.info("Reconnecting in 5s...");
        setTimeout(connectWhatsApp, 5000);
      } else {
        logger.warn("Logged out — delete session to re-pair");
      }
    } else if (connection === "open") {
      connectionStatus = "connected";
      qrDataUrl = null;
      logger.info("WhatsApp connected ✓");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      stats.messagesReceived++;

      const sender = msg.key.remoteJid;
      const isGroup = sender?.endsWith("@g.us") || false;
      const content =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      logger.info({ sender, isGroup, content }, "Message received");

      await sendWebhook({ sender, content, is_group: isGroup, raw: msg });
    }
  });
}

connectWhatsApp().catch((err) => logger.error({ err }, "Failed to start"));

// ─── Express REST API ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "50mb" }));

// Auth middleware (skip /health)
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (CONFIG.authToken && req.headers["x-auth-token"] !== CONFIG.authToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

function requireConnected(res) {
  if (connectionStatus !== "connected" || !sock) {
    res.status(503).json({ error: "WhatsApp not connected" });
    return false;
  }
  return true;
}

// ─── Health / Status ──────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/status", (req, res) => {
  res.json({ connected: connectionStatus === "connected", status: connectionStatus, version: "1.0.0" });
});

app.get("/stats", (req, res) => res.json(stats));

app.get("/qr", (req, res) => {
  if (connectionStatus === "connected") return res.json({ status: "connected" });
  if (!qrDataUrl) return res.json({ status: "waiting" });
  res.json({ status: "scanning", qr: qrDataUrl });
});

app.get("/groups", async (req, res) => {
  if (!requireConnected(res)) return;
  try {
    const groups = await sock.groupFetchAllParticipating();
    res.json(Object.values(groups));
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

// ─── Messaging ────────────────────────────────────────────────────────────────
app.post("/send_message", async (req, res) => {
  if (!requireConnected(res)) return;
  const { number, message, quotedMessageId, expiration } = req.body;
  if (!number || !message) return res.status(400).json({ error: "number and message required" });
  try {
    const extra = {};
    if (expiration) extra.ephemeralExpiration = expiration;
    if (quotedMessageId) {
      const quoted = store.loadMessage(number, quotedMessageId);
      if (quoted) extra.quoted = quoted;
    }
    await sock.sendMessage(number, { text: message, ...extra });
    stats.messagesSent++;
    res.json({ success: true });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

app.post("/send_image", async (req, res) => {
  if (!requireConnected(res)) return;
  const { number, url, caption } = req.body;
  if (!number || !url) return res.status(400).json({ error: "number and url required" });
  try {
    await sock.sendMessage(number, { image: { url }, caption: caption || "" });
    stats.messagesSent++;
    res.json({ success: true });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

app.post("/send_video", async (req, res) => {
  if (!requireConnected(res)) return;
  const { number, url, caption } = req.body;
  if (!number || !url) return res.status(400).json({ error: "number and url required" });
  try {
    await sock.sendMessage(number, { video: { url }, caption: caption || "" });
    stats.messagesSent++;
    res.json({ success: true });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

app.post("/send_audio", async (req, res) => {
  if (!requireConnected(res)) return;
  const { number, url, ptt } = req.body;
  if (!number || !url) return res.status(400).json({ error: "number and url required" });
  try {
    await sock.sendMessage(number, { audio: { url }, ptt: ptt === true, mimetype: "audio/mp4" });
    stats.messagesSent++;
    res.json({ success: true });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

app.post("/send_document", async (req, res) => {
  if (!requireConnected(res)) return;
  const { number, url, caption, fileName } = req.body;
  if (!number || !url) return res.status(400).json({ error: "number and url required" });
  try {
    await sock.sendMessage(number, {
      document: { url },
      caption: caption || "",
      fileName: fileName || "document",
      mimetype: "application/octet-stream",
    });
    stats.messagesSent++;
    res.json({ success: true });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

app.post("/send_location", async (req, res) => {
  if (!requireConnected(res)) return;
  const { number, latitude, longitude, title, description } = req.body;
  if (!number || latitude == null || longitude == null)
    return res.status(400).json({ error: "number, latitude, longitude required" });
  try {
    await sock.sendMessage(number, {
      location: { degreesLatitude: latitude, degreesLongitude: longitude, name: title, address: description },
    });
    stats.messagesSent++;
    res.json({ success: true });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

app.post("/send_poll", async (req, res) => {
  if (!requireConnected(res)) return;
  const { number, question, options, selectableCount } = req.body;
  if (!number || !question || !options?.length)
    return res.status(400).json({ error: "number, question, options required" });
  try {
    await sock.sendMessage(number, {
      poll: { name: question, values: options, selectableCount: selectableCount ?? 1 },
    });
    stats.messagesSent++;
    res.json({ success: true });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

// ─── Message management ───────────────────────────────────────────────────────
app.post("/send_reaction", async (req, res) => {
  if (!requireConnected(res)) return;
  const { number, messageId, reaction } = req.body;
  if (!number || !messageId || !reaction)
    return res.status(400).json({ error: "number, messageId, reaction required" });
  try {
    await sock.sendMessage(number, {
      react: { text: reaction, key: { remoteJid: number, id: messageId } },
    });
    res.json({ success: true });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

app.post("/revoke_message", async (req, res) => {
  if (!requireConnected(res)) return;
  const { number, message_id } = req.body;
  if (!number || !message_id) return res.status(400).json({ error: "number, message_id required" });
  try {
    await sock.sendMessage(number, {
      delete: { remoteJid: number, id: message_id },
    });
    res.json({ success: true });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

app.post("/mark_as_read", async (req, res) => {
  if (!requireConnected(res)) return;
  const { number, messageId } = req.body;
  if (!number) return res.status(400).json({ error: "number required" });
  try {
    if (messageId) {
      await sock.readMessages([{ remoteJid: number, id: messageId }]);
    } else {
      const chat = await sock.chatModify({ markRead: true, lastMessages: [] }, number);
    }
    res.json({ success: true });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

app.post("/set_presence", async (req, res) => {
  if (!requireConnected(res)) return;
  const { presence } = req.body;
  if (!presence) return res.status(400).json({ error: "presence required" });
  try {
    await sock.sendPresenceUpdate(presence);
    res.json({ success: true });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook settings ─────────────────────────────────────────────────────────
app.post("/settings/webhook", (req, res) => {
  const { url, enabled, token } = req.body;
  if (url !== undefined) CONFIG.webhookUrl = url;
  if (enabled !== undefined) CONFIG.webhookEnabled = enabled;
  if (token !== undefined) CONFIG.webhookToken = token;
  res.json({ success: true, webhook: { url: CONFIG.webhookUrl, enabled: CONFIG.webhookEnabled } });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(CONFIG.port, "0.0.0.0", () => {
  logger.info(`WhatsApp Bridge API listening on :${CONFIG.port}`);
  if (!CONFIG.authToken) logger.warn("No AUTH_TOKEN set — API is unprotected!");
});
