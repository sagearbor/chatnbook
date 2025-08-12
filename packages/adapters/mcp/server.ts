import express from 'express';
import path from 'path';
import crypto from 'crypto';

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const HMAC_SECRET = process.env.AGENT_HMAC_SECRET || '';

function sign(body: unknown) {
  if (!HMAC_SECRET) throw new Error('AGENT_HMAC_SECRET not configured');
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(JSON.stringify(body || ''))
    .digest('base64');
}

export async function listAvailability(params: {
  serviceId: string;
  start: string;
  end: string;
  tz: string;
}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/v1/availability?${qs}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function createAppointment(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${API_BASE}/v1/appointments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      'X-Signature': sign(payload),
    },
    body,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function cancelAppointment({ id }: { id: string }) {
  const body: Record<string, never> = {};
  const res = await fetch(`${API_BASE}/v1/appointments/${id}/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': sign(body),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

const app = express();
app.use(express.json());

app.get('/schema', (_req, res) => {
  res.sendFile(path.join(__dirname, 'schema.json'));
});

app.post('/call/:tool', async (req, res) => {
  try {
    let result;
    switch (req.params.tool) {
      case 'listAvailability':
        result = await listAvailability(req.body);
        break;
      case 'createAppointment':
        result = await createAppointment(req.body);
        break;
      case 'cancelAppointment':
        result = await cancelAppointment(req.body);
        break;
      default:
        return res.status(404).json({ error: 'Unknown tool' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

if (process.env.NODE_ENV !== 'test') {
  const port = process.env.MCP_PORT || 4001;
  app.listen(port, () => console.log(`MCP server listening on :${port}`));
}

export { app };

