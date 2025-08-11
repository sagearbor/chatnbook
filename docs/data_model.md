# Data Model & Lifecycle

## Entities

### Account
- `id`: unique business identifier
- `email`: owner contact
- `createdAt`: ISO-8601 timestamp

### Service
- `id`: unique identifier
- `name`: display name
- `durationMinutes`: length of appointment
- `timezone`: IANA tz of service location

### ServiceHours
- `serviceId`: references a `Service`
- `dayOfWeek`: 0=Monday … 6=Sunday
- `start`: start time (HH:MM)
- `end`: end time (HH:MM)

### Appointment
- `id`: unique identifier
- `serviceId`: references a `Service`
- `customerName`
- `customerEmail`
- `start`: ISO-8601 start time
- `end`: ISO-8601 end time
- `status`: `requested` | `confirmed` | `canceled`
- `requiresConfirmation`: boolean (true when booked via ICS read-only)

## Lifecycle
1. **requested** – created via `/v1/appointments`.
2. **confirmed** – calendar write succeeds or owner approves tentative slot.
3. **canceled** – removed by user or owner via API.

Appointments should be idempotent when `clientToken` is reused to avoid double booking.
