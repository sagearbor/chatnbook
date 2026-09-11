"""JSON-over-stdio bridge so the TypeScript API can call the calendar
connectors without re-implementing Google/Microsoft calendar logic in TS.

This is intentionally the *only* interface the TS side depends on: it reads
one JSON request object from stdin, performs the requested action using the
existing google.py / microsoft.py / ics.py / availability.py modules, and
writes one JSON response object to stdout, then exits 0 on success or 1 on
failure. Every datetime in requests/responses is an ISO-8601 string.

Usage (see packages/api/src/connectors/python-calendar-connector.ts):
    echo '{"action": "get_busy", "provider": "google", ...}' | \
        python3 -m connectors.cli

Request shapes:
  get_busy:
    {"action": "get_busy", "provider": "google"|"microsoft"|"ics",
     "token": str (google/microsoft), "calendarId": str (google/microsoft),
     "icsData": str (ics), "start": iso, "end": iso}
    -> {"ok": true, "result": {"busy": [[startIso, endIso], ...]}}

  create_event:
    {"action": "create_event", "provider": "google"|"microsoft",
     "token": str, "calendarId": str, "start": iso, "end": iso,
     "summary": str}
    -> {"ok": true, "result": {"eventId": str}}

  delete_event:
    {"action": "delete_event", "provider": "google"|"microsoft",
     "token": str, "calendarId": str, "eventId": str}
    -> {"ok": true, "result": {}}
    Tolerates the event already being gone (404/410 from the provider) --
    see google.delete_event / microsoft.delete_event.

  compute_availability:
    {"action": "compute_availability", "start": iso, "end": iso,
     "busy": [[startIso, endIso], ...], "slotMinutes": int}
    -> {"ok": true, "result": {"slots": [[startIso, endIso], ...]}}

  On error: {"ok": false, "error": str}
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from typing import Any, Dict, List, Tuple

from . import google, microsoft, ics
from .availability import compute_availability


def _parse_dt(value: str) -> datetime:
    # Accept a trailing "Z" (not handled by datetime.fromisoformat before
    # Python 3.11 in all cases) by normalizing it to +00:00.
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value)


def _busy_to_json(busy: List[Tuple[datetime, datetime]]) -> List[List[str]]:
    return [[s.isoformat(), e.isoformat()] for s, e in busy]


def _busy_from_json(raw: List[List[str]]) -> List[Tuple[datetime, datetime]]:
    return [(_parse_dt(s), _parse_dt(e)) for s, e in raw]


def handle_get_busy(req: Dict[str, Any]) -> Dict[str, Any]:
    provider = req.get("provider")
    start = _parse_dt(req["start"])
    end = _parse_dt(req["end"])
    if provider == "google":
        busy = google.get_busy(req["token"], req["calendarId"], start, end)
    elif provider == "microsoft":
        busy = microsoft.get_busy(req["token"], req["calendarId"], start, end)
    elif provider == "ics":
        busy = ics.parse_ics_busy(req["icsData"], start, end)
    else:
        raise ValueError(f"unknown provider: {provider!r}")
    return {"busy": _busy_to_json(busy)}


def handle_create_event(req: Dict[str, Any]) -> Dict[str, Any]:
    provider = req.get("provider")
    start = _parse_dt(req["start"])
    end = _parse_dt(req["end"])
    if provider == "google":
        event_id = google.create_event(req["token"], req["calendarId"], start, end, req["summary"])
    elif provider == "microsoft":
        event_id = microsoft.create_event(req["token"], req["calendarId"], start, end, req["summary"])
    else:
        raise ValueError(f"provider does not support create_event: {provider!r}")
    return {"eventId": event_id}


def handle_delete_event(req: Dict[str, Any]) -> Dict[str, Any]:
    provider = req.get("provider")
    if provider == "google":
        google.delete_event(req["token"], req["calendarId"], req["eventId"])
    elif provider == "microsoft":
        microsoft.delete_event(req["token"], req["calendarId"], req["eventId"])
    else:
        raise ValueError(f"provider does not support delete_event: {provider!r}")
    return {}


def handle_compute_availability(req: Dict[str, Any]) -> Dict[str, Any]:
    start = _parse_dt(req["start"])
    end = _parse_dt(req["end"])
    busy = _busy_from_json(req.get("busy", []))
    slot_minutes = int(req.get("slotMinutes", 30))
    slots = compute_availability(start, end, busy, slot_minutes)
    return {"slots": _busy_to_json(slots)}


ACTIONS = {
    "get_busy": handle_get_busy,
    "create_event": handle_create_event,
    "delete_event": handle_delete_event,
    "compute_availability": handle_compute_availability,
}


def main(argv: List[str] = None) -> int:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
        action = req.get("action")
        handler = ACTIONS.get(action)
        if handler is None:
            raise ValueError(f"unknown action: {action!r}")
        result = handler(req)
        json.dump({"ok": True, "result": result}, sys.stdout)
        return 0
    except Exception as exc:  # noqa: BLE001 - deliberately broad: this is a CLI boundary
        json.dump({"ok": False, "error": str(exc)}, sys.stdout)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
