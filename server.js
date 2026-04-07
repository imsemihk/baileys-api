'use strict';

const express = require('express');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const logger = pino({ level: 'info' });

app.use(express.json());

// Auth state
const authDir = path.join(__dirname, 'auth_info');
if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

let socket;
let qr = null;
let isReady = false;

// ─── Start Baileys ────────────────────────────────────────
async function startBaileys() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: state,
    syncFullHistory: false
  });

  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr: qrCode } = update;
    if (qrCode) qr = qrCode;
    if (connection === 'connecting') console.log('🔄 Bağlanıyor...');
    if (connection === 'open') {
      isReady = true;
      console.log('✅ Baileys bağlı!');
      qr = null;
    }
    if (connection === 'close') {
      isReady = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ Bağlantı kapandı. Yeniden bağlanıyor...', shouldReconnect);
      if (shouldReconnect) setTimeout(() => startBaileys(), 3000);
    }
  });

  socket.ev.on('creds.update', saveCreds);
}

// ─── Endpoints ────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ connected: isReady, qr: qr ? qr.image : null });
});

// Text gönder
app.post('/api/sendText', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'Not connected' });
  const { to, text } = req.body;
  try {
    const msg = await socket.sendMessage(to, { text });
    res.json({ ok: true, messageId: msg.key.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Görsel gönder
app.post('/api/sendImage', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'Not connected' });
  const { to, url, caption } = req.body;
  try {
    const msg = await socket.sendMessage(to, {
      image: { url },
      caption: caption || ''
    });
    res.json({ ok: true, messageId: msg.key.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Video gönder
app.post('/api/sendVideo', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'Not connected' });
  const { to, url, caption } = req.body;
  try {
    const msg = await socket.sendMessage(to, {
      video: { url },
      caption: caption || ''
    });
    res.json({ ok: true, messageId: msg.key.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mesaj listen (webhook)
app.post('/api/setWebhook', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  socket.ev.on('messages.upsert', async (m) => {
    if (m.type === 'notify') {
      for (const msg of m.messages) {
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg)
          });
        } catch (e) {
          console.error('Webhook failed:', e.message);
        }
      }
    }
  });

  res.json({ ok: true });
});

// Start
async function main() {
  await startBaileys();
  app.listen(PORT, () => {
    console.log(`🚀 Baileys API: http://localhost:${PORT}`);
  });
}

main().catch(console.error);
