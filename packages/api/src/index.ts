import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const AGENT_HMAC_SECRET = process.env.AGENT_HMAC_SECRET || '';

function verifyHmac(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!AGENT_HMAC_SECRET) {
    return res.status(500).json({ error: 'HMAC secret not configured' });
  }
  const sig = req.header('X-Signature');
  if (!sig) {
    return res.status(401).json({ error: 'Missing signature' });
  }
  const body = JSON.stringify(req.body || '');
  const digest = crypto.createHmac('sha256', AGENT_HMAC_SECRET).update(body).digest('base64');
  if (digest !== sig) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve OpenAPI
app.get(['/openapi.json', '/.well-known/openapi.json'], (_req, res) => {
  const p = path.join(__dirname, '../openapi/openapi.json');
  const spec = fs.readFileSync(p, 'utf-8');
  res.type('application/json').send(spec);
});

// Stubs
app.get('/v1/services', (_req, res) => res.json({ services: [] }));
app.get('/v1/availability', (_req, res) => res.json({ slots: [] }));
app.post('/v1/appointments', verifyHmac, (_req, res) =>
  res.status(201).json({ id: 'apt_stub', status: 'requested' })
);
app.post('/v1/appointments/:id/cancel', verifyHmac, (req, res) =>
  res.json({ id: req.params.id, status: 'canceled' })
);
app.post('/v1/appointments/:id/reschedule', verifyHmac, (req, res) =>
  res.json({ id: req.params.id, status: 'confirmed' })
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on :${port}`));
