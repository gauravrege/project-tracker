// Runs the real Code.gs against the mock Sheet and checks the behaviour.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const codePath = process.argv[2];
const ctx = vm.createContext({ console, Intl, Date, Math, JSON, Object, Array, String, Error });
vm.runInContext(fs.readFileSync(path.join(__dirname, 'mock.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx, { filename: 'Code.gs' });
const run = src => vm.runInContext(src, ctx);
const m = ctx.__mock;

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
  if (!cond) failed++;
}
function throws(fn) { try { fn(); return null; } catch (e) { return e.message; } }
const noDates = obj => JSON.stringify(obj, (k, v) => v) && !JSON.stringify(obj).includes('"__date"') &&
  !(function walk(o) { return o instanceof Date || (o && typeof o === 'object' && Object.values(o).some(walk)); })(obj);

// --- 1. Setup on an imported CSV (headers in CSV order, blank rows) --------
const headers = run('COLUMNS.map(c => c[0])');
const blank = () => headers.map(() => '');
const row = (vals) => { const r = blank(); Object.keys(vals).forEach(h => { r[headers.indexOf(h)] = vals[h]; }); return r; };
m.newSpreadsheet([
  headers,
  row({ Project: 'ERP retail', GitHub: 'https://github.com/x/erp-retail' }),
  row({ Project: 'Greeting cards' }),
  row({ Project: 'Project tracker', Status: 'In progress' }),
]);
m.ss.sheets[0].maxRows = 4; // CSV import shrinks the tab
run('setup()');
const sheet = m.ss.getSheetByName('Projects');
check('setup renames the imported tab to Projects', !!sheet && m.ss.sheets[0] === sheet);
check('setup creates History tab', !!m.ss.getSheetByName('History'));
check('setup grows the tab to 1000 rows', sheet.maxRows === 1000, sheet.maxRows);
check('setup stores the Sheet ID', m.props.SHEET_ID === 'SHEET123');
check('setup fills in IDs', sheet.data.slice(1).every(r => r[0] && String(r[0]).length === 8));
run('setup()');
check('setup run twice does not add duplicate headers', sheet.data[0].filter(Boolean).length === headers.length, sheet.data[0]);

// --- 2. getData --------------------------------------------------------------
let d = run('getData()');
check('getData returns 3 projects', d.projects.length === 3, d.projects.length);
check('getData result has no Date objects (Apps Script cannot send them)', noDates(d));
check('today is yyyy-MM-dd', /^\d{4}-\d{2}-\d{2}$/.test(d.today), d.today);
check('blank status comes back blank (shown as Not set)', d.projects[0].status === '');

// --- 3. Add a project --------------------------------------------------------
d = run(`saveProject({ id: '', updatedAt: '', name: 'Invoice matcher', owner: 'Bhargavi', status: 'Upcoming',
  priority: 'High', targetDate: '2026-11-15', notes: '=SUM(1,2)' })`);
let p = d.projects.find(x => x.name === 'Invoice matcher');
check('new project saved', !!p);
check('new project has an ID', p && p.id.length === 8);
check('target date round-trips', p && p.targetDate === '2026-11-15', p && p.targetDate);
check('status since set to today', p && p.statusSince === d.today, p && p.statusSince);
check('updated by is the user', p && p.updatedBy === 'gaurav@example.com');
check('text starting with = is stored as text, not a formula', p && p.notes === '=SUM(1,2)' && Object.keys(sheet.formulas).length === 0, p && p.notes);
const hist = m.ss.getSheetByName('History').data;
check('history logs the new project', hist.some(r => r[2] === 'Invoice matcher' && /Added as Upcoming/.test(r[3])));

// --- 4. Edit with the right updatedAt, then a stale one ---------------------
const id = p.id;
const pause = () => { const t = Date.now(); while (Date.now() - t < 3); }; // two saves in the same millisecond look identical
pause();
d = run(`saveProject(${JSON.stringify(Object.assign({}, p, { status: 'Testing', startDate: '2026-10-20' }))})`);
const p2 = d.projects.find(x => x.id === id);
check('edit saved', p2.status === 'Testing' && p2.startDate === '2026-10-20');
check('history logs status change', hist.some(r => r[1] === id && r[3] === 'Upcoming → Testing'));
const stale = throws(() => run(`saveProject(${JSON.stringify(Object.assign({}, p, { notes: 'old copy' }))})`));
check('saving an out-of-date copy is refused', /NOT saved/.test(stale || ''), stale);
check('refused save did not change the row', run('getData()').projects.find(x => x.id === id).notes === '=SUM(1,2)');

// --- 5. Validation -----------------------------------------------------------
check('missing name refused', /name/.test(throws(() => run(`saveProject({ name: '', status: 'Upcoming' })`)) || ''));
check('bad status refused', /status/.test(throws(() => run(`saveProject({ name: 'x', status: 'Done' })`)) || ''));
check('bad date refused', /not a valid date/.test(throws(() => run(`saveProject({ name: 'x', status: 'Upcoming', targetDate: '15/11/2026' })`)) || ''));
check('bad github link refused', /https/.test(throws(() => run(`saveProject({ name: 'x', status: 'Upcoming', github: 'javascript:alert(1)' })`)) || ''));

// --- 6. Rubbish typed into a date cell is reported, not dropped --------------
const rowIdx = sheet.data.findIndex(r => r[1] === 'Greeting cards');
sheet.data[rowIdx][headers.indexOf('Target date')] = 'next week';
p = run('getData()').projects.find(x => x.name === 'Greeting cards');
check('non-date in a date cell is flagged', p.bad.targetDate === 'next week' && p.targetDate === '', p.bad);

// --- 7. Columns moved around in the Sheet + an extra formula column ----------
// Swap Project and Owner columns, add a "Comments" column with a formula.
sheet.data.forEach(r => { const a = r[1]; r[1] = r[2]; r[2] = a; });
const extraCol = sheet.getLastColumn() + 1;
sheet.data[0][extraCol - 1] = 'Comments';
const trackerRow = sheet.data.findIndex(r => r[2] === 'Project tracker') + 1;
sheet.formulas[trackerRow + ',' + extraCol] = '=LEN(B2)';
sheet.data[trackerRow - 1][extraCol - 1] = 7;
d = run('getData()');
p = d.projects.find(x => x.name === 'Project tracker');
check('reads correctly after columns are reordered', !!p && p.status === 'In progress', p);
d = run(`saveProject(${JSON.stringify(Object.assign({}, p, { owner: 'Both' }))})`);
check('saves correctly after columns are reordered', d.projects.find(x => x.id === p.id).owner === 'Both');
check('formula in extra column kept', sheet.formulas[trackerRow + ',' + extraCol] === '=LEN(B2)');

// --- 8. Missing column -> clear message --------------------------------------
const saved = sheet.data[0][headers.indexOf('Blocker')];
sheet.data[0][headers.indexOf('Blocker')] = 'Blockers';
const msg = throws(() => run('getData()'));
check('missing column gives a clear message', /missing from the Projects tab: Blocker\b/.test(msg || ''), msg);
sheet.data[0][headers.indexOf('Blocker')] = saved;

// --- 9. Delete ---------------------------------------------------------------
p = run('getData()').projects.find(x => x.name === 'Invoice matcher');
const staleDel = throws(() => run(`deleteProject('${p.id}', '2000-01-01 00:00:00')`));
check('delete with out-of-date copy refused', /NOT saved/.test(staleDel || ''), staleDel);
d = run(`deleteProject('${p.id}', '${p.updatedAt}')`);
check('delete removes the row', !d.projects.some(x => x.id === p.id));
check('history logs the delete', hist.some(r => r[1] === p.id && /^Deleted/.test(r[3])));

// --- 10. Direct edit in the Sheet stamps Updated at / Status since ----------
const cols = run('headerIndex_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Projects"))');
const erpRow = sheet.data.findIndex(r => r[cols.name] === 'ERP retail') + 1;
sheet.data[erpRow - 1][cols.status] = 'Delivered';
m.ss.e = { range: sheet.getRange(erpRow, cols.status + 1), source: m.ss, oldValue: undefined, user: { getEmail: () => 'bhargavi@example.com' } };
run('onEdit(__mock.ss.e)');
p = run('getData()').projects.find(x => x.name === 'ERP retail');
check('direct edit stamps Updated by', p.updatedBy === 'bhargavi@example.com', p.updatedBy);
check('direct status edit sets Status since', p.statusSince === d.today, p.statusSince);
check('direct status edit is logged', hist.some(r => r[2] === 'ERP retail' && /Delivered \(in Sheet\)/.test(r[3])));
const before = JSON.stringify(sheet.data);
m.ss.e = { range: sheet.getRange(erpRow, cols.updatedBy + 1), source: m.ss };
run('onEdit(__mock.ss.e)');
check('editing only script columns does not re-stamp', JSON.stringify(sheet.data) === before);

// --- 11. Row typed into the Sheet with no ID gets one ------------------------
const newRow = sheet.getLastRow() + 1;
sheet.put(newRow, cols.name + 1, 'Typed in Sheet');
p = run('getData()').projects.find(x => x.name === 'Typed in Sheet');
check('row typed in Sheet gets an ID on next load', p && p.id.length === 8, p);

// --- 12. View-only user ------------------------------------------------------
m.canWrite = false;
sheet.put = sheet.put; // no-op, keeps the mock throwing on write
const viewerRead = throws(() => run('getData()'));
check('view-only user can still load the page', viewerRead === null, viewerRead);
const viewerWrite = throws(() => run(`saveProject(${JSON.stringify(Object.assign({}, p, { status: 'Upcoming' }))})`));
check('view-only user gets a plain message on save', /share the Sheet with you as Editor/.test(viewerWrite || ''), viewerWrite);
m.canWrite = true;

// --- 13. Not set up yet ------------------------------------------------------
m.props = {};
m.active = false; // script not attached to a Sheet
check('not set up gives a clear message', /not set up yet/.test(throws(() => run('getData()')) || ''));
m.active = true;

// --- 14. First visit sets itself up, using Local.gs ---------------------------
m.newSpreadsheet([]);
run(`const SHARE_WITH = ['a@example.com', 'b@example.com'];
     const STARTING_PROJECTS = [{ name: 'One' }, { name: 'Two', status: 'In progress', github: 'https://github.com/x/two', notes: '=not a formula' }];`);
d = run('getData()');
check('first visit runs setup by itself', m.props.SHEET_ID === 'SHEET123' && !!m.ss.getSheetByName('History'));
check('starting projects loaded', d.projects.length === 2 && d.projects[1].status === 'In progress' && d.projects[1].notes === '=not a formula', d.projects);
check('starting projects get IDs', d.projects.every(x => x.id.length === 8));
check('Sheet shared with SHARE_WITH', JSON.stringify(m.ss.editors) === '["a@example.com","b@example.com"]', m.ss.editors);
check('time zone set to India', m.ss.tz === 'Asia/Kolkata', m.ss.tz);
run('setup()');
check('running setup again does not load the projects twice', run('getData()').projects.length === 2);

console.log(failed ? '\n' + failed + ' FAILED' : '\nAll passed');
process.exit(failed ? 1 : 0);
