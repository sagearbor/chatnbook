# -*- coding: utf-8 -*-
from datetime import datetime
import pytz

from connectors.availability import compute_availability

TZ = pytz.timezone("America/New_York")

def dt(y, m, d, hh, mm=0):
    return TZ.localize(datetime(y, m, d, hh, mm))

class TestAvailabilityBasic:
    def test_skips_busy_slots(self):
        """Excludes busy blocks from returned slots."""
        start = dt(2025, 8, 20, 9, 0)
        end = dt(2025, 8, 20, 12, 0)
        busy = [(dt(2025, 8, 20, 10, 0), dt(2025, 8, 20, 11, 0))]
        slots = compute_availability(start, end, busy, 60)
        assert [(s[0].hour, s[1].hour) for s in slots] == [(9, 10), (11, 12)]

class TestAvailabilityDST:
    def test_handles_spring_forward_gap(self):
        """Skips the missing 02:00 hour on spring forward."""
        start = dt(2025, 3, 9, 0, 0)
        end = dt(2025, 3, 9, 5, 0)
        slots = compute_availability(start, end, [], 60)
        assert [s[0].hour for s in slots] == [0, 1, 3, 4]

    def test_handles_fall_back_overlap(self):
        """Returns both 01:00 slots when falling back."""
        start = dt(2025, 11, 2, 0, 0)
        end = dt(2025, 11, 2, 5, 0)
        slots = compute_availability(start, end, [], 60)
        assert [s[0].hour for s in slots] == [0, 1, 1, 2, 3, 4]
        assert len(slots) == 6
