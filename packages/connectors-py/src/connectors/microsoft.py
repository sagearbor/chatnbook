from __future__ import annotations

from datetime import datetime
from typing import List, Tuple

import requests

API_BASE = "https://graph.microsoft.com/v1.0"


def get_busy(token: str, user: str, start: datetime, end: datetime) -> List[Tuple[datetime, datetime]]:
    """Fetch busy intervals from Microsoft Graph within [start, end)."""
    url = f"{API_BASE}/me/calendar/getSchedule"
    payload = {
        "schedules": [user],
        "startTime": {"dateTime": start.isoformat(), "timeZone": "UTC"},
        "endTime": {"dateTime": end.isoformat(), "timeZone": "UTC"},
    }
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.post(url, json=payload, headers=headers, timeout=10)
    resp.raise_for_status()
    items = resp.json()["value"][0].get("scheduleItems", [])
    busy: List[Tuple[datetime, datetime]] = []
    for item in items:
        busy.append((datetime.fromisoformat(item["start"]["dateTime"]), datetime.fromisoformat(item["end"]["dateTime"])))
    return busy


def create_event(
    token: str,
    calendar_id: str,
    start: datetime,
    end: datetime,
    subject: str,
) -> str:
    """Create an event and return its ID."""
    base = f"{API_BASE}/me"
    if calendar_id:
        url = f"{base}/calendars/{calendar_id}/events"
    else:
        url = f"{base}/events"
    payload = {
        "subject": subject,
        "start": {"dateTime": start.isoformat(), "timeZone": "UTC"},
        "end": {"dateTime": end.isoformat(), "timeZone": "UTC"},
    }
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.post(url, json=payload, headers=headers, timeout=10)
    resp.raise_for_status()
    return resp.json()["id"]
