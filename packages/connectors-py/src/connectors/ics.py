from __future__ import annotations

from datetime import datetime
from typing import List, Tuple

from icalendar import Calendar


def parse_ics_busy(ics_data: str, start: datetime, end: datetime) -> List[Tuple[datetime, datetime]]:
    """Return busy intervals from an ICS string within [start, end)."""
    cal = Calendar.from_ical(ics_data)
    busy: List[Tuple[datetime, datetime]] = []
    for component in cal.walk('VEVENT'):
        dt_start = component.decoded('DTSTART')
        dt_end = component.decoded('DTEND')
        if dt_end <= start or dt_start >= end:
            continue
        busy.append((dt_start, dt_end))
    busy.sort()
    return busy
