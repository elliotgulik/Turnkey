# Job Calendar

Open **Calendar** in the desktop navigation, or **More → Calendar** on mobile. The former floating Staff calendar shortcut also opens this page. **Logged hours** remains a separate view of time already submitted by workers, rather than planned appointments.

## Book or move a job

Choose **Book job**, an unbooked job, or an empty calendar slot. Select the existing TurnKey job, start and end time, then the staff who will work together. Multiple selected staff form the assigned team; the optional team label names that crew on this booking. This is not a separate reusable team-template manager.

Month, week, day and agenda views share the same saved appointments. Moving or resizing a booking must save successfully before the new position is confirmed. Shared-staff overlaps and blocked availability are checked on the server. Older date-only jobs are labelled as needing an appointment time, rather than inventing one.

Scheduling must preserve the sales stage and accepted quote pricing. A calendar appointment alone is not a new won sale or a customer quote acceptance.

## Busy days

Use **Block time** to reserve a day or date range for the whole business or a staff member. All-day ranges end at the next local midnight, so the final selected day is included. Existing jobs are not cancelled when time is blocked. Remove a native block explicitly when it is no longer needed.

## Google Calendar

The page reuses the Google Calendar connection already configured in Connections. Refresh busy times to import the current connected calendar data; the page shows its last sync time. External calendar events are displayed as read-only busy time. Staff filters also apply to bookings and imported busy events; business-wide closures remain visible.

Choose **Sync to my connected Google Calendar** when booking to create/update the appointment in the current user's connected account. This does not invite customers or grant access to another worker's Google account. Saving TurnKey's appointment and syncing Google are separate outcomes: a failed Google request leaves the booking saved and exposes a retry action.

Google event IDs are stable per business, job and connection so retries target the same event. [Google documents custom event IDs and primary-calendar insertion here](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert).

## Quote transfer from Google Earth

Extension **v0.2.3** adds **Send to ServiceM8** after Create Quote. It queues the existing draft through TurnKey's existing transfer worker. Check transfer reports queued/failed/transferred status and offers the ServiceM8 job link once available. It does not mark the quote approved or send an email to the customer. Failed attempts retain the TurnKey quote.

For an existing extension installation, open the extension popup and choose **Enable ServiceM8 transfers** if Chrome has not yet granted access to the configured backend. No ServiceM8 API key is entered into the extension.

## Deployment

Apply only `supabase/migrations/20261018035054_job_calendar_booking.sql` for this feature, preserving unrelated pending migrations. It extends the existing jobs, calendar-events and availability-block infrastructure through private write functions. Deploy the matching Express and static frontend changes. No new framework or external credentials are required; Google syncing requires an existing valid Google connection.
