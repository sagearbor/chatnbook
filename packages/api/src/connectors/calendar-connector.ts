// Interface the API uses to talk to the Google/Microsoft/ICS calendar
// connector logic that lives in packages/connectors-py. The default
// production implementation (PythonCalendarConnector) shells out to
// `python -m connectors.cli`, a small JSON-over-stdio bridge -- see
// packages/connectors-py/src/connectors/cli.py for the request/response
// shapes this mirrors. API tests inject a fake implementing this same
// interface instead of spawning python (see test/appointments-connector.test.js).

export type CalendarProvider = 'google' | 'microsoft' | 'ics';

export interface BusyInterval {
  start: string; // ISO-8601
  end: string; // ISO-8601
}

export interface GetBusyParams {
  provider: CalendarProvider;
  start: string; // ISO-8601
  end: string; // ISO-8601
  token?: string; // required for google/microsoft
  calendarId?: string; // required for google/microsoft
  icsData?: string; // required for ics
}

export interface CreateEventParams {
  provider: 'google' | 'microsoft';
  token: string;
  calendarId: string;
  start: string; // ISO-8601
  end: string; // ISO-8601
  summary: string;
}

export interface AvailabilitySlot {
  start: string; // ISO-8601
  end: string; // ISO-8601
}

export interface ComputeAvailabilityParams {
  start: string; // ISO-8601
  end: string; // ISO-8601
  busy: BusyInterval[];
  slotMinutes: number;
}

export interface CalendarConnector {
  getBusy(params: GetBusyParams): Promise<BusyInterval[]>;
  createEvent(params: CreateEventParams): Promise<{ eventId: string }>;
  computeAvailability(params: ComputeAvailabilityParams): Promise<AvailabilitySlot[]>;
}

/** Thrown when the connector process reports a handled error (ok: false). */
export class ConnectorError extends Error {}
