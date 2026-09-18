// Servidor WhatsApp self-hosted usando Baileys
// Cada estabelecimento = 1 instância independente com seu próprio número
// Deploy: npm install && node index.js
// Env: API_KEY, PORT (default 3000), WEBHOOK_URL (Base44 webhook para status)

const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '5mb' }));

const API_KEY = process.env.API_KEY || 'change-this-key';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PORT = process.env.PORT || 3000;

const instances = {};

// ── Auth middleware ──────────────────────────────────────────────
app.use((req, res, next) => {
  const key = (req.headers.authorization || '').replace('Bearer ', '');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ── Instance lifecycle ───────────────────────────────────────────
async function startInstance(instanceId) {
  const sessionDir = path.join(__dirname, 'sessions', instanceId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Sistema ACE', 'Chrome', '1.0.0'],
    logger: require('pino')({ level: 'silent' }),
  });

  instances[instanceId] = {
    sock,
    state: 'connecting',
    qr: null,
    phone: null,
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const inst = instances[instanceId];
    if (!inst) return;

    if (qr) {
      inst.qr = qr;
      inst.state = 'qr_ready';
      console.log(`[${instanceId}] QR pronto para escanear`);
    }

    if (connection === 'open') {
      inst.state = 'connected';
      inst.qr = null;
      inst.phone = (sock.user?.id || '').split(':')[0] || '';
      console.log(`[${instanceId}] Conectado: ${inst.phone}`);
      notifyWebhook(instanceId, 'connected', { phone: inst.phone });
    }

    if (connection === 'close') {
      inst.state = 'disconnected';
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[${instanceId}] Desconectado (code=${code}). Reconnect=${shouldReconnect}`);
      notifyWebhook(instanceId, 'disconnected', { code });
      if (shouldReconnect) {
        setTimeout(() => startInstance(instanceId), 3000);
      }
    }
  });

  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      if (u.key.fromMe) {
        const status = u.update?.status || u.status;
        notifyWebhook(instanceId, 'message_status', {
          messageId: u.key.id,
          status,
        });
      }
    }
  });

  return instances[instanceId];
}

// ── Webhook helper ───────────────────────────────────────────────
async function notifyWebhook(instanceId, event, data) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ instanceId, event, ...data }),
    });
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
}

// ── Routes ───────────────────────────────────────────────────────

app.post('/instance/create', async (req, res) => {
  const { instanceId } = req.body;
  if (!instanceId) return res.status(400).json({ error: 'instanceId obrigatório' });
  if (instances[instanceId] && instances[instanceId].state === 'connected') {
    return res.json({ instanceId, state: 'connected', phone: instances[instanceId].phone });
  }
  await startInstance(instanceId);
  res.json({ instanceId, state: 'connecting' });
});

app.get('/instance/:id/qr', async (req, res) => {
  const inst = instances[req.params.id];
  if (!inst) return res.status(404).json({ error: 'Instância não encontrada' });
  if (inst.state === 'connected') {
    return res.json({ state: 'connected', phone: inst.phone, qr: null, qr_image: null });
  }
  if (!inst.qr) return res.json({ state: inst.state, qr: null, qr_image: null, message: 'Aguardando QR Code...' });
  try {
    const qr_image = await QRCode.toDataURL(inst.qr, { width: 300 });
    res.json({ state: inst.state, qr: inst.qr, qr_image });
  } catch {
    res.json({ state: inst.state, qr: inst.qr, qr_image: null });
  }
});

app.get('/instance/:id/status', (req, res) => {
  const inst = instances[req.params.id];
  if (!inst) return res.status(404).json({ error: 'Instância não encontrada' });
  res.json({ state: inst.state, phone: inst.phone });
});

app.post('/instance/:id/send', async (req, res) => {
  const inst = instances[req.params.id];
  if (!inst) return res.status(404).json({ error: 'Instância não encontrada' });
  if (inst.state !== 'connected') return res.status(400).json({ error: 'WhatsApp não conectado' });
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone e message obrigatórios' });
  try {
    let clean = String(phone).replace(/\D/g, '');
    if (!clean.startsWith('55')) clean = '55' + clean;
    const jid = `${clean}@s.whatsapp.net`;
    const result = await inst.sock.sendMessage(jid, { text: message });
    res.json({ ok: true, messageId: result.key.id });
  } catch (e) {
    console.error(`[${req.params.id}] Erro ao enviar:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/instance/:id/disconnect', async (req, res) => {
  const inst = instances[req.params.id];
  if (!inst) return res.status(404).json({ error: 'Instância não encontrada' });
  try {
    await inst.sock.logout();
  } catch {}
  delete instances[req.params.id];
  const sessionDir = path.join(__dirname, 'sessions', req.params.id);
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true });
  res.json({ ok: true });
});

app.get('/instances', (req, res) => {
  const list = Object.keys(instances).map((id) => ({
    instanceId: id,
    state: instances[id].state,
    phone: instances[id].phone,
  }));
  res.json({ instances: list });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, instances: Object.keys(instances).length });
});

app.listen(PORT, () => {
  console.log(`✅ Servidor WhatsApp rodando na porta ${PORT}`);
  console.log(`   API Key: ${API_KEY === 'change-this-key' ? '⚠️  PADRÃO — altere!' : '✓ configurada'}`);
  console.log(`   Webhook: ${WEBHOOK_URL || '⚠️  não configurado'}`);
});
