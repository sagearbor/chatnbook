import type { Request } from 'express';

export interface Notification {
  to: { email?: string; phone?: string };
  type: 'appointment_requested' | 'appointment_canceled' | 'appointment_rescheduled';
  payload: unknown;
}

function scrubPII(n: Notification): Notification {
  return {
    ...n,
    to: {
      email: n.to.email ? '[redacted]' : undefined,
      phone: n.to.phone ? '[redacted]' : undefined,
    },
  };
}

export async function sendNotification(n: Notification): Promise<void> {
  const redacted = scrubPII(n);
  console.log('notify', JSON.stringify(redacted));
}

export function extractContact(req: Request): { email?: string; phone?: string } {
  const email = req.body?.customer?.email;
  const phone = req.body?.customer?.phone;
  return { email, phone };
}
