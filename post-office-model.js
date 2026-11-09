/* Local Post Office workspace model. No network, storage, or CRM side effects. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TK_POST_OFFICE_MODEL = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function defaults() {
    const categories = [
      { id: 'pre-production', name: 'Pre-production', color: '#D97706' },
      { id: 'production', name: 'Production', color: '#2563EB' },
      { id: 'post-production', name: 'Post-production', color: '#7C3AED' }
    ];
    const tasks = [
      ['Brief', 'Estimate', 'Crew', 'Call sheet'],
      ['Safety', 'Footage backups'],
      ['Edit', 'Grade', 'Sound', 'Approval', 'Delivery']
    ];
    return { categories, projects: [], bookings: [], templates: categories.map((category, i) => ({
      id: category.id + '-checklist', name: category.name, categoryId: category.id,
      items: tasks[i].map((text, j) => ({ id: category.id + '-' + j, text, done: false }))
    })) };
  }

  // RFC-style CSV: escaped quotes, embedded CR/LF, CRLF records, and a UTF-8 BOM.
  // Invalid structure throws; importBookings converts it to a file-level error.
  function csvRecords(text, keepEmpty = false) {
    if (typeof text !== 'string') throw new TypeError('CSV must be text');
    text = text.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', quoted = false, closed = false;
    function cell() { row.push(field); field = ''; closed = false; }
    function record() { cell(); if (keepEmpty || row.some(value => value.trim() !== '')) rows.push(row); row = []; }
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { quoted = false; closed = true; }
        } else field += char;
      } else if (char === ',') cell();
      else if (char === '\r' || char === '\n') {
        record(); if (char === '\r' && text[i + 1] === '\n') i++;
      } else if (char === '"' && !field && !closed) quoted = true;
      else if (closed || char === '"') throw new Error('Unexpected character near CSV record ' + (rows.length + 1));
      else field += char;
    }
    if (quoted) throw new Error('Unterminated quoted CSV field');
    if (field || row.length || closed) record();
    return rows;
  }
  function parseCSV(text) {
    const rows = csvRecords(text);
    if (!rows.length) return [];
    const headers = rows.shift().map(value => value.trim().toLowerCase());
    if (headers.some(value => !value) || new Set(headers).size !== headers.length) {
      throw new Error('CSV headers must be nonempty and unique');
    }
    return rows.map((values, i) => {
      if (values.length !== headers.length) throw new Error('Wrong number of fields in CSV record ' + (i + 2));
      return Object.fromEntries(headers.map((header, j) => [header, values[j]]));
    });
  }

  const normalize = value => String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
  function timestamp(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
    if (!match) throw new Error('Use YYYY-MM-DD or an ISO datetime with a timezone');
    const [, year, month, day, hour, minute, second, , zone] = match;
    const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (+month < 1 || +month > 12 || +day < 1 || +day > days[+month - 1] ||
        (hour !== undefined && (+hour > 23 || +minute > 59 || +(second || 0) > 59)) ||
        (zone && zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) {
      throw new Error('Invalid calendar date or time');
    }
    const allDay = hour === undefined;
    const time = Date.parse(allDay ? value + 'T00:00:00Z' : value);
    if (!Number.isFinite(time)) throw new Error('Invalid date');
    return { time, allDay, value: allDay ? value : new Date(time).toISOString() };
  }
  function bookingKey(booking) {
    const dateKey = value => { try { return timestamp(String(value).trim()).value; } catch (_) { return normalize(value); } };
    const key = [normalize(booking.title), dateKey(booking.start), dateKey(booking.end), normalize(booking.client)];
    if (booking.projectId != null && booking.projectId !== '') key.push(String(booking.projectId));
    return JSON.stringify(key);
  }

  // Returns only newly accepted bookings; callers append these to existing state.
  // errors: [{row, message}] (header = row 1); duplicates: number skipped.
  function importBookings(text, categories = defaults().categories, existing = []) {
    const result = { bookings: [], errors: [], duplicates: 0 };
    let rows;
    try { rows = parseCSV(text); }
    catch (error) { result.errors.push({ row: 1, message: error.message }); return result; }
    const seen = new Set(existing.map(bookingKey));
    rows.forEach((row, i) => {
      try {
        for (const name of ['title', 'start', 'end']) {
          if (!row[name] || !row[name].trim()) throw new Error(name + ' is required');
        }
        const start = timestamp(row.start.trim()), end = timestamp(row.end.trim());
        if (start.allDay !== end.allDay) throw new Error('Start and end must both be dates or both be datetimes');
        if (end.time <= start.time) throw new Error('End must be after start');
        const category = categories.find(item => normalize(item.id) === normalize(row.category) || normalize(item.name) === normalize(row.category));
        if (normalize(row.category) && !category) throw new Error('Unknown category: ' + row.category);
        const booking = {
          title: row.title.trim(), start: start.value, end: end.value, allDay: start.allDay,
          categoryId: category ? category.id : (categories[0] ? categories[0].id : null),
          client: (row.client || '').trim(), location: (row.location || '').trim(), notes: (row.notes || '').trim()
        };
        const key = bookingKey(booking);
        if (seen.has(key)) { result.duplicates++; return; }
        // Full content encoded, not a short hash: deterministic without collision risk.
        booking.id = 'po-' + encodeURIComponent(key);
        seen.add(key); result.bookings.push(booking);
      } catch (error) { result.errors.push({ row: i + 2, message: error.message }); }
    });
    return result;
  }

  // Pure preview API. No changes to existing bookings or project state.
  // source rows/columns are one-based CSV record/cell positions, including blanks.
  function importSchedule(text, categories = defaults().categories, existing = [], options = {}) {
    const metadata = { title: '', client: '', agency: '', deliverables: '' };
    const result = { bookings: [], errors: [], duplicates: 0, metadata, warnings: [] };
    let records;
    try { records = csvRecords(text, true); }
    catch (error) { result.errors.push({ row: 1, message: error.message }); return result; }
    const seen = new Set(existing.map(bookingKey));
    function accept(booking, source) {
      if (options.projectId != null && options.projectId !== '') booking.projectId = options.projectId;
      const key = bookingKey(booking);
      if (seen.has(key)) { result.duplicates++; return; }
      booking.id = 'po-' + encodeURIComponent(key);
      booking.source = { ...source, metadata: { ...metadata } };
      seen.add(key); result.bookings.push(booking);
    }
    const weekdays = [/^mon(day)?$/, /^tue(s|sday)?$/, /^wed(nesday)?$/, /^thu(rs|rsday)?$/, /^fri(day)?$/, /^sat(urday)?$/, /^sun(day)?$/];
    const gridHeader = records.findIndex(row => row.length === 7 && row.every((value, i) => weekdays[i].test(normalize(value))));
    if (gridHeader < 0) {
      const standard = importBookings(text, categories);
      result.errors = standard.errors;
      result.duplicates = standard.duplicates;
      let rows = [];
      try { rows = parseCSV(text); } catch (_) { /* importBookings reports parse errors. */ }
      standard.bookings.forEach(booking => {
        const index = rows.findIndex(row => bookingKey(row) === bookingKey(booking));
        accept(booking, { format: 'standard', row: index + 2 });
      });
      return result;
    }

    let deliverableColumn = -1;
    const deliverables = [];
    for (let r = 0; r < gridHeader; r++) {
      records[r].forEach((value, column) => {
        const match = /^(agency|client|titles?|deliverables)\s*:\s*(.*)$/i.exec(value.trim());
        if (!match) return;
        const field = match[1].toLowerCase().replace(/^titles?$/, 'title');
        if (field === 'deliverables') { deliverableColumn = column; if (match[2]) deliverables.push(match[2]); }
        else metadata[field] = match[2];
      });
      if (deliverableColumn >= 0) {
        const value = (records[r][deliverableColumn] || '').trim();
        if (value && !/^(agency|client|titles?|deliverables)\s*:/i.test(value) && !/^\d{4}$/.test(value)) deliverables.push(value);
      }
    }
    metadata.deliverables = deliverables.join('\n');
    const printedYears = records.slice(0, gridHeader).flat().map(value => value.trim()).filter(value => /^\d{4}$/.test(value));
    let year = options.year == null ? Number(printedYears.at(-1)) : Number(options.year);
    if (!Number.isInteger(year) || year < 1000 || year > 9998) {
      result.errors.push({ row: gridHeader + 1, message: 'Schedule requires a four-digit year in the grid or options.year' });
      return result;
    }
    if (options.year != null && printedYears.length && year !== Number(printedYears.at(-1))) {
      result.warnings.push('options.year overrides the printed schedule year ' + printedYears.at(-1));
    }
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const datePattern = /^(\d{1,2})\s*(?:-\s*|\s+)(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s*[-,]?\s*(\d{4}))?$/i;
    const phaseId = value => ({ preproduction: 'pre-production', shootwindow: 'production', production: 'production', postproduction: 'post-production' })[normalize(value).replace(/[\s-]/g, '')];
    let phase = 'pre-production', previousMonth = null, week = null;
    function flushWeek() {
      if (!week) return;
      // Date headers run row-major (week, then Mon..Sun). Apply each day's
      // phase labels before carrying the phase into the following day/week.
      for (let column = 0; column < 7; column++) {
        for (const { row, values } of week.rows) {
          const title = (values[column] || '').trim();
          if (!title) continue;
          const label = phaseId(title);
          if (label) phase = label;
          const start = week.dates[column];
          if (!start) { result.errors.push({ row, column: column + 1, message: 'Milestone has no valid date: ' + title }); continue; }
          const category = categories.find(item => item.id === phase);
          if (!category) { result.errors.push({ row, column: column + 1, message: 'Missing phase category: ' + phase }); continue; }
          const availability = /\b(?:N\/?A|NOT AVAILABLE|UNAVAILABLE)$/i.test(title);
          accept({ title, start, end: new Date(timestamp(start).time + 86400000).toISOString().slice(0, 10),
            allDay: true, categoryId: category.id, client: metadata.client, location: '',
            notes: availability ? 'Availability note: ' + title : '' },
          { format: 'weekly-grid', row, column: column + 1, dateRow: week.row,
            dateCell: week.cells[column], phase, kind: label ? 'phase-marker' : availability ? 'availability-note' : 'milestone' });
        }
      }
    }
    for (let r = gridHeader + 1; r < records.length; r++) {
      const values = records[r];
      if (values.every(value => !value.trim())) continue;
      if (values.length !== 7) { result.errors.push({ row: r + 1, message: 'Weekly grid must have seven columns' }); continue; }
      if (values.every((value, i) => weekdays[i].test(normalize(value)))) continue;
      if (values.some(value => datePattern.test(value.trim()))) {
        flushWeek();
        const dates = values.map((value, column) => {
          try {
            const match = datePattern.exec(value.trim());
            if (!match) throw new Error('Expected a day-month date header');
            const month = months.indexOf(match[2].slice(0, 3).toLowerCase()) + 1;
            if (match[3]) year = Number(match[3]);
            else if (previousMonth === 12 && month === 1) year++;
            previousMonth = month;
            const date = `${year}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
            return timestamp(date).value;
          } catch (error) { result.errors.push({ row: r + 1, column: column + 1, message: error.message }); return null; }
        });
        week = { dates, cells: values.slice(), row: r + 1, rows: [] };
      } else if (week) week.rows.push({ row: r + 1, values });
      else result.warnings.push('Skipped undated grid record ' + (r + 1));
    }
    flushWeek();
    if (!week) result.errors.push({ row: gridHeader + 1, message: 'No date headers found in weekly grid' });
    return result;
  }

  // Decimal arithmetic avoids binary floating-point half-cent errors. Inputs and
  // outputs are currency units (e.g. dollars), rounded per line to integer cents.
  function decimal(value, label) {
    if ((typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value)) || Number(value) < 0) {
      throw new TypeError(label + ' must be a finite nonnegative number');
    }
    const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value).trim());
    if (!match) throw new TypeError(label + ' must be a decimal number');
    const scale = (match[2] || '').length - Number(match[3] || 0);
    const digits = BigInt(match[1] + (match[2] || ''));
    return scale >= 0 ? [digits, 10n ** BigInt(scale)] : [digits * 10n ** BigInt(-scale), 1n];
  }
  const round = (numerator, denominator) => (numerator * 2n + denominator) / (denominator * 2n);
  function cents(qty, rate) { return round(qty[0] * rate[0] * 100n, qty[1] * rate[1]); }
  function money(value) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Amount exceeds safe cents range');
    return Number(value) / 100;
  }
  function totals(lines, gstPercent = 15) {
    if (!Array.isArray(lines)) throw new TypeError('Lines must be an array');
    const percent = decimal(gstPercent, 'GST');
    let subtotal = 0n, cost = 0n, known = true;
    lines.forEach(line => {
      if (!line || typeof line !== 'object') throw new TypeError('Invalid line');
      const qty = decimal(line.qty, 'Quantity');
      subtotal += cents(qty, decimal(line.rate, 'Rate'));
      if (line.cost == null || line.cost === '') known = false;
      else cost += cents(qty, decimal(line.cost, 'Cost'));
    });
    const gst = round(subtotal * percent[0], percent[1] * 100n);
    const profit = subtotal - cost;
    return { subtotal: money(subtotal), gst: money(gst), total: money(subtotal + gst),
      cost: known ? money(cost) : null, profit: known ? money(profit) : null,
      margin: known && subtotal > 0n ? Number(profit) / Number(subtotal) * 100 : null };
  }

  return { defaults, parseCSV, importBookings, importSchedule, totals };
});
