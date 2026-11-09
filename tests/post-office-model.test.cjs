const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');
const model = require('../post-office-model.js');
const header = 'title,start,end,category,client,location,notes\n';

test('browser and CommonJS exports provide independent, editable defaults', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../post-office-model.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.window.TK_POST_OFFICE_MODEL.importBookings, 'function');
  const first = model.defaults(), second = model.defaults();
  assert.deepEqual(first.categories.map(c => c.id), ['pre-production', 'production', 'post-production']);
  assert.deepEqual(first.templates.map(t => t.items.length), [4, 2, 5]);
  first.templates[0].items[0].text = 'Changed';
  first.categories[0].name = 'Changed';
  first.projects.push({ id: 'project' });
  assert.equal(second.templates[0].items[0].text, 'Brief');
  assert.equal(second.categories[0].name, 'Pre-production');
  assert.deepEqual(second.projects, []);
});

test('CSV preserves escaped quotes, embedded newlines, BOM, CRLF and trailing empty cells', () => {
  const rows = model.parseCSV('\uFEFF Title ,Notes,Client\r\n"Shoot, one","Said ""yes""\r\nNext line",\r\n\r\nTwo,Plain,Client');
  assert.deepEqual(rows, [
    { title: 'Shoot, one', notes: 'Said "yes"\r\nNext line', client: '' },
    { title: 'Two', notes: 'Plain', client: 'Client' }
  ]);
  assert.deepEqual(model.parseCSV(''), []);
  for (const csv of ['a,a\n1,2', 'a,b\n1', 'a\n"unfinished', 'a\n"closed"junk', 'a\nun"quoted']) {
    assert.throws(() => model.parseCSV(csv));
  }
  assert.equal(model.importBookings('a\n"unfinished').errors.length, 1);
});

test('imports valid dated and zoned bookings, resolves categories and deduplicates normalized content', () => {
  const existing = [{ title: ' SHOOT   ONE ', start: '2026-11-10T09:00:00+13:00', end: '2026-11-10T10:00:00+13:00', client: ' ACME ' }];
  const csv = header + [
    'shoot one,2026-11-09T20:00:00Z,2026-11-09T21:00:00Z,Production,acme,,',
    'Edit,2026-11-11,2026-11-12,POST-PRODUCTION,Client,Studio,"First\nSecond"',
    ' EDIT ,2026-11-11,2026-11-12,post-production,client,,',
    'Brief,2026-11-13T09:00+13:00,2026-11-13T10:00+13:00,pre-production,,,'
  ].join('\n');
  const result = model.importBookings(csv, model.defaults().categories, existing);
  assert.equal(result.duplicates, 2);
  assert.deepEqual(result.errors, []);
  assert.equal(result.bookings.length, 2);
  assert.equal(result.bookings[0].allDay, true);
  assert.equal(result.bookings[0].categoryId, 'post-production');
  assert.equal(result.bookings[0].notes, 'First\nSecond');
  assert.equal(result.bookings[1].start, '2026-11-12T20:00:00.000Z');
  assert.equal(model.importBookings(csv, model.defaults().categories, [...existing, ...result.bookings]).bookings.length, 0);
  assert.equal(result.bookings[0].id, model.importBookings(csv, model.defaults().categories, existing).bookings[0].id);
  assert.equal(existing.length, 1);
});

test('import rejects local datetimes, impossible dates, mixed types and nonpositive durations per row', () => {
  const intervals = [
    ['2026-11-10T09:00', '2026-11-10T10:00'],
    ['2026-02-29', '2026-03-02'], ['2026-04-31', '2026-05-02'],
    ['2026-11-10T24:00Z', '2026-11-12T01:00Z'],
    ['2026-11-10T09:00+24:00', '2026-11-12T10:00Z'],
    ['2026-11-10', '2026-11-11T10:00Z'],
    ['2026-11-10', '2026-11-10'], ['2026-11-12', '2026-11-11']
  ];
  const csv = header + intervals.map(([start, end]) => `Invalid,${start},${end},Production,,,`).join('\n') +
    '\nUnknown,2026-11-11,2026-11-12,Typo,,,' +
    '\n,2026-11-11,2026-11-12,Production,,,' +
    '\nLeap,2028-02-29,2028-03-01,Production,,,';
  const result = model.importBookings(csv);
  assert.equal(result.errors.length, 10);
  assert.equal(result.errors[0].row, 2);
  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0].title, 'Leap');
});

// Short representative excerpt of the supplied MPI calendar; not the full file.
const weeklyGrid = [
  ',,,,,,', ',AGENCY: VML,,,,,', ',CLIENT: MPI,,,,,', ',TITLES: PROTECT OUR PARADISE,,,,,',
  ',DELIVERABLES:,KEY:,PROD CO,,,', ',"1x 15""",,AGENCY,,,', ',RATIOS: 16:9 9:16,,CLIENT,,,',
  '2026,,,,,,', 'MON,TUES,WED,THURS,FRI,SAT,SUN',
  '15 June,16-Jun,17-Jun,18-Jun,19-Jun,20-Jun,21-Jun', ',,JOB SCOPING,,,,',
  '2 - November,3-Nov,4-Nov,5-Nov,6-Nov,7-Nov,8-Nov', 'JOB SCOPING,,,,,,',
  '23-Nov,24-Nov,25-Nov,26-Nov,27-Nov,28-Nov,29-Nov',
  'PRE - PRODUCTION,SHOOT WINDOW,,POST PRODUCTION,,,',
  'PPM,Camera test,,OFFLINE begins,AM PRESENT OFFLINE TO CLIENT,,',
  ',,,"PM - OFFLINE SESSION @ TPO\nClient review",EOD OFFLINE APPROVED,,',
  '30-Nov,1-Dec,2-Dec,3-Dec,4-Dec,5-Dec,6-Dec', ',POST PRODUCTION,,,,,',
  'AM - ONLINE GRADE @ TPO,SOUND MIX,,,,,', ',DISPATCH,,,,,', 'STEVE NA,,,,,,'
].join('\r\n');

test('schedule grid extracts metadata, dates, explicit phase carry and availability provenance', () => {
  const categories = model.defaults().categories.reverse(); // default phase must not depend on category order
  const result = model.importSchedule('\uFEFF' + weeklyGrid, categories, [], { projectId: 'mpi' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.metadata, { title: 'PROTECT OUR PARADISE', client: 'MPI', agency: 'VML', deliverables: '1x 15"\nRATIOS: 16:9 9:16' });
  assert.equal(result.bookings.length, 16);
  const find = title => result.bookings.find(booking => booking.title === title);
  assert.equal(result.bookings[0].start, '2026-06-17');
  assert.equal(result.bookings[1].start, '2026-11-02');
  assert.equal(find('PPM').categoryId, 'pre-production');
  assert.equal(find('Camera test').categoryId, 'production');
  const markers = result.bookings.filter(booking => booking.source.kind === 'phase-marker');
  assert.deepEqual(markers.map(({ title, start, end, categoryId, allDay }) => ({ title, start, end, categoryId, allDay })), [
    { title: 'PRE - PRODUCTION', start: '2026-11-23', end: '2026-11-24', categoryId: 'pre-production', allDay: true },
    { title: 'SHOOT WINDOW', start: '2026-11-24', end: '2026-11-25', categoryId: 'production', allDay: true },
    { title: 'POST PRODUCTION', start: '2026-11-26', end: '2026-11-27', categoryId: 'post-production', allDay: true },
    { title: 'POST PRODUCTION', start: '2026-12-01', end: '2026-12-02', categoryId: 'post-production', allDay: true }
  ]);
  assert.equal(find('SHOOT WINDOW').source.column, 2);
  assert.equal(find('SHOOT WINDOW').source.phase, 'production');
  assert.equal(find('OFFLINE begins').categoryId, 'post-production');
  assert.equal(find('AM - ONLINE GRADE @ TPO').categoryId, 'post-production');
  assert.equal(find('AM - ONLINE GRADE @ TPO').end, '2026-12-01');
  assert.equal(find('DISPATCH').start, '2026-12-01');
  assert.equal(find('DISPATCH').end, '2026-12-02');
  assert.ok(find('PM - OFFLINE SESSION @ TPO\nClient review'));
  const note = find('STEVE NA');
  assert.equal(note.start, '2026-11-30');
  assert.equal(note.notes, 'Availability note: STEVE NA');
  assert.deepEqual(note.source, { format: 'weekly-grid', row: 22, column: 1, dateRow: 18, dateCell: '30-Nov',
    phase: 'post-production', kind: 'availability-note', metadata: result.metadata });
  assert.equal('crew' in note, false);
  assert.ok(result.bookings.every(booking => booking.allDay && booking.projectId === 'mpi' && booking.client === 'MPI'));
});

test('schedule previews deduplicate within projects while keeping other projects and inputs intact', () => {
  const first = model.importSchedule(weeklyGrid, undefined, [], { projectId: 'one' });
  const snapshot = JSON.stringify(first.bookings);
  const again = model.importSchedule(weeklyGrid, undefined, first.bookings, { projectId: 'one' });
  assert.equal(again.bookings.length, 0);
  assert.equal(again.duplicates, 16);
  const other = model.importSchedule(weeklyGrid, undefined, first.bookings, { projectId: 'two' });
  assert.equal(other.bookings.length, 16);
  assert.equal(other.duplicates, 0);
  assert.notEqual(other.bookings[0].id, first.bookings[0].id);
  assert.equal(JSON.stringify(first.bookings), snapshot);
  const standardText = header + 'Edit,2026-11-11,2026-11-12,post-production,MPI,,\nEDIT,2026-11-11,2026-11-12,post-production,mpi,,';
  const legacy = model.importBookings(standardText);
  assert.deepEqual(Object.keys(legacy), ['bookings', 'errors', 'duplicates']);
  const standard = model.importSchedule(standardText, undefined, legacy.bookings, { projectId: 'one' });
  assert.equal(standard.bookings.length, 1);
  assert.equal(standard.duplicates, 1);
  assert.equal(standard.bookings[0].source.format, 'standard');
  assert.equal(standard.bookings[0].source.row, 2);
  assert.equal(model.importSchedule(standardText, undefined, standard.bookings, { projectId: 'one' }).duplicates, 2);
  assert.equal(model.importSchedule(standardText, undefined, legacy.bookings).bookings.length, 0);
  assert.equal(model.importBookings(standardText, undefined, standard.bookings).bookings.length, 1);
});

test('schedule year must be explicit, can be overridden, and rolls forward from December to January', () => {
  const noYear = weeklyGrid.replace('2026,,,,,,\r\n', '');
  assert.match(model.importSchedule(noYear).errors[0].message, /year/);
  assert.equal(model.importSchedule(noYear, undefined, [], { year: 2026 }).bookings.length, 16);
  const overridden = model.importSchedule(weeklyGrid, undefined, [], { year: 2027 });
  assert.equal(overridden.bookings[0].start, '2027-06-17');
  assert.equal(overridden.warnings.length, 1);
  const boundary = '2026,,,,,,\nMON,TUES,WED,THURS,FRI,SAT,SUN\n28-Dec,29-Dec,30-Dec,31-Dec,1-Jan,2-Jan,3-Jan\n,,,Final,First,,';
  const result = model.importSchedule(boundary);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.bookings.map(({ start, end }) => [start, end]), [
    ['2026-12-31', '2027-01-01'], ['2027-01-01', '2027-01-02']
  ]);
});

test('schedule reports malformed grids without inventing dates or phase categories', () => {
  const badDate = weeklyGrid.replace('17-Jun', '31-Jun');
  const invalid = model.importSchedule(badDate);
  assert.equal(invalid.bookings.some(booking => booking.start === '2026-07-01'), false);
  assert.equal(invalid.errors.length, 2); // invalid header and its undatable milestone
  assert.equal(invalid.errors[0].column, 3);
  const missingCategory = model.importSchedule(weeklyGrid, model.defaults().categories.filter(category => category.id !== 'production'));
  assert.match(missingCategory.errors[0].message, /Missing phase category: production/);
  assert.equal(missingCategory.bookings.some(booking => booking.title === 'Camera test'), false);
  assert.equal(model.importSchedule('a\n"unterminated').errors.length, 1);
});

test('totals round each ex-GST line and GST to cents and calculate known profitability', () => {
  assert.deepEqual(model.totals([{ qty: 1, rate: 1.005, cost: 0.335 }, { qty: '2.5', rate: '10.10', cost: '4' }]), {
    subtotal: 26.26, gst: 3.94, total: 30.2, cost: 10.34, profit: 15.92, margin: 1592 / 2626 * 100
  });
  assert.deepEqual(model.totals([{ qty: 2, rate: 100, cost: 30 }], 0), {
    subtotal: 200, gst: 0, total: 200, cost: 60, profit: 140, margin: 70
  });
  assert.equal(model.totals([{ qty: 1, rate: 10, cost: 20 }]).profit, -10);
  assert.equal(model.totals([]).margin, null);
  assert.equal(model.totals([{ qty: 1, rate: 0, cost: 0 }]).cost, 0);
});

test('unknown cost hides all profitability and invalid financial inputs fail closed', () => {
  for (const cost of [undefined, null, '']) {
    const result = model.totals([{ qty: 1, rate: 100, cost: 10 }, { qty: 1, rate: 50, cost }]);
    assert.equal(result.total, 172.5);
    for (const key of ['cost', 'profit', 'margin']) assert.equal(result[key], null);
  }
  for (const field of ['qty', 'rate', 'cost']) {
    for (const bad of [-1, NaN, Infinity, 'oops', true]) {
      assert.throws(() => model.totals([{ qty: 1, rate: 10, cost: 0, [field]: bad }]));
    }
  }
  assert.throws(() => model.totals([{ qty: '', rate: 1 }]));
  assert.throws(() => model.totals([], -15));
  assert.throws(() => model.totals([{ qty: 1e20, rate: 1 }]));
});

test('workspace migration enforces business/email/role isolation and optimistic revisions in local Postgres', async () => {
  const db = new PGlite();
  try {
    // Mirror the repo helpers and trusted users-table read scope, without live connections.
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
      grant usage on schema auth to authenticated;
      create table public.businesses(id text primary key);
      create table public.users(id uuid primary key, business_id text references businesses(id), email text, role text);
      create function public.current_business_id() returns text language sql stable security definer set search_path=public as
        $$ select business_id from public.users where id=auth.uid() $$;
      create function public.current_business_role() returns text language sql stable security definer set search_path=public as
        $$ select role from public.users where id=auth.uid() $$;
      alter table public.users enable row level security;
      grant select on public.users to authenticated;
      create policy teammate_read on public.users for select to authenticated using (business_id=public.current_business_id());
      insert into businesses values ('post'), ('other');
      insert into users values
        ('00000000-0000-4000-8000-000000000001','post','JACKIE@THEPOSTOFFICE.CO.NZ','owner'),
        ('00000000-0000-4000-8000-000000000002','post','manager@example.com','manager'),
        ('00000000-0000-4000-8000-000000000003','post','crew@example.com','technician'),
        ('00000000-0000-4000-8000-000000000004','other','other@example.com','owner');
    `);
    const migration = fs.readdirSync(path.join(__dirname, '../supabase/migrations')).filter(name => name.endsWith('_post_office_workspaces.sql'));
    assert.equal(migration.length, 1);
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations', migration[0]), 'utf8'));
    const login = async n => {
      await db.exec('reset role');
      await db.query("select set_config('test.uid', $1, false)", ['00000000-0000-4000-8000-' + String(n).padStart(12, '0')]);
      await db.exec('set role authenticated');
    };
    await login(1);
    await db.exec("insert into post_office_workspaces(business_id,state) values ('post','{}')");
    await assert.rejects(db.exec("insert into post_office_workspaces(business_id,state) values ('other','{}')"), /row-level security/);
    const original = (await db.query('select * from post_office_workspaces')).rows[0];
    assert.equal(original.revision, 0);
    await assert.rejects(db.exec("update post_office_workspaces set state='{}'"), /increment by one/);
    await login(2);
    const write = () => db.query("update post_office_workspaces set state='{\"projects\":[]}',revision=1 where revision=0 returning *");
    const updated = (await write()).rows[0];
    assert.equal(updated.revision, 1);
    assert.ok(updated.updated_at >= original.updated_at);
    assert.equal((await write()).rows.length, 0);
    await assert.rejects(db.exec('update post_office_workspaces set revision=3'), /increment by one/);
    await login(3);
    assert.equal((await db.query('select * from post_office_workspaces')).rows.length, 1);
    assert.equal((await db.query('update post_office_workspaces set revision=2 returning *')).rows.length, 0);
    assert.equal((await db.query('delete from post_office_workspaces returning *')).rows.length, 0);
    await assert.rejects(db.exec("insert into post_office_workspaces(business_id,state) values ('post','{}')"), /row-level security/);
    await login(4);
    // Spoofed metadata is ignored: the users table still says this is another business.
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ user_metadata: { email: 'jackie@thepostoffice.co.nz' } })]);
    assert.equal((await db.query('select * from post_office_workspaces')).rows.length, 0);
    await assert.rejects(db.exec("insert into post_office_workspaces(business_id,state) values ('other','{}')"), /row-level security/);
    await db.exec('reset role');
    await db.exec("update users set email='removed@example.com' where email='JACKIE@THEPOSTOFFICE.CO.NZ'");
    await login(1);
    assert.equal((await db.query('select * from post_office_workspaces')).rows.length, 0);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from post_office_workspaces'), /permission denied/);
  } finally { await db.close(); }
});
