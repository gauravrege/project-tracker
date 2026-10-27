// Minimal stand-in for the Apps Script services Code.gs uses.
// Works in Node (vm context) and in a browser (globalThis).
(function (G) {
  const TZ = 'Asia/Kolkata';

  function Range(sheet, row, col, nr, nc) {
    this.sheet = sheet; this.row = row; this.col = col; this.nr = nr; this.nc = nc;
    if (row < 1 || col < 1) throw new Error('Range out of bounds');
    if (row + nr - 1 > sheet.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
  }
  Range.prototype.getValues = function () {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const row = [];
      for (let c = 0; c < this.nc; c++) {
        const v = (this.sheet.data[this.row - 1 + r] || [])[this.col - 1 + c];
        row.push(v === undefined ? '' : v instanceof Date ? new Date(v.getTime()) : v);
      }
      out.push(row);
    }
    return out;
  };
  Range.prototype.getValue = function () { return this.getValues()[0][0]; };
  Range.prototype.getFormulas = function () {
    return this.getValues().map((row, r) => row.map((_, c) => this.sheet.formulas[(this.row + r) + ',' + (this.col + c)] || ''));
  };
  Range.prototype.setValues = function (vals) {
    if (vals.length !== this.nr || vals.some(r => r.length !== this.nc)) throw new Error('Data size does not match range');
    vals.forEach((row, r) => row.forEach((v, c) => this.sheet.put(this.row + r, this.col + c, v)));
    return this;
  };
  Range.prototype.setValue = function (v) { return this.setValues([[v]]); };
  ['setNumberFormat', 'setDataValidation', 'setFontWeight', 'setBackground'].forEach(m => {
    Range.prototype[m] = function () { this.sheet.calls.push(m); return this; };
  });
  Range.prototype.getRow = function () { return this.row; };
  Range.prototype.getColumn = function () { return this.col; };
  Range.prototype.getLastRow = function () { return this.row + this.nr - 1; };
  Range.prototype.getLastColumn = function () { return this.col + this.nc - 1; };
  Range.prototype.getSheet = function () { return this.sheet; };

  function Sheet(ss, name, data) {
    this.ss = ss; this.name = name; this.data = data || []; this.formulas = {}; this.maxRows = Math.max(1000, this.data.length); this.calls = [];
  }
  Sheet.prototype.put = function (r, c, v) {
    if (!mock.canWrite) throw new Error('You do not have permission to access the requested document.');
    while (this.data.length < r) this.data.push([]);
    const key = r + ',' + c;
    if (typeof v === 'string' && v.charAt(0) === '=') {
      if (this.formulas[key] !== v) this.data[r - 1][c - 1] = '';
      this.formulas[key] = v;
      return;
    }
    delete this.formulas[key];
    if (typeof v === 'string' && v.charAt(0) === "'") v = v.slice(1);
    this.data[r - 1][c - 1] = v;
  };
  const filled = v => v !== '' && v !== undefined && v !== null;
  Sheet.prototype.getLastRow = function () {
    for (let r = this.data.length; r > 0; r--) if ((this.data[r - 1] || []).some(filled)) return r;
    return 0;
  };
  Sheet.prototype.getLastColumn = function () {
    let max = 0;
    this.data.forEach(row => row.forEach((v, c) => { if (filled(v)) max = Math.max(max, c + 1); }));
    return max;
  };
  Sheet.prototype.getMaxRows = function () { return this.maxRows; };
  Sheet.prototype.insertRowsAfter = function (after, n) { this.maxRows += n; };
  Sheet.prototype.getRange = function (row, col, nr, nc) {
    if (typeof row === 'string') return new Range(this, 1, 1, 1, 1); // 'A:A' style, formatting only
    return new Range(this, row, col, nr || 1, nc || 1);
  };
  Sheet.prototype.appendRow = function (arr) {
    const r = this.getLastRow() + 1;
    if (r > this.maxRows) this.maxRows = r;
    arr.forEach((v, c) => this.put(r, c + 1, v));
  };
  Sheet.prototype.deleteRow = function (r) { this.data.splice(r - 1, 1); };
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.setName = function (n) { this.name = n; return this; };
  Sheet.prototype.setFrozenRows = function () { return this; };
  Sheet.prototype.getParent = function () { return this.ss; };

  function Spreadsheet() { this.sheets = []; this.id = 'SHEET123'; }
  Spreadsheet.prototype.getSheetByName = function (n) { return this.sheets.find(s => s.name === n) || null; };
  Spreadsheet.prototype.getSheets = function () { return this.sheets.slice(); };
  Spreadsheet.prototype.insertSheet = function (name, index) {
    const s = new Sheet(this, name);
    if (index === undefined) this.sheets.push(s); else this.sheets.splice(index, 0, s);
    return s;
  };
  Spreadsheet.prototype.getId = function () { return this.id; };
  Spreadsheet.prototype.getUrl = function () { return 'https://docs.google.com/spreadsheets/d/' + this.id; };
  Spreadsheet.prototype.getSpreadsheetTimeZone = function () { return TZ; };

  const validationBuilder = () => {
    const b = { build: () => ({}) };
    ['requireValueInList', 'requireDate', 'setAllowInvalid', 'setHelpText'].forEach(m => { b[m] = () => b; });
    return b;
  };

  const mock = {
    ss: null,
    active: true,
    user: 'gaurav@example.com',
    canWrite: true,
    props: {},
  };
  G.__mock = mock;

  G.SpreadsheetApp = {
    getActiveSpreadsheet: () => (mock.active ? mock.ss : null),
    openById: id => {
      if (!mock.ss || id !== mock.ss.id) throw new Error('Unexpected error while getting the method or property openById on object SpreadsheetApp.');
      return mock.ss;
    },
    newDataValidation: validationBuilder,
  };
  G.Utilities = {
    formatDate: (d, tz, pattern) => {
      const parts = {};
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' })
        .formatToParts(d).forEach(p => { parts[p.type] = p.value; });
      return pattern.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
        .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second).replace('SSS', parts.fractionalSecond);
    },
    parseDate: (text, tz, pattern) => {
      if (tz !== TZ || pattern !== 'yyyy-MM-dd') throw new Error('mock parseDate only handles IST yyyy-MM-dd');
      return new Date(text + 'T00:00:00+05:30');
    },
    getUuid: () => 'xxxxxxxx-xxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)),
  };
  G.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: k => (k in mock.props ? mock.props[k] : null),
      setProperty: (k, v) => { mock.props[k] = v; },
    }),
  };
  G.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };
  G.Session = { getActiveUser: () => ({ getEmail: () => mock.user }) };
  G.HtmlService = { createHtmlOutputFromFile: () => ({ setTitle() { return this; }, addMetaTag() { return this; } }) };

  // Build a spreadsheet whose first tab holds `rows` (first row = headers).
  mock.newSpreadsheet = function (rows) {
    const ss = new Spreadsheet();
    ss.sheets.push(new Sheet(ss, 'Sheet1', (rows || []).map(r => r.slice())));
    mock.ss = ss;
    mock.props = {};
    return ss;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
