from datetime import datetime, timedelta
from typing import List, Tuple

from .merge_busy import merge_busy

# Compute available slots given working window and busy intervals

def compute_availability(
    start: datetime,
    end: datetime,
    busy: List[Tuple[datetime, datetime]],
    slot_minutes: int,
):
    """Return available [start, end] slots within window.

    Args:
        start: window start (timezone-aware)
        end: window end (timezone-aware)
        busy: list of busy intervals
        slot_minutes: length of each slot in minutes
    """
    merged_busy = merge_busy(busy)
    slots: List[Tuple[datetime, datetime]] = []
    step = timedelta(minutes=slot_minutes)
    cursor = start
    tz = start.tzinfo
    while cursor + step <= end:
        nxt = tz.normalize(cursor + step) if hasattr(tz, "normalize") else cursor + step
        overlap = any(not (nxt <= b_start or cursor >= b_end) for b_start, b_end in merged_busy)
        if not overlap:
            slots.append((cursor, nxt))
        cursor = nxt
    return slots
