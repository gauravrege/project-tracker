// Builds preview.html: the real Index.html + the real Code.gs running on the
// mock Sheet in the browser, with google.script.run faked on top.
const fs = require('fs');
const path = require('path');
const project = process.argv[2];
const here = __dirname;

const index = fs.readFileSync(path.join(project, 'Index.html'), 'utf8');
const code = fs.readFileSync(path.join(project, 'Code.gs'), 'utf8');
const mock = fs.readFileSync(path.join(here, 'mock.js'), 'utf8');

const seed = `
<script>/*MOCK*/</script>
<script>
// Code.gs in its own scope, like on Google's server.
const server = (function () { /*CODE*/
  return { setup, getData, saveProject, deleteProject, onEdit };
})();

(function seed() {
  const day = n => Utilities.formatDate(new Date(Date.now() + n * 864e5), 'Asia/Kolkata', 'yyyy-MM-dd');
  __mock.newSpreadsheet([]);
  server.setup();
  const add = p => server.saveProject(Object.assign({ id: '', updatedAt: '' }, p)).projects.find(x => x.name === p.name);
  const sheet = __mock.ss.getSheetByName('Projects');
  const header = sheet.data[0];
  const setCell = (name, col, value) => { const r = sheet.data.findIndex(row => row[header.indexOf('Project')] === name); sheet.data[r][header.indexOf(col)] = value; };
  const ist = s => Utilities.parseDate(s, 'Asia/Kolkata', 'yyyy-MM-dd');

  add({ name: 'ERP retail', owner: 'Gaurav', status: 'In progress', priority: 'High', startDate: day(-20), targetDate: day(4), askedBy: 'Retail team', github: 'https://github.com/example/erp-retail' });
  add({ name: 'PDF Invoice Renamer', owner: 'Gaurav', status: 'Delivered', startDate: day(-40), targetDate: day(-25), deliveredDate: day(-27), askedBy: 'Accounts' });
  add({ name: 'resumescraper', owner: 'Bhargavi', status: 'Delivered', startDate: day(-50), targetDate: day(-35), deliveredDate: day(-30), askedBy: 'HR' });
  add({ name: 'mstrdash', owner: 'Both', status: 'Testing', priority: 'High', startDate: day(-30), targetDate: day(-2), tester: 'Accounts team' });
  setCell('mstrdash', 'Status since', ist(day(-12)));
  add({ name: 'Expense dashboard', owner: 'Bhargavi', status: 'In progress', priority: 'Medium', startDate: day(-6), targetDate: day(20), askedBy: 'Finance head', blocker: 'Waiting for sample files from accounts' });
  add({ name: 'Sales summary auto', owner: 'Gaurav', status: 'Upcoming', priority: 'Medium', targetDate: day(30) });
  add({ name: 'Bank statement upload', owner: 'Bhargavi', status: 'On hold', priority: 'Low' });
  add({ name: 'Greeting cards', status: 'Upcoming' });
  setCell('Greeting cards', 'Status', '');
  setCell('Greeting cards', 'Target date', 'next week');
  add({ name: 'Project tracker', owner: 'Both', status: 'In progress', priority: 'High', startDate: day(0), targetDate: day(7) });
  add({ name: 'invoice-to-excel', owner: 'Gaurav', status: 'Delivered', startDate: day(-15), targetDate: day(-5), deliveredDate: day(-3) });
  add({ name: 'Airline PDF invoice to Excel', status: 'Upcoming', priority: 'Low' });
  setCell('Airline PDF invoice to Excel', 'Updated at', new Date(Date.now() - 20 * 864e5));
  window.__day = day;
})();

// google.script.run, faked: async, JSON round-trip, and refuses Date objects
// in results the way the real one does.
window.google = { script: {} };
Object.defineProperty(window.google.script, 'run', { get() {
  let ok = () => {}, fail = () => {};
  const runner = {
    withSuccessHandler(f) { ok = f; return runner; },
    withFailureHandler(f) { fail = f; return runner; },
  };
  ['getData', 'saveProject', 'deleteProject'].forEach(fn => {
    runner[fn] = (...args) => setTimeout(() => {
      try {
        const result = server[fn](...JSON.parse(JSON.stringify(args)));
        (function walk(o) { if (o instanceof Date) throw new Error('Date object in result'); if (o && typeof o === 'object') Object.values(o).forEach(walk); })(result);
        ok(JSON.parse(JSON.stringify(result)));
      } catch (e) { fail(new Error(e.message)); }
    }, 5);
  });
  return runner;
} });

const qs = new URLSearchParams(location.search);
try { localStorage.setItem('tracker.view', qs.get('view') || 'board'); localStorage.setItem('tracker.owner', 'All'); } catch (e) {}
</script>`;

const scenario = `
<script>
(async function () {
  const qs = new URLSearchParams(location.search);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(150);
  if (qs.get('open')) { const p = state.data.projects.find(x => x.name === qs.get('open')); openDialog(p, p, []); }
  if (qs.get('move')) { const [name, to] = qs.get('move').split('>'); moveTo(state.data.projects.find(x => x.name === name).id, to); }
  if (!qs.get('test')) return;

  const results = [];
  const check = (name, cond, extra) => results.push((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(extra)));
  const byName = n => state.data.projects.find(x => x.name === n);
  const cardsIn = s => [...document.querySelectorAll('.col[data-status="' + s + '"] .card')].map(c => c.querySelector('.card-title').textContent);
  const setField = (f, v) => { const el = field(f); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
  const submit = () => document.querySelector('#save').click();

  check('11 cards on the board', document.querySelectorAll('.card').length === 11, document.querySelectorAll('.card').length);
  check('Not set column shown for the project with no status', cardsIn('Not set').includes('Greeting cards'));
  check('bad date shown on card', /not a date: "next week"/.test(document.body.textContent));
  check('Needs attention badge has a count', Number(document.querySelector('#attn-count').textContent) > 0);

  // add
  document.querySelector('#add').click();
  check('new project dialog opens', document.querySelector('#dlg').open);
  submit();
  check('saving with no name shows an error', !document.querySelector('#dlg-error').hidden && /name/.test(document.querySelector('#dlg-error').textContent));
  setField('name', 'Test project'); setField('owner', 'Gaurav'); setField('targetDate', __day(10));
  submit(); await wait(100);
  check('new project saved and dialog closed', !!byName('Test project') && !document.querySelector('#dlg').open);
  check('new project appears in Upcoming', cardsIn('Upcoming').includes('Test project'));

  // status change in dialog fills delivered date
  document.querySelector('.card[data-id="' + byName('ERP retail').id + '"]').click();
  check('clicking a card opens it', document.querySelector('#dlg').open && field('name').value === 'ERP retail');
  setField('status', 'Delivered');
  check('choosing Delivered fills in today as delivered date', field('deliveredDate').value === state.data.today);
  check('and tells the person', /Delivered date set to today/.test(document.querySelector('#dlg-notes').textContent));
  submit(); await wait(100);
  check('ERP retail now Delivered', byName('ERP retail').status === 'Delivered' && byName('ERP retail').deliveredDate === state.data.today);

  // moving back out of Delivered clears the date (after a check)
  moveTo(byName('ERP retail').id, 'Testing');
  check('moving out of Delivered asks first', document.querySelector('#dlg').open && field('deliveredDate').value === '');
  document.querySelector('#cancel').click();
  check('cancel leaves it Delivered', byName('ERP retail').status === 'Delivered');

  // conflict: someone else saves while the dialog is open
  document.querySelector('.card[data-id="' + byName('mstrdash').id + '"]').click();
  setField('notes', 'my change');
  const other = server.getData().projects.find(x => x.name === 'mstrdash');
  __mock.user = 'bhargavi@example.com';
  server.saveProject(Object.assign({}, other, { notes: 'Bhargavi change' }));
  __mock.user = 'gaurav@example.com';
  submit(); await wait(100);
  const err = document.querySelector('#dlg-error');
  check('conflict shows a clear message and keeps the dialog open', !err.hidden && /bhargavi@example.com changed this project/.test(err.textContent) && document.querySelector('#dlg').open, err.textContent);
  check('my typed text is still in the box', field('notes').value === 'my change');
  document.querySelector('#cancel').click();
  document.querySelector('#refresh').click(); await wait(100);
  check('after refresh, Bhargavi change is visible', byName('mstrdash').notes === 'Bhargavi change');

  // drag with no dates to fill saves straight away
  moveTo(byName('Bank statement upload').id, 'Testing'); await wait(100);
  check('drag On hold -> Testing saves without a dialog', byName('Bank statement upload').status === 'Testing' && !document.querySelector('#dlg').open);
  // drag to In progress with no start date asks first
  moveTo(byName('Sales summary auto').id, 'In progress');
  check('drag to In progress fills start date and asks', document.querySelector('#dlg').open && field('startDate').value === state.data.today);
  document.querySelector('#cancel').click();
  // a project with a broken date always asks first
  setTimeout(() => {}, 0);

  // delete
  document.querySelector('.card[data-id="' + byName('Test project').id + '"]').click();
  document.querySelector('#delete').click();
  check('first delete click only asks', !!byName('Test project') && /again/.test(document.querySelector('#delete').textContent));
  document.querySelector('#delete').click(); await wait(100);
  check('second click deletes', !byName('Test project'));

  // html in a name is shown as text
  server.saveProject({ id: '', updatedAt: '', name: '<img src=x onerror="window.__xss=1">', status: 'Upcoming' });
  document.querySelector('#refresh').click(); await wait(100);
  check('HTML in project names is not run', window.__xss === undefined && /<img src=x/.test(document.querySelector('#main').textContent));

  // search + owner filter
  const search = document.querySelector('#search');
  search.value = 'erp'; search.dispatchEvent(new Event('input'));
  check('search filters cards', document.querySelectorAll('.card').length === 1, document.querySelectorAll('.card').length);
  search.value = ''; search.dispatchEvent(new Event('input'));
  const owner = document.querySelector('#owner-filter');
  owner.value = 'Bhargavi'; owner.dispatchEvent(new Event('change'));
  const names = [...document.querySelectorAll('.card .card-title')].map(b => b.textContent);
  check('owner filter shows Bhargavi + Both projects', names.includes('resumescraper') && names.includes('mstrdash') && !names.includes('ERP retail'), names);
  owner.value = 'All'; owner.dispatchEvent(new Event('change'));

  // other views
  document.querySelector('[data-view="table"]').click();
  check('table has a row per project', document.querySelectorAll('tbody tr').length === state.data.projects.length);
  document.querySelector('th[data-sort="late"]').click();
  check('sorting by On time? works', document.querySelector('th[data-sort="late"]').getAttribute('aria-sort') === 'ascending');
  document.querySelector('[data-view="attention"]').click();
  const attn = document.querySelector('#main').textContent;
  check('attention lists overdue, blocked, long testing, stale', /past target date/.test(attn) && /Blocked: Waiting/.test(attn) && /No update for 20 days/.test(attn), attn.slice(0, 400));
  document.querySelector('[data-view="numbers"]').click();
  check('numbers view shows on-time percentage', /Delivered on time/.test(document.querySelector('#main').textContent));

  document.body.insertAdjacentHTML('beforeend', '<pre id="results">' + results.join('\\n').replace(/</g, '&lt;') + '</pre>');
})();
</script>`;

const fullSeed = seed.split('/*MOCK*/').join(mock).split('/*CODE*/').join(code);
const out = index.replace('</head>', () => fullSeed + '\n</head>').replace('</body>', () => scenario + '\n</body>');
fs.writeFileSync(path.join(here, 'preview.html'), out);
console.log('wrote preview.html');
