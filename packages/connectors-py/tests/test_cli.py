# -*- coding: utf-8 -*-
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

import responses

from connectors import cli

CONNECTORS_SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/src"


def dt(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc)


class TestCliHandlers:
    @responses.activate
    def test_get_busy_google(self):
        """get_busy dispatches to the google connector and serializes intervals."""
        responses.add(
            responses.POST,
            "https://www.googleapis.com/calendar/v3/freeBusy",
            json={"calendars": {"cal1": {"busy": [
                {"start": dt(2026, 1, 5, 10).isoformat(), "end": dt(2026, 1, 5, 11).isoformat()}
            ]}}},
            status=200,
        )
        result = cli.handle_get_busy({
            "provider": "google", "token": "tok", "calendarId": "cal1",
            "start": dt(2026, 1, 5, 9).isoformat(), "end": dt(2026, 1, 5, 17).isoformat(),
        })
        assert result == {"busy": [["2026-01-05T10:00:00+00:00", "2026-01-05T11:00:00+00:00"]]}

    @responses.activate
    def test_create_event_microsoft(self):
        """create_event dispatches to the microsoft connector and returns eventId."""
        responses.add(
            responses.POST,
            "https://graph.microsoft.com/v1.0/me/calendars/cal1/events",
            json={"id": "evt_9"},
            status=200,
        )
        result = cli.handle_create_event({
            "provider": "microsoft", "token": "tok", "calendarId": "cal1",
            "start": dt(2026, 1, 5, 12).isoformat(), "end": dt(2026, 1, 5, 13).isoformat(),
            "summary": "Haircut",
        })
        assert result == {"eventId": "evt_9"}

    def test_compute_availability_excludes_busy(self):
        """compute_availability returns free slots, skipping busy ones."""
        result = cli.handle_compute_availability({
            "start": dt(2026, 1, 5, 9).isoformat(),
            "end": dt(2026, 1, 5, 11).isoformat(),
            "busy": [[dt(2026, 1, 5, 9, 30).isoformat(), dt(2026, 1, 5, 10).isoformat()]],
            "slotMinutes": 30,
        })
        assert result == {"slots": [["2026-01-05T09:00:00+00:00", "2026-01-05T09:30:00+00:00"],
                                     ["2026-01-05T10:00:00+00:00", "2026-01-05T10:30:00+00:00"],
                                     ["2026-01-05T10:30:00+00:00", "2026-01-05T11:00:00+00:00"]]}

    def test_get_busy_unknown_provider_raises(self):
        """An unrecognized provider raises ValueError so main() reports ok: false."""
        try:
            cli.handle_get_busy({
                "provider": "carrier-pigeon",
                "start": dt(2026, 1, 5, 9).isoformat(),
                "end": dt(2026, 1, 5, 17).isoformat(),
            })
        except ValueError as exc:
            assert "carrier-pigeon" in str(exc)
        else:
            raise AssertionError("expected ValueError")


class TestCliSubprocess:
    def test_subprocess_get_busy_ics(self):
        """The real `python -m connectors.cli` entrypoint works end to end over stdio."""
        ics_data = (
            "BEGIN:VCALENDAR\r\n"
            "VERSION:2.0\r\n"
            "BEGIN:VEVENT\r\n"
            "UID:1@example.com\r\n"
            "DTSTART:20260105T100000Z\r\n"
            "DTEND:20260105T110000Z\r\n"
            "SUMMARY:Busy\r\n"
            "END:VEVENT\r\n"
            "END:VCALENDAR\r\n"
        )
        req = {
            "action": "get_busy",
            "provider": "ics",
            "icsData": ics_data,
            "start": dt(2026, 1, 5, 9).isoformat(),
            "end": dt(2026, 1, 5, 17).isoformat(),
        }
        proc = subprocess.run(
            [sys.executable, "-m", "connectors.cli"],
            input=json.dumps(req),
            capture_output=True,
            text=True,
            cwd=CONNECTORS_SRC,
            timeout=10,
        )
        assert proc.returncode == 0, proc.stderr
        out = json.loads(proc.stdout)
        assert out["ok"] is True
        assert out["result"]["busy"] == [["2026-01-05T10:00:00+00:00", "2026-01-05T11:00:00+00:00"]]

    def test_subprocess_unknown_action_reports_error(self):
        """An unknown action exits 1 with ok: false, not a stack trace."""
        proc = subprocess.run(
            [sys.executable, "-m", "connectors.cli"],
            input=json.dumps({"action": "bogus"}),
            capture_output=True,
            text=True,
            cwd=CONNECTORS_SRC,
            timeout=10,
        )
        assert proc.returncode == 1
        out = json.loads(proc.stdout)
        assert out["ok"] is False
        assert "bogus" in out["error"]
