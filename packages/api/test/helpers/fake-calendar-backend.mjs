// A minimal stand-in for the real Google Calendar v3 API, shaped exactly
// like what packages/connectors-py/src/connectors/google.py calls:
//   POST   {base}/freeBusy                             -> { calendars: { <id>: { busy: [...] } } }
//   POST   {base}/calendars/{calendarId}/events         -> { id: <new event id> }
//   DELETE {base}/calendars/{calendarId}/events/{id}    -> 204, or 404 if unknown
// Point GOOGLE_CALENDAR_API_BASE at this server's `base` to make the real
// python connector (via python -m connectors.cli, spawned by
// PythonCalendarConnector) talk to this instead of the real Google API.
import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

export function startFakeCalendarBackend() {
  const busyByCalendar = new Map(); // calendarId -> [{start, end}]
  const createdEvents = []; // { calendarId, summary, start, end, id }
  const deletedEvents = []; // { calendarId, id }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'POST' && url.pathname === '/freeBusy') {
        const payload = JSON.parse(body || '{}');
        const calendarId = payload.items?.[0]?.id;
        const busy = busyByCalendar.get(calendarId) || [];
        res.writeHead(200);
        res.end(JSON.stringify({ calendars: { [calendarId]: { busy } } }));
        return;
      }

      const eventsMatch = url.pathname.match(/^\/calendars\/([^/]+)\/events$/);
      if (req.method === 'POST' && eventsMatch) {
        const calendarId = decodeURIComponent(eventsMatch[1]);
        const payload = JSON.parse(body || '{}');
        const id = `fake_gcal_evt_${crypto.randomBytes(6).toString('hex')}`;
        createdEvents.push({
          calendarId,
          summary: payload.summary,
          start: payload.start?.dateTime,
          end: payload.end?.dateTime,
          id,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ id }));
        return;
      }

      const deleteMatch = url.pathname.match(/^\/calendars\/([^/]+)\/events\/([^/]+)$/);
      if (req.method === 'DELETE' && deleteMatch) {
        const calendarId = decodeURIComponent(deleteMatch[1]);
        const eventId = decodeURIComponent(deleteMatch[2]);
        const idx = createdEvents.findIndex((e) => e.calendarId === calendarId && e.id === eventId);
        if (idx === -1) {
          // Mirrors the real Google Calendar API's response for an
          // unknown/already-deleted event -- google.py's delete_event
          // treats this as success, not an error.
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        deletedEvents.push(createdEvents[idx]);
        createdEvents.splice(idx, 1);
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: `no such fake endpoint: ${req.method} ${url.pathname}` }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        /** Pre-seed busy intervals the fake freeBusy endpoint should report for a calendar. */
        setBusy(calendarId, intervals) {
          busyByCalendar.set(calendarId, intervals);
        },
        createdEvents,
        deletedEvents,
        async close() {
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}
