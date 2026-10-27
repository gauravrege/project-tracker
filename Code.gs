// Project Tracker: a webpage on top of a Google Sheet.
// The Sheet is the database. The webpage (Index.html) reads and writes it.
// Setup steps are in README.md.

// Dropdown choices. Change these, then run setup() again to update the Sheet.
const OWNERS = ['Gaurav', 'Bhargavi', 'Both'];
const STATUSES = ['Upcoming', 'In progress', 'Testing', 'Delivered', 'On hold'];
const PRIORITIES = ['High', 'Medium', 'Low'];

const PROJECTS_SHEET = 'Projects';
const HISTORY_SHEET = 'History';

// Sheet column header -> field name the webpage uses.
// Columns are found by header name, so their order in the Sheet does not matter.
const COLUMNS = [
  ['ID', 'id'],
  ['Project', 'name'],
  ['Owner', 'owner'],
  ['Asked by', 'askedBy'],
  ['Status', 'status'],
  ['Status since', 'statusSince'],
  ['Priority', 'priority'],
  ['Start date', 'startDate'],
  ['Target date', 'targetDate'],
  ['Delivered date', 'deliveredDate'],
  ['Tester', 'tester'],
  ['Feedback', 'feedback'],
  ['Blocker', 'blocker'],
  ['GitHub', 'github'],
  ['Runs on', 'runsOn'],
  ['Notes', 'notes'],
  ['Updated at', 'updatedAt'],
  ['Updated by', 'updatedBy'],
];
const DATE_FIELDS = ['statusSince', 'startDate', 'targetDate', 'deliveredDate'];
// Fields the webpage can change. The rest are filled in by this script.
const EDITABLE = ['name', 'owner', 'askedBy', 'status', 'priority', 'startDate', 'targetDate',
  'deliveredDate', 'tester', 'feedback', 'blocker', 'github', 'runsOn', 'notes'];
const LABELS = Object.fromEntries(COLUMNS.map(([header, field]) => [field, header]));

// ---------------------------------------------------------------------------
// Run this once from the Apps Script editor. Safe to run again any time.
// ---------------------------------------------------------------------------
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Open Apps Script from inside the Google Sheet (Extensions > Apps Script), then run setup again.');
  }
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());

  let sheet = ss.getSheetByName(PROJECTS_SHEET);
  if (!sheet) {
    // Use the first tab if it is empty or holds the imported starting list.
    const first = ss.getSheets()[0];
    const firstHeader = first.getLastColumn() ? String(first.getRange(1, 1).getValue()) : '';
    sheet = (first.getLastRow() === 0 || firstHeader === 'ID' || firstHeader === 'Project')
      ? first.setName(PROJECTS_SHEET)
      : ss.insertSheet(PROJECTS_SHEET, 0);
  }

  // Add any missing column headers at the end.
  const lastCol = sheet.getLastColumn();
  const existing = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim()) : [];
  const missing = COLUMNS.map(c => c[0]).filter(h => existing.indexOf(h) === -1);
  if (missing.length) sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);

  // An imported CSV shrinks the tab to fit. Give dropdowns room to grow.
  if (sheet.getMaxRows() < 1000) sheet.insertRowsAfter(sheet.getMaxRows(), 1000 - sheet.getMaxRows());

  const cols = headerIndex_(sheet);
  const rows = sheet.getMaxRows() - 1;
  const column = field => sheet.getRange(2, cols[field] + 1, rows, 1);
  const dropdown = values => SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true).setAllowInvalid(false).build();

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold').setBackground('#e8eef6');
  EDITABLE.filter(f => DATE_FIELDS.indexOf(f) === -1).forEach(f => column(f).setNumberFormat('@'));
  column('id').setNumberFormat('@');
  column('owner').setDataValidation(dropdown(OWNERS));
  column('status').setDataValidation(dropdown(STATUSES));
  column('priority').setDataValidation(dropdown(PRIORITIES));
  const dateRule = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false)
    .setHelpText('Enter a date, e.g. 15/11/2026').build();
  DATE_FIELDS.forEach(f => column(f).setNumberFormat('dd mmm yyyy').setDataValidation(dateRule));
  column('updatedAt').setNumberFormat('dd mmm yyyy hh:mm');

  historySheet_(ss);
  fillMissingIds_(sheet, cols);
  console.log('Setup done. Sheet: ' + ss.getUrl());
}

// ---------------------------------------------------------------------------
// Webpage
// ---------------------------------------------------------------------------
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Project Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Everything the webpage needs, in one call.
function getData() {
  try {
    const sheet = getSheet_();
    const ss = sheet.getParent();
    const tz = ss.getSpreadsheetTimeZone();
    const cols = headerIndex_(sheet);

    // Rows typed straight into the Sheet have no ID yet. Give them one so
    // the webpage can edit them. Viewers cannot write, so skip it for them.
    const lock = LockService.getScriptLock();
    if (lock.tryLock(5000)) {
      try { fillMissingIds_(sheet, cols); } catch (err) { /* view-only user */ } finally { lock.releaseLock(); }
    }

    const last = sheet.getLastRow();
    const values = last > 1 ? sheet.getRange(2, 1, last - 1, cols.width).getValues() : [];
    const projects = values
      .map(row => toProject_(row, cols, tz))
      .filter(p => p.id || p.name);

    return {
      projects: projects,
      user: Session.getActiveUser().getEmail(),
      today: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'),
      owners: OWNERS,
      statuses: STATUSES,
      priorities: PRIORITIES,
      sheetUrl: ss.getUrl(),
    };
  } catch (err) {
    throw friendly_(err);
  }
}

// Add a project (no id) or save changes to one (with id).
// `input.updatedAt` is what the webpage last saw. If the Sheet has changed
// since, someone else edited the project and we refuse rather than overwrite.
function saveProject(input) {
  withLock_(() => {
    const sheet = getSheet_();
    const ss = sheet.getParent();
    const tz = ss.getSpreadsheetTimeZone();
    const cols = headerIndex_(sheet);
    const clean = validate_(input);
    const now = new Date();
    const user = Session.getActiveUser().getEmail() || 'unknown';

    let before = null;
    let rowNum = 0;
    let row;
    if (input.id) {
      rowNum = findRow_(sheet, cols, input.id);
      if (!rowNum) throw new Error('This project is no longer in the Sheet. Someone may have deleted it. Click Refresh.');
      const range = sheet.getRange(rowNum, 1, 1, cols.width);
      const values = range.getValues()[0];
      const formulas = range.getFormulas()[0];
      before = toProject_(values, cols, tz);
      if (before.updatedAt !== String(input.updatedAt || '')) throw conflict_(before);
      // Keep any formulas in extra columns someone added to the Sheet.
      row = values.map((v, i) => formulas[i] || v);
    } else {
      row = new Array(cols.width).fill('');
      row[cols.id] = newId_();
    }

    EDITABLE.forEach(f => {
      row[cols[f]] = DATE_FIELDS.indexOf(f) !== -1 ? toDate_(clean[f], tz) : safeText_(clean[f]);
    });
    const statusChanged = !before || before.status !== clean.status;
    if (statusChanged) row[cols.statusSince] = toDate_(Utilities.formatDate(now, tz, 'yyyy-MM-dd'), tz);
    row[cols.updatedAt] = now;
    row[cols.updatedBy] = user;

    if (rowNum) sheet.getRange(rowNum, 1, 1, cols.width).setValues([row]);
    else sheet.appendRow(row);

    if (!before) logHistory_(ss, now, row[cols.id], clean.name, 'Added as ' + clean.status, user);
    else if (statusChanged) logHistory_(ss, now, input.id, clean.name, (before.status || 'No status') + ' → ' + clean.status, user);
  });
  return getData();
}

function deleteProject(id, seenUpdatedAt) {
  withLock_(() => {
    const sheet = getSheet_();
    const ss = sheet.getParent();
    const cols = headerIndex_(sheet);
    const rowNum = findRow_(sheet, cols, id);
    if (!rowNum) return; // already gone
    const before = toProject_(sheet.getRange(rowNum, 1, 1, cols.width).getValues()[0], cols, ss.getSpreadsheetTimeZone());
    if (before.updatedAt !== String(seenUpdatedAt || '')) throw conflict_(before);
    sheet.deleteRow(rowNum);
    logHistory_(ss, new Date(), id, before.name, 'Deleted (was ' + (before.status || 'No status') + ')',
      Session.getActiveUser().getEmail() || 'unknown');
  });
  return getData();
}

// Runs by itself when someone edits the Sheet directly (not through the
// webpage), so "Updated at" and "Status since" stay true.
function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== PROJECTS_SHEET || e.range.getLastRow() < 2) return;
  let cols;
  try { cols = headerIndex_(sheet); } catch (err) { return; }

  const firstCol = e.range.getColumn() - 1;
  const lastCol = e.range.getLastColumn() - 1;
  const touched = c => c >= firstCol && c <= lastCol;
  const fieldsTouched = COLUMNS.map(c => c[1]).filter(f => touched(cols[f]));
  const scriptOwned = ['id', 'statusSince', 'updatedAt', 'updatedBy'];
  if (fieldsTouched.length && fieldsTouched.every(f => scriptOwned.indexOf(f) !== -1)) return;

  const start = Math.max(e.range.getRow(), 2);
  const n = e.range.getLastRow() - start + 1;
  const values = sheet.getRange(start, 1, n, cols.width).getValues();
  const tz = e.source.getSpreadsheetTimeZone();
  const now = new Date();
  const today = toDate_(Utilities.formatDate(now, tz, 'yyyy-MM-dd'), tz);
  const who = (e.user && e.user.getEmail()) || 'edited in Sheet';
  const statusTouched = touched(cols.status);

  values.forEach((row, i) => {
    if (!row[cols.name] && !row[cols.id]) return; // empty row
    const r = start + i;
    sheet.getRange(r, cols.updatedAt + 1).setValue(now);
    sheet.getRange(r, cols.updatedBy + 1).setValue(who);
    if (statusTouched) {
      sheet.getRange(r, cols.statusSince + 1).setValue(today);
      const from = n === 1 && e.oldValue ? e.oldValue + ' → ' : 'Set to ';
      logHistory_(e.source, now, row[cols.id], row[cols.name], from + (row[cols.status] || 'No status') + ' (in Sheet)', who);
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('The tracker is not set up yet. Open the Sheet, go to Extensions > Apps Script and run "setup".');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(PROJECTS_SHEET);
  if (!sheet) throw new Error('The "' + PROJECTS_SHEET + '" tab is missing from the Google Sheet. Run "setup" in Apps Script to add it back.');
  return sheet;
}

function historySheet_(ss) {
  let sheet = ss.getSheetByName(HISTORY_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(HISTORY_SHEET);
    sheet.getRange(1, 1, 1, 5).setValues([['When', 'Project ID', 'Project', 'Change', 'By']])
      .setFontWeight('bold').setBackground('#e8eef6');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('dd mmm yyyy hh:mm');
  }
  return sheet;
}

function logHistory_(ss, when, id, name, change, by) {
  historySheet_(ss).appendRow([when, id, name, change, by]);
}

// Map each field to its column position (0-based). Says which columns are
// missing instead of failing somewhere later.
function headerIndex_(sheet) {
  const width = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, width).getValues()[0].map(h => String(h).trim());
  const idx = { width: width };
  const missing = [];
  COLUMNS.forEach(([header, field]) => {
    const i = headers.indexOf(header);
    if (i === -1) missing.push(header);
    else idx[field] = i;
  });
  if (missing.length) {
    throw new Error('These columns are missing from the Projects tab: ' + missing.join(', ') +
      '. Run "setup" in Apps Script to add them back.');
  }
  return idx;
}

// One Sheet row -> one project object. Dates go out as "yyyy-MM-dd" text.
// A date cell holding something that is not a date is reported in `bad`,
// never silently dropped.
function toProject_(row, cols, tz) {
  const p = { bad: {} };
  COLUMNS.forEach(([header, field]) => {
    const v = row[cols[field]];
    if (DATE_FIELDS.indexOf(field) !== -1 || field === 'updatedAt') {
      // updatedAt keeps milliseconds: it is how saveProject spots someone else's change.
      if (v instanceof Date) p[field] = Utilities.formatDate(v, tz, field === 'updatedAt' ? 'yyyy-MM-dd HH:mm:ss.SSS' : 'yyyy-MM-dd');
      else {
        p[field] = '';
        if (v !== '' && v !== null) p.bad[field] = String(v);
      }
    } else {
      p[field] = v === null ? '' : String(v).trim();
    }
  });
  return p;
}

function validate_(input) {
  const p = {};
  EDITABLE.forEach(f => { p[f] = input[f] == null ? '' : String(input[f]).trim(); });
  if (!p.name) throw new Error('Give the project a name.');
  if (STATUSES.indexOf(p.status) === -1) throw new Error('Pick a status for the project.');
  if (p.owner && OWNERS.indexOf(p.owner) === -1) throw new Error('Owner must be one of: ' + OWNERS.join(', ') + '.');
  if (p.priority && PRIORITIES.indexOf(p.priority) === -1) throw new Error('Priority must be one of: ' + PRIORITIES.join(', ') + '.');
  DATE_FIELDS.forEach(f => {
    if (p[f] !== undefined && p[f] && !/^\d{4}-\d{2}-\d{2}$/.test(p[f])) throw new Error(LABELS[f] + ' is not a valid date.');
  });
  if (p.github && !/^https?:\/\//i.test(p.github)) throw new Error('The GitHub link should start with https://');
  return p;
}

function findRow_(sheet, cols, id) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const ids = sheet.getRange(2, cols.id + 1, last - 1, 1).getValues().map(r => String(r[0]));
  const i = ids.indexOf(String(id));
  return i === -1 ? 0 : i + 2;
}

function fillMissingIds_(sheet, cols) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const range = sheet.getRange(2, 1, last - 1, cols.width);
  const values = range.getValues();
  let changed = false;
  const ids = values.map(row => {
    if (!row[cols.id] && row[cols.name]) { changed = true; return [newId_()]; }
    return [row[cols.id]];
  });
  if (changed) sheet.getRange(2, cols.id + 1, ids.length, 1).setValues(ids);
}

function newId_() {
  return Utilities.getUuid().slice(0, 8);
}

function toDate_(text, tz) {
  return text ? Utilities.parseDate(text, tz, 'yyyy-MM-dd') : '';
}

// Text starting with "=" would be run as a formula by Google Sheets.
function safeText_(text) {
  return /^[=+]/.test(text) ? "'" + text : text;
}

function conflict_(before) {
  const who = before.updatedBy || 'Someone';
  const when = before.updatedAt ? ' at ' + before.updatedAt.slice(11, 16) + ' on ' + before.updatedAt.slice(0, 10) : '';
  return new Error(who + ' changed this project' + when + ' after you opened it. Your changes were NOT saved. ' +
    'Copy anything you typed, click Refresh, then make your change again.');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('The tracker is busy saving another change. Try again in a few seconds.');
  try {
    return fn();
  } catch (err) {
    throw friendly_(err);
  } finally {
    lock.releaseLock();
  }
}

// Turn Google's permission errors into something a person can act on.
function friendly_(err) {
  const msg = String(err && err.message || err);
  if (/permission|access denied|not have access|openById/i.test(msg)) {
    return new Error('You do not have edit access to the tracker\'s Google Sheet. ' +
      'Ask Gaurav to share the Sheet with you as Editor.');
  }
  return err instanceof Error ? err : new Error(msg);
}
