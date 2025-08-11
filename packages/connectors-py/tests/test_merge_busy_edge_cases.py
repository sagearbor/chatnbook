# -*- coding: utf-8 -*-
from datetime import datetime
import pytz

from connectors.merge_busy import merge_busy

TZ = pytz.timezone("America/New_York")


def dt(y, m, d, hh, mm=0):
    return TZ.localize(datetime(y, m, d, hh, mm))


class TestEdgeCases:
    def test_empty_input_returns_empty_list(self):
        """Returns [] on empty input."""
        assert merge_busy([]) == []

    def test_single_interval_passthrough(self):
        """Passes through a single interval unchanged."""
        a = (dt(2025, 8, 20, 9, 0), dt(2025, 8, 20, 10, 0))
        merged = merge_busy([a])
        assert merged == [a]

    def test_multiple_disjoint_intervals_preserved(self):
        """Keeps disjoint intervals separate."""
        a = (dt(2025, 8, 20, 9, 0), dt(2025, 8, 20, 10, 0))
        b = (dt(2025, 8, 20, 11, 0), dt(2025, 8, 20, 12, 0))
        c = (dt(2025, 8, 20, 13, 0), dt(2025, 8, 20, 14, 0))
        merged = merge_busy([a, b, c])
        assert merged == [a, b, c]

    def test_nested_intervals_reduce_to_outer_bounds(self):
        """Reduces nested intervals to the outer bounds."""
        outer = (dt(2025, 8, 20, 9, 0), dt(2025, 8, 20, 12, 0))
        inner1 = (dt(2025, 8, 20, 9, 30), dt(2025, 8, 20, 10, 0))
        inner2 = (dt(2025, 8, 20, 10, 30), dt(2025, 8, 20, 11, 30))
        merged = merge_busy([inner1, outer, inner2])
        assert merged == [outer]
