# -*- coding: utf-8 -*-
from datetime import datetime
import pytz

from connectors.merge_busy import merge_busy

TZ = pytz.timezone("America/New_York")


def dt(y, m, d, hh, mm=0):
    return TZ.localize(datetime(y, m, d, hh, mm))


class TestDSTHandling:
    def test_merges_across_spring_forward_gap(self):
        """Merges across spring-forward gap on 2025-03-09 US/Eastern."""
        # DST spring forward 2025-03-09 (02:00 → 03:00)
        before_gap = (dt(2025, 3, 9, 1, 30), dt(2025, 3, 9, 2, 0))
        after_gap  = (dt(2025, 3, 9, 3, 0), dt(2025, 3, 9, 4, 0))
        merged = merge_busy([before_gap, after_gap])
        assert len(merged) == 1
        assert merged[0][0] == before_gap[0]
        assert merged[0][1] == after_gap[1]

    def test_merges_across_fall_back_overlap(self):
        """Merges across fall-back overlap on 2025-11-02 US/Eastern."""
        # DST fall back 2025-11-02 (02:00 repeats)
        first  = (dt(2025, 11, 2, 0, 30), dt(2025, 11, 2, 1, 30))
        second = (dt(2025, 11, 2, 1, 0),  dt(2025, 11, 2, 2, 30))
        merged = merge_busy([first, second])
        assert len(merged) == 1
        assert merged[0][0] == first[0]
        assert merged[0][1] == second[1]
