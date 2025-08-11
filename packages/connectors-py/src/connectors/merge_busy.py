from datetime import datetime
from typing import List, Tuple

# Merge overlapping busy intervals [(start_dt, end_dt), ...]
def merge_busy(intervals: List[Tuple[datetime, datetime]]):
    if not intervals: return []
    intervals = sorted(intervals, key=lambda x: x[0])
    merged = [intervals[0]]
    for start, end in intervals[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged
