# -*- coding: utf-8 -*-
from datetime import datetime, timezone

import responses

from connectors.microsoft import get_busy, create_event, delete_event


def dt(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc)


class TestMicrosoftConnector:
    @responses.activate
    def test_busy_intervals_parsed(self):
        """Parses busy periods from Graph getSchedule."""
        start = dt(2025, 8, 20, 9)
        end = dt(2025, 8, 20, 17)
        responses.add(
            responses.POST,
            "https://graph.microsoft.com/v1.0/me/calendar/getSchedule",
            json={
                "value": [
                    {
                        "scheduleItems": [
                            {
                                "start": {"dateTime": dt(2025, 8, 20, 10).isoformat()},
                                "end": {"dateTime": dt(2025, 8, 20, 11).isoformat()},
                            }
                        ]
                    }
                ]
            },
            status=200,
        )
        busy = get_busy("tok", "user@example.com", start, end)
        assert busy == [(dt(2025, 8, 20, 10), dt(2025, 8, 20, 11))]

    @responses.activate
    def test_create_event_returns_id(self):
        """Returns event id on creation."""
        responses.add(
            responses.POST,
            "https://graph.microsoft.com/v1.0/me/events",
            json={"id": "evt_ms"},
            status=200,
        )
        eid = create_event("tok", "", dt(2025, 8, 20, 12), dt(2025, 8, 20, 13), "Lunch")
        assert eid == "evt_ms"

    @responses.activate
    def test_delete_event_succeeds(self):
        """A normal delete returns cleanly."""
        responses.add(
            responses.DELETE,
            "https://graph.microsoft.com/v1.0/me/calendars/cal/events/evt_ms",
            status=204,
        )
        delete_event("tok", "cal", "evt_ms")  # no exception raised

    @responses.activate
    def test_delete_event_with_no_calendar_id_uses_default_calendar_route(self):
        """Mirrors create_event's branching: an empty calendar_id deletes
        from /me/events instead of /me/calendars/{id}/events."""
        responses.add(
            responses.DELETE,
            "https://graph.microsoft.com/v1.0/me/events/evt_default",
            status=204,
        )
        delete_event("tok", "", "evt_default")  # no exception raised

    @responses.activate
    def test_delete_event_tolerates_already_deleted_404(self):
        """A 404 (already deleted, e.g. a stale/duplicate cancel) is
        tolerated rather than raised."""
        responses.add(
            responses.DELETE,
            "https://graph.microsoft.com/v1.0/me/calendars/cal/events/evt_gone",
            status=404,
        )
        delete_event("tok", "cal", "evt_gone")  # no exception raised

    @responses.activate
    def test_delete_event_raises_on_other_errors(self):
        """A genuine failure (e.g. 401/500) still raises."""
        responses.add(
            responses.DELETE,
            "https://graph.microsoft.com/v1.0/me/calendars/cal/events/evt_x",
            status=500,
        )
        try:
            delete_event("tok", "cal", "evt_x")
        except Exception:
            pass
        else:
            raise AssertionError("expected an exception for a 500 response")
