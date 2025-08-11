import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

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
app.post('/v1/appointments', (_req, res) => res.status(201).json({ id: 'apt_stub', status: 'requested' }));
app.post('/v1/appointments/:id/cancel', (req, res) => res.json({ id: req.params.id, status: 'canceled' }));
app.post('/v1/appointments/:id/reschedule', (req, res) => res.json({ id: req.params.id, status: 'confirmed' }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on :${port}`));
