// Runs the real server.js over HTTP and checks its behaviour.
//   node tests/cloud-test.js                     against a stand-in for the Sheets API
//   REAL_SHEET_ID=<id> GOOGLE_ACCESS_TOKEN=<t> node tests/cloud-test.js
//                                                against a real (throwaway!) Google Sheet
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const REAL = process.env.REAL_SHEET_ID;
const SHEET_ID = REAL || 'TEST';
const TOKEN = process.env.GOOGLE_ACCESS_TOKEN || 'test-token';
const HEADERS = ['ID', 'Project', 'Owner', 'Asked by', 'Status', 'Status since', 'Priority', 'Start date', 'Target date',
  'Delivered date', 'Tester', 'Feedback', 'Blocker', 'GitHub', 'Runs on', 'Notes', 'Updated at', 'Updated by', 'Comments'];
const col = h => HEADERS.indexOf(h);

// ---------- stand-in for the Sheets API ----------
function fakeSheets() {
  const tabs = { Projects: { id: 0, grid: [] }, History: { id: 7, grid: [] } };
  const letterToIndex = s => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const parse = r => {
    const m = r.match(/^'?([^'!]+)'?(?:!([A-Z]+)(\d+))?/);
    return { tab: tabs[m[1]], col: m[2] ? letterToIndex(m[2]) : 0, row: m[3] ? Number(m[3]) : 1 };
  };
  const set = (tab, row, c, v) => {
    while (tab.grid.length < row) tab.grid.push([]);
    const r = tab.grid[row - 1];
    while (r.length <= c) r.push('');
    r[c] = v;
  };
  const filled = r => r.some(v => v !== '' && v !== undefined);
  const trimmed = grid => {
    const rows = grid.map(r => { const c = r.slice(); while (c.length && (c[c.length - 1] === '' || c[c.length - 1] === undefined)) c.pop(); return c.map(v => (v === undefined ? '' : v)); });
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    return rows;
  };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      const url = new URL(req.url, 'http://x');
      const rest = decodeURIComponent(url.pathname.replace('/v4/spreadsheets/' + SHEET_ID, ''));
      let out = {};
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('{}'); }
      if (rest === '' && req.method === 'GET') {
        out = { properties: { timeZone: 'Asia/Kolkata' }, sheets: Object.keys(tabs).map(t => ({ properties: { sheetId: tabs[t].id, title: t } })) };
      } else if (rest === '/values:batchUpdate') {
        json.data.forEach(d => {
          const p = parse(d.range);
          d.values.forEach((r, i) => r.forEach((v, c) => set(p.tab, p.row + i, p.col + c, v)));
        });
      } else if (rest.endsWith(':append')) {
        const p = parse(rest.slice('/values/'.length, -':append'.length));
        let last = 0;
        p.tab.grid.forEach((r, i) => { if (filled(r)) last = i + 1; });
        json.values[0].forEach((v, c) => set(p.tab, last + 1, c, v));
      } else if (rest === ':batchUpdate') {
        const d = json.requests[0].deleteDimension.range;
        const tab = Object.values(tabs).find(t => t.id === d.sheetId);
        tab.grid.splice(d.startIndex, d.endIndex - d.startIndex);
      } else if (rest.startsWith('/values/')) {
        out = { values: trimmed(parse(rest.slice('/values/'.length)).tab.grid) };
      } else { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return srv;
}

// ---------- helpers ----------
let SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
async function sheets(method, urlPath, body) {
  const r = await fetch(SHEETS_API + '/' + SHEET_ID + urlPath, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: Object.assign({ Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      process.env.QUOTA_PROJECT ? { 'x-goog-user-project': process.env.QUOTA_PROJECT } : {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Sheets ' + r.status + ' ' + JSON.stringify(data));
  return data;
}
const read = async tab => (await sheets('GET', '/values/' + tab + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER')).values || [];
const write = (range, rows, mode) => sheets('POST', '/values:batchUpdate', { valueInputOption: mode || 'RAW', data: [{ range, values: rows }] });

let BASE;
async function api(fn, args, email) {
  const headers = { 'Content-Type': 'application/json' };
  if (email !== null) headers['x-goog-authenticated-user-email'] = 'accounts.google.com:' + (email || 'person.one@riya.travel');
  const r = await fetch(BASE + '/api/' + fn, { method: 'POST', headers, body: JSON.stringify(args) });
  return { status: r.status, body: await r.json() };
}

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
  if (!cond) failed++;
}
const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fake;
  if (!REAL) {
    fake = fakeSheets();
    await new Promise(r => fake.listen(0, r));
    SHEETS_API = 'http://127.0.0.1:' + fake.address().port + '/v4/spreadsheets';
  }

  // Seed: header row, three projects, an extra column the server must not touch.
  const serial = day => Math.round((Date.parse(day) - Date.UTC(1899, 11, 30)) / 86400000);
  const row = vals => HEADERS.map(h => (h in vals ? vals[h] : ''));
  await write("'Projects'!A1", [HEADERS,
    row({ ID: 'aaaa1111', Project: 'ERP retail', Status: 'In progress', 'Target date': serial('2026-11-15'), Comments: 'keep me' }),
    row({ Project: 'Typed in Sheet' }),
    row({ ID: 'bbbb2222', Project: 'Bad date', Status: 'Upcoming', 'Target date': 'next week' }),
  ]);
  await write("'History'!A1", [['When', 'Project ID', 'Project', 'Change', 'By']]);

  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), SHEET_ID, SHEETS_API, GOOGLE_ACCESS_TOKEN: TOKEN,
      ALLOWED_EMAILS: 'person.one@riya.travel, person.two@riya.travel' }),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise(r => child.stdout.on('data', d => { if (/listening/.test(d)) r(); }));
  BASE = 'http://127.0.0.1:' + port;

  try {
    // Sign-in
    check('no sign-in header is refused', (await api('getData', [], null)).status === 401);
    const outsider = await api('getData', [], 'someone@gmail.com');
    check('non-riya.travel account is refused', outsider.status === 403 && /only for riya.travel/.test(outsider.body.error), outsider);
    const colleague = await api('getData', [], 'someone.else@riya.travel');
    check('riya.travel account not on the list is refused', colleague.status === 403 && /does not have access/.test(colleague.body.error), colleague);
    const page = await fetch(BASE + '/', { headers: { 'x-goog-authenticated-user-email': 'accounts.google.com:person.one@riya.travel' } });
    check('page is served with a title', page.status === 200 && /<title>Project Tracker<\/title>/.test(await page.text()));

    // Read
    let d = (await api('getData', [])).body;
    check('getData returns 3 projects', d.projects && d.projects.length === 3, d);
    check('today is yyyy-MM-dd', /^\d{4}-\d{2}-\d{2}$/.test(d.today), d.today);
    check('signed-in email passed to the page', d.user === 'person.one@riya.travel', d.user);
    check('target date read back', d.projects[0].targetDate === '2026-11-15', d.projects[0]);
    check('row typed in Sheet gets an ID', /^[0-9a-f]{8}$/.test(d.projects[1].id), d.projects[1]);
    check('non-date in a date cell is flagged', d.projects[2].bad.targetDate === 'next week', d.projects[2]);

    // Add
    const added = await api('saveProject', [{ id: '', updatedAt: '', name: 'Invoice matcher', status: 'Upcoming', owner: 'Bhargavi',
      priority: 'High', targetDate: '2026-12-01', notes: '=SUM(1,2)' }], 'person.two@riya.travel');
    let p = added.body.projects && added.body.projects.find(x => x.name === 'Invoice matcher');
    check('new project saved', added.status === 200 && !!p, added);
    check('new project fields', p && p.owner === 'Bhargavi' && p.targetDate === '2026-12-01' && p.statusSince === added.body.today, p);
    check('updated by is the signed-in person', p && p.updatedBy === 'person.two@riya.travel', p && p.updatedBy);
    check('text starting with = stays text', p && p.notes === '=SUM(1,2)', p && p.notes);
    let hist = await read('History');
    check('history logs the new project', hist.some(r => r[2] === 'Invoice matcher' && r[3] === 'Added as Upcoming'), hist);

    // Edit, then a stale copy
    await pause(5);
    const edited = await api('saveProject', [Object.assign({}, p, { status: 'Testing', startDate: '2026-10-20' })]);
    const p2 = edited.body.projects.find(x => x.id === p.id);
    check('edit saved', p2.status === 'Testing' && p2.startDate === '2026-10-20', p2);
    hist = await read('History');
    check('history logs the status change', hist.some(r => r[1] === p.id && r[3] === 'Upcoming → Testing'), hist);
    const stale = await api('saveProject', [Object.assign({}, p, { notes: 'old copy' })]);
    check('out-of-date copy is refused', stale.status === 409 && /NOT saved/.test(stale.body.error), stale);
    d = (await api('getData', [])).body;
    check('refused save changed nothing', d.projects.find(x => x.id === p.id).notes === '=SUM(1,2)');

    // The extra column and the row order are untouched
    const erp = d.projects.find(x => x.id === 'aaaa1111');
    await api('saveProject', [Object.assign({}, erp, { owner: 'Both' })]);
    const grid = await read('Projects');
    const erpRow = grid.find(r => r[0] === 'aaaa1111');
    check('extra column kept', erpRow[col('Comments')] === 'keep me', erpRow);
    check('owner saved to the right column', erpRow[col('Owner')] === 'Both', erpRow);

    // Validation
    const bad = await api('saveProject', [{ name: 'x', status: 'Done' }]);
    check('bad status refused with a plain message', bad.status === 400 && /status/.test(bad.body.error), bad);
    const badDate = await api('saveProject', [{ name: 'x', status: 'Upcoming', targetDate: '15/11/2026' }]);
    check('bad date refused', badDate.status === 400 && /not a valid date/.test(badDate.body.error), badDate);

    // Delete
    const p3 = (await api('getData', [])).body.projects.find(x => x.id === p.id);
    const staleDel = await api('deleteProject', [p3.id, '2000-01-01 00:00:00.000']);
    check('delete with out-of-date copy refused', staleDel.status === 409, staleDel);
    const del = await api('deleteProject', [p3.id, p3.updatedAt]);
    check('delete removes the project', del.status === 200 && !del.body.projects.some(x => x.id === p3.id), del.status);
    hist = await read('History');
    check('history logs the delete', hist.some(r => r[1] === p3.id && /^Deleted/.test(r[3])), hist);
    check('other projects still there', del.body.projects.length === 3, del.body.projects.map(x => x.name));
  } finally {
    child.kill();
    if (fake) fake.close();
  }
  console.log(failed ? '\n' + failed + ' FAILED' : '\nAll passed');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
