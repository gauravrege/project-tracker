// Project Tracker server for Google Cloud Run.
// Serves Index.html plus a small JSON API that reads and writes the same Google
// Sheet the Apps Script version uses. No npm packages needed.
//
// Who is signed in: Identity-Aware Proxy (IAP) sits in front of Cloud Run, lets
// only riya.travel accounts through, and passes the email in a header. Only
// IAP is allowed to call this service, so the header cannot be faked from outside.
// Sheet access: the server uses its own Google account, which has edit access
// to the Sheet. Setup steps are in README.md.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const SHEET_ID = process.env.SHEET_ID;
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || 'riya.travel';
// Everyone let in can edit, so keep this to the people who run the tracker. Empty = whole domain.
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const SHEETS_API = process.env.SHEETS_API || 'https://sheets.googleapis.com/v4/spreadsheets';

// Keep these the same as Code.gs.
const OWNERS = ['Gaurav', 'Bhargavi', 'Both'];
const STATUSES = ['Upcoming', 'In progress', 'Testing', 'Delivered', 'On hold'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const PROJECTS_SHEET = 'Projects';
const HISTORY_SHEET = 'History';
const COLUMNS = [
  ['ID', 'id'], ['Project', 'name'], ['Owner', 'owner'], ['Asked by', 'askedBy'], ['Status', 'status'],
  ['Status since', 'statusSince'], ['Priority', 'priority'], ['Start date', 'startDate'],
  ['Target date', 'targetDate'], ['Delivered date', 'deliveredDate'], ['Tester', 'tester'],
  ['Feedback', 'feedback'], ['Blocker', 'blocker'], ['GitHub', 'github'], ['Runs on', 'runsOn'],
  ['Notes', 'notes'], ['Updated at', 'updatedAt'], ['Updated by', 'updatedBy'],
];
const DATE_FIELDS = ['statusSince', 'startDate', 'targetDate', 'deliveredDate'];
const EDITABLE = ['name', 'owner', 'askedBy', 'status', 'priority', 'startDate', 'targetDate',
  'deliveredDate', 'tester', 'feedback', 'blocker', 'github', 'runsOn', 'notes'];
const LABELS = Object.fromEntries(COLUMNS.map(([header, field]) => [field, header]));

// An error whose message is written for the person using the page.
class UserError extends Error {
  constructor(message, status) { super(message); this.status = status || 400; }
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------
let cachedToken = null;
async function accessToken() {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN; // tests on this PC
  if (cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.value;
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } });
  if (!r.ok) throw new Error('Could not get a Google token for the server (' + r.status + ')');
  const t = await r.json();
  cachedToken = { value: t.access_token, expires: Date.now() + t.expires_in * 1000 };
  return cachedToken.value;
}

async function sheetsApi(method, urlPath, body) {
  const r = await fetch(SHEETS_API + '/' + SHEET_ID + urlPath, {
    method: method,
    headers: Object.assign({ Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json' },
      process.env.QUOTA_PROJECT ? { 'x-goog-user-project': process.env.QUOTA_PROJECT } : {}), // tests with a personal login
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 403 || r.status === 404) {
    throw new UserError('The server cannot open the tracker\'s Google Sheet. ' +
      'Share the Sheet with the server\'s account as Editor (see README).', 502);
  }
  if (!r.ok) throw new Error('Google Sheets answered ' + r.status + ': ' + ((data.error && data.error.message) || ''));
  return data;
}

// Tab ids and time zone change rarely; keep them for 10 minutes.
let cachedMeta = null;
async function sheetMeta() {
  if (cachedMeta && cachedMeta.until > Date.now()) return cachedMeta;
  const m = await sheetsApi('GET', '?fields=properties.timeZone,sheets.properties(sheetId,title)');
  const tabs = {};
  m.sheets.forEach(s => { tabs[s.properties.title] = s.properties.sheetId; });
  if (!(PROJECTS_SHEET in tabs)) throw new UserError('The "' + PROJECTS_SHEET + '" tab is missing from the Google Sheet.', 502);
  cachedMeta = { tz: m.properties.timeZone, tabs: tabs, until: Date.now() + 600000 };
  return cachedMeta;
}

// Whole Projects tab. Dates come back as Sheets serial numbers.
async function readProjects() {
  const v = await sheetsApi('GET', '/values/' + encodeURIComponent(PROJECTS_SHEET) +
    '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER');
  const rows = v.values || [];
  const cols = headerIndex(rows[0] || []);
  return { cols: cols, rows: rows.slice(1) }; // rows[i] is Sheet row i + 2
}

function columnLetter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}
function cellRange(tab, colIndex, rowNumber) { return "'" + tab + "'!" + columnLetter(colIndex) + rowNumber; }

// Write single cells only, so formulas in extra columns are never touched.
// RAW: text is stored as typed, so "=..." can never become a formula.
async function writeCells(cells) {
  if (!cells.length) return;
  await sheetsApi('POST', '/values:batchUpdate', {
    valueInputOption: 'RAW',
    data: cells.map(c => ({ range: c.range, values: [[c.value]] })),
  });
}

async function appendRow(tab, row) {
  await sheetsApi('POST', '/values/' + encodeURIComponent("'" + tab + "'!A1") +
    ':append?valueInputOption=RAW&insertDataOption=OVERWRITE', { values: [row] }); // reuse empty rows, keeping their dropdowns
}

async function deleteRow(rowNumber) {
  const meta = await sheetMeta();
  await sheetsApi('POST', ':batchUpdate', { requests: [{ deleteDimension: {
    range: { sheetId: meta.tabs[PROJECTS_SHEET], dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber },
  } }] });
}

async function logHistory(tz, id, name, change, by) {
  try {
    await appendRow(HISTORY_SHEET, [nowSerial(tz), id, name, change, by]);
  } catch (err) {
    console.error('History not written:', err.message); // the save itself already worked
  }
}

// ---------------------------------------------------------------------------
// Dates. Sheets stores a date as days since 30 Dec 1899, in the Sheet's time zone.
// ---------------------------------------------------------------------------
const DAY_MS = 86400000;
const SERIAL_EPOCH = Date.UTC(1899, 11, 30);

function tzOffsetMs(tz, at) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).forEach(x => { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - (at - at % 1000);
}
function nowSerial(tz) { const now = Date.now(); return (now + tzOffsetMs(tz, now) - SERIAL_EPOCH) / DAY_MS; }
function serialToDay(serial) { return new Date(SERIAL_EPOCH + Math.floor(serial) * DAY_MS).toISOString().slice(0, 10); }
function serialToStamp(serial) { return new Date(SERIAL_EPOCH + Math.round(serial * DAY_MS)).toISOString().slice(0, 23).replace('T', ' '); }
function dayToSerial(day) {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - SERIAL_EPOCH) / DAY_MS);
}
function today(tz) { return serialToDay(nowSerial(tz)); }

// ---------------------------------------------------------------------------
// Rows <-> projects (same rules as Code.gs)
// ---------------------------------------------------------------------------
function headerIndex(headers) {
  const names = headers.map(h => String(h).trim());
  const idx = { width: names.length };
  const missing = [];
  COLUMNS.forEach(([header, field]) => {
    const i = names.indexOf(header);
    if (i === -1) missing.push(header); else idx[field] = i;
  });
  if (missing.length) throw new UserError('These columns are missing from the Projects tab: ' + missing.join(', ') + '.', 502);
  return idx;
}

// A date cell holding something that is not a date is reported in `bad`, never dropped.
function toProject(row, cols) {
  const p = { bad: {} };
  COLUMNS.forEach(([header, field]) => {
    const v = row[cols[field]];
    if (DATE_FIELDS.includes(field) || field === 'updatedAt') {
      if (typeof v === 'number') p[field] = field === 'updatedAt' ? serialToStamp(v) : serialToDay(v);
      else {
        p[field] = '';
        if (v !== undefined && v !== null && v !== '') p.bad[field] = String(v);
      }
    } else {
      p[field] = v === undefined || v === null ? '' : String(v).trim();
    }
  });
  return p;
}

function validate(input) {
  const p = {};
  EDITABLE.forEach(f => { p[f] = input[f] == null ? '' : String(input[f]).trim(); });
  if (!p.name) throw new UserError('Give the project a name.');
  if (!STATUSES.includes(p.status)) throw new UserError('Pick a status for the project.');
  if (p.owner && !OWNERS.includes(p.owner)) throw new UserError('Owner must be one of: ' + OWNERS.join(', ') + '.');
  if (p.priority && !PRIORITIES.includes(p.priority)) throw new UserError('Priority must be one of: ' + PRIORITIES.join(', ') + '.');
  EDITABLE.filter(f => DATE_FIELDS.includes(f)).forEach(f => {
    if (p[f] && !/^\d{4}-\d{2}-\d{2}$/.test(p[f])) throw new UserError(LABELS[f] + ' is not a valid date.');
  });
  if (p.github && !/^https?:\/\//i.test(p.github)) throw new UserError('The GitHub link should start with https://');
  return p;
}

function conflict(before) {
  const who = before.updatedBy || 'Someone';
  const when = before.updatedAt ? ' at ' + before.updatedAt.slice(11, 16) + ' on ' + before.updatedAt.slice(0, 10) : '';
  return new UserError(who + ' changed this project' + when + ' after you opened it. Your changes were NOT saved. ' +
    'Copy anything you typed, click Refresh, then make your change again.', 409);
}

function newId() { return crypto.randomUUID().replace(/-/g, '').slice(0, 8); }

// One write at a time. Cloud Run is limited to one copy of this server, so this is enough.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// API (same shapes as the Apps Script functions)
// ---------------------------------------------------------------------------
async function getData(user) {
  const meta = await sheetMeta();
  let { cols, rows } = await readProjects();

  // Rows typed straight into the Sheet have no ID yet. Give them one.
  const missing = rows.map((row, i) => (!row[cols.id] && row[cols.name] ? i : -1)).filter(i => i !== -1);
  if (missing.length) {
    await exclusive(async () => {
      const fresh = await readProjects();
      const cells = [];
      fresh.rows.forEach((row, i) => {
        if (!row[fresh.cols.id] && row[fresh.cols.name]) cells.push({ range: cellRange(PROJECTS_SHEET, fresh.cols.id, i + 2), value: newId() });
      });
      await writeCells(cells);
    });
    ({ cols, rows } = await readProjects());
  }

  return {
    projects: rows.map(row => toProject(row, cols)).filter(p => p.id || p.name),
    user: user,
    today: today(meta.tz),
    owners: OWNERS,
    statuses: STATUSES,
    priorities: PRIORITIES,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit',
  };
}

// Add a project (no id) or save changes to one (with id). input.updatedAt is
// what the page last saw; if the Sheet has changed since, refuse rather than overwrite.
async function saveProject(user, input) {
  const clean = validate(input || {});
  await exclusive(async () => {
    const meta = await sheetMeta();
    const { cols, rows } = await readProjects();
    const now = nowSerial(meta.tz);
    const todaySerial = Math.floor(now);

    if (!input.id) {
      const row = new Array(cols.width).fill('');
      row[cols.id] = newId();
      EDITABLE.forEach(f => { row[cols[f]] = DATE_FIELDS.includes(f) ? dayToSerial(clean[f]) : clean[f]; });
      row[cols.statusSince] = todaySerial;
      row[cols.updatedAt] = now;
      row[cols.updatedBy] = user;
      await appendRow(PROJECTS_SHEET, row);
      await logHistory(meta.tz, row[cols.id], clean.name, 'Added as ' + clean.status, user);
      return;
    }

    const i = rows.findIndex(r => String(r[cols.id] || '') === String(input.id));
    if (i === -1) throw new UserError('This project is no longer in the Sheet. Someone may have deleted it. Click Refresh.', 404);
    const before = toProject(rows[i], cols);
    if (before.updatedAt !== String(input.updatedAt || '')) throw conflict(before);

    const rowNumber = i + 2;
    const cells = EDITABLE.map(f => ({
      range: cellRange(PROJECTS_SHEET, cols[f], rowNumber),
      value: DATE_FIELDS.includes(f) ? dayToSerial(clean[f]) : clean[f],
    }));
    const statusChanged = before.status !== clean.status;
    if (statusChanged) cells.push({ range: cellRange(PROJECTS_SHEET, cols.statusSince, rowNumber), value: todaySerial });
    cells.push({ range: cellRange(PROJECTS_SHEET, cols.updatedAt, rowNumber), value: now });
    cells.push({ range: cellRange(PROJECTS_SHEET, cols.updatedBy, rowNumber), value: user });
    await writeCells(cells);
    if (statusChanged) await logHistory(meta.tz, input.id, clean.name, (before.status || 'No status') + ' → ' + clean.status, user);
  });
  return getData(user);
}

async function deleteProject(user, id, seenUpdatedAt) {
  await exclusive(async () => {
    const meta = await sheetMeta();
    const { cols, rows } = await readProjects();
    const i = rows.findIndex(r => String(r[cols.id] || '') === String(id));
    if (i === -1) return; // already gone
    const before = toProject(rows[i], cols);
    if (before.updatedAt !== String(seenUpdatedAt || '')) throw conflict(before);
    await deleteRow(i + 2);
    await logHistory(meta.tz, id, before.name, 'Deleted (was ' + (before.status || 'No status') + ')', user);
  });
  return getData(user);
}

const API = { getData, saveProject, deleteProject };

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const FAVICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#4f46e5"/>' +
  '<rect x="5" y="6" width="3.5" height="12" rx="1" fill="#fff"/><rect x="10.25" y="6" width="3.5" height="8" rx="1" fill="#fff"/>' +
  '<rect x="15.5" y="6" width="3.5" height="10" rx="1" fill="#fff"/></svg>');
const INDEX = fs.readFileSync(path.join(__dirname, 'Index.html'), 'utf8').replace('<head>',
  '<head>\n<title>Project Tracker</title>\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<link rel="icon" href="' + FAVICON + '">');

// IAP puts "accounts.google.com:name@riya.travel" in this header.
function signedInEmail(req) {
  const raw = req.headers['x-goog-authenticated-user-email'];
  if (!raw) throw new UserError('Sign-in is missing. Open the tracker from its normal link.', 401);
  const email = String(raw).replace(/^accounts\.google\.com:/, '').toLowerCase();
  if (!email.endsWith('@' + ALLOWED_DOMAIN)) throw new UserError('This tracker is only for ' + ALLOWED_DOMAIN + ' accounts.', 403);
  if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) {
    throw new UserError(email + ' does not have access to this tracker. Ask Gaurav or Bhargavi to add you.', 403);
  }
  return email;
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 1e6) { reject(new UserError('Request too large.', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const user = signedInEmail(req);
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, INDEX, 'text/html; charset=utf-8');

    const m = url.pathname.match(/^\/api\/(getData|saveProject|deleteProject)$/);
    if (req.method === 'POST' && m) {
      let args;
      try { args = JSON.parse(await readBody(req) || '[]'); } catch (e) { throw new UserError('The request was not valid.'); }
      if (!Array.isArray(args)) throw new UserError('The request was not valid.');
      return sendJson(res, 200, await API[m[1]](user, ...args));
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const forPerson = err instanceof UserError;
    if (!forPerson) console.error(err);
    sendJson(res, err.status || 500, {
      error: forPerson ? err.message
        : 'Something went wrong on the server. Try again in a minute. If it keeps happening, tell Gaurav: ' + err.message,
    });
  }
});

if (require.main === module) {
  if (!SHEET_ID) { console.error('SHEET_ID is not set.'); process.exit(1); }
  server.listen(PORT, () => console.log('Project Tracker listening on ' + PORT));
}
module.exports = { server, columnLetter, serialToDay, dayToSerial, serialToStamp, tzOffsetMs };
