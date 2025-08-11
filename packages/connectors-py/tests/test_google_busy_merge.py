# -*- coding: utf-8 -*-
from datetime import datetime
import copy
import pytz

from connectors.merge_busy import merge_busy

TZ = pytz.timezone("America/New_York")


def dt(y, m, d, hh, mm=0):
    return TZ.localize(datetime(y, m, d, hh, mm))


class TestGoogleBusyMerge:
    def test_overlapping_intervals_are_merged(self):
        """Merges [09:00–10:00] + [09:30–11:00] → [09:00–11:00]."""
        a1 = (dt(2025, 8, 20, 9, 0), dt(2025, 8, 20, 10, 0))
        a2 = (dt(2025, 8, 20, 9, 30), dt(2025, 8, 20, 11, 0))
        merged = merge_busy([a1, a2])
        assert len(merged) == 1
        assert merged[0][0] == a1[0]
        assert merged[0][1] == a2[1]

    def test_adjacent_intervals_are_merged_contiguously(self):
        """Merges touching intervals as one block [10:00–11:00] + [11:00–12:00] → [10:00–12:00]."""
        a1 = (dt(2025, 8, 20, 10, 0), dt(2025, 8, 20, 11, 0))
        a2 = (dt(2025, 8, 20, 11, 0), dt(2025, 8, 20, 12, 0))
        merged = merge_busy([a1, a2])
        assert len(merged) == 1
        assert merged[0][0] == a1[0]
        assert merged[0][1] == a2[1]

    def test_unsorted_input_is_sorted_before_merge(self):
        """Sorts then merges; keeps [14:00–15:00] separate; merges the 09:00 block."""
        a = (dt(2025, 8, 20, 14, 0), dt(2025, 8, 20, 15, 0))
        b = (dt(2025, 8, 20, 9, 0), dt(2025, 8, 20, 10, 0))
        c = (dt(2025, 8, 20, 9, 30), dt(2025, 8, 20, 10, 30))
        merged = merge_busy([a, c, b])  # intentionally shuffled
        assert len(merged) == 2
        assert merged[0][0] == b[0] and merged[0][1] == c[1]
        assert merged[1] == a

    def test_does_not_mutate_original_list(self):
        """Does not modify the original list of intervals."""
        intervals = [
            (dt(2025, 8, 20, 9, 0), dt(2025, 8, 20, 10, 0)),
            (dt(2025, 8, 20, 9, 30), dt(2025, 8, 20, 10, 30)),
        ]
        original = copy.deepcopy(intervals)
        _ = merge_busy(intervals)
        assert intervals == original
