# -*- coding: utf-8 -*-
from datetime import datetime, timezone

import responses

from connectors.google import get_busy, create_event


def dt(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc)


class TestGoogleConnector:
    @responses.activate
    def test_busy_intervals_parsed(self):
        """Parses busy periods from freeBusy API."""
        start = dt(2025, 8, 20, 9)
        end = dt(2025, 8, 20, 17)
        responses.add(
            responses.POST,
            "https://www.googleapis.com/calendar/v3/freeBusy",
            json={
                "calendars": {
                    "cal": {
                        "busy": [
                            {"start": dt(2025, 8, 20, 10).isoformat(), "end": dt(2025, 8, 20, 11).isoformat()}
                        ]
                    }
                }
            },
            status=200,
        )
        busy = get_busy("tok", "cal", start, end)
        assert busy == [(dt(2025, 8, 20, 10), dt(2025, 8, 20, 11))]

    @responses.activate
    def test_create_event_returns_id(self):
        """Returns event id on creation."""
        responses.add(
            responses.POST,
            "https://www.googleapis.com/calendar/v3/calendars/cal/events",
            json={"id": "evt_123"},
            status=200,
        )
        eid = create_event("tok", "cal", dt(2025, 8, 20, 12), dt(2025, 8, 20, 13), "Lunch")
        assert eid == "evt_123"
