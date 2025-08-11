from __future__ import annotations

from datetime import datetime
from typing import List, Tuple

import requests

API_BASE = "https://www.googleapis.com/calendar/v3"


def get_busy(token: str, calendar_id: str, start: datetime, end: datetime) -> List[Tuple[datetime, datetime]]:
    """Fetch busy intervals from Google Calendar within [start, end)."""
    url = f"{API_BASE}/freeBusy"
    payload = {
        "timeMin": start.isoformat(),
        "timeMax": end.isoformat(),
        "items": [{"id": calendar_id}],
    }
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.post(url, json=payload, headers=headers, timeout=10)
    resp.raise_for_status()
    data = resp.json()["calendars"][calendar_id]["busy"]
    busy: List[Tuple[datetime, datetime]] = []
    for block in data:
        busy.append((datetime.fromisoformat(block["start"]), datetime.fromisoformat(block["end"])))
    return busy


def create_event(
    token: str,
    calendar_id: str,
    start: datetime,
    end: datetime,
    summary: str,
) -> str:
    """Create an event and return its ID."""
    url = f"{API_BASE}/calendars/{calendar_id}/events"
    payload = {
        "summary": summary,
        "start": {"dateTime": start.isoformat()},
        "end": {"dateTime": end.isoformat()},
    }
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.post(url, json=payload, headers=headers, timeout=10)
    resp.raise_for_status()
    return resp.json()["id"]
