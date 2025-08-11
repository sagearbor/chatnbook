from datetime import datetime
import pytz

from connectors.ics import parse_ics_busy


def test_parse_ics_busy_extracts_events_in_range():
    ics = """BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART:20240101T100000Z\nDTEND:20240101T110000Z\nSUMMARY:Event 1\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20240102T120000Z\nDTEND:20240102T130000Z\nSUMMARY:Event 2\nEND:VEVENT\nEND:VCALENDAR\n"""
    start = datetime(2024, 1, 1, 0, 0, tzinfo=pytz.UTC)
    end = datetime(2024, 1, 2, 0, 0, tzinfo=pytz.UTC)
    busy = parse_ics_busy(ics, start, end)
    assert busy == [
        (datetime(2024, 1, 1, 10, 0, tzinfo=pytz.UTC), datetime(2024, 1, 1, 11, 0, tzinfo=pytz.UTC))
    ]
