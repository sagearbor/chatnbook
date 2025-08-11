import { Router } from 'express';
export const wellKnown = Router();
wellKnown.get('/.well-known/ai-actions.json', (_req, res) => {
  const actions = [{
    name: 'createAppointment',
    method: 'POST',
    url: '/v1/appointments',
    openapi: '/openapi.json'
  }];
  res.json({ actions });
});
