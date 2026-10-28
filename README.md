# Project Tracker

A webpage to track our projects: what's upcoming, in progress, in testing and
delivered, who owns it, and when it's due.

The data lives in a **Google Sheet**. The webpage is a **Google Apps Script web
app** on top of that Sheet. It's free and there's nothing to install: you log
in with your Google account.

| File | What it is |
|---|---|
| `Code.gs` | Reads and writes the Sheet |
| `Index.html` | The webpage |
| `appsscript.json` | Google settings: India time, page runs as whoever opens it, riya.travel accounts only |
| `Local.gs` | Who to share the Sheet with + our starting project list. **Not committed** (real data). |
| `data/seed-projects.csv` | The same starting list as a spreadsheet file. **Not committed.** |
| `tests/` | Checks for the code, run on this PC (see the end of this file) |

The live tracker is owned by our **shared intern Google account**. Gaurav and Bhargavi have
edit access with their own accounts. Only people with edit access to the Sheet
can change anything.

## Setup

This was done from this PC with `clasp` (Google's command line tool for Apps Script),
logged in as the shared intern account under the name `work`:

```
clasp login --user work                                   # pick the shared intern account
clasp create-script --type sheets --title "Project Tracker" --user work
clasp push --user work                                    # sends the 4 files in .claspignore
clasp create-deployment --description "v1" --user work    # prints the web app ID
```

The Apps Script API has to be switched on for the account first:
<https://script.google.com/home/usersettings>.

**The first time the page is opened, it sets itself up.** It makes the Projects
and History tabs, loads the starting list from `Local.gs`, and shares the Sheet
with the emails in `Local.gs`.

### Without clasp (by hand)

1. <https://sheets.new> > name it `Project Tracker`.
2. Extensions > Apps Script. Paste `Code.gs` into Code.gs. Add HTML file `Index`
   and paste `Index.html`. Add script file `Local` and paste `Local.gs`. Ctrl+S.
3. Deploy > New deployment > gear > **Web app**. *Execute as:* **User accessing the
   web app**. *Who has access:* **Anyone within riya.travel**. Deploy.
4. Open the web app link and allow permissions. It sets itself up.

## Using it

- **Board:** drag a card to another column to change its status. Moving a card to
  *In progress* fills in today as the start date. Moving it to *Delivered* fills in
  today as the delivered date. Either way, the form opens so you can check the date first.
- **Click any card** to edit all of its details.
- **Table:** every project in one list. Click a column heading to sort.
  *Days taken* and *On time?* are worked out from the dates.
- **Needs attention:** lists projects that are past their target date, due within
  7 days, blocked, in testing for more than 7 days, or not updated in 14 days.
  It also lists problems in the Sheet, such as text typed into a date column.
- **Numbers:** delivered this month, average days to deliver, % delivered on time,
  and deliveries per month.
- **Everyone / Gaurav / Bhargavi** filter at the top. Projects owned by *Both* show
  under each name.
- The page picks up the other person's changes by itself every minute.
- If you both edit the same project at the same moment, the second save is
  refused with a message, so nothing gets overwritten. Click Refresh and redo it.
- You can still edit the Sheet directly. *Updated at*, *Status since* and the
  *History* tab are kept up to date either way.

### Don't

- Don't rename the column headings in the Projects tab, because the page finds columns by
  their heading. Moving columns around or adding new columns is fine.
- Don't type in the *ID* column.

## Changing the code later

Saving or pushing is **not** enough. The webpage keeps running the old
version until you publish a new one. From this PC:

```
clasp push --user work
clasp deployments --user work                                        # find the web app ID
clasp update-deployment <that ID> --description "what changed" --user work
```

By hand: **Deploy > Manage deployments** > pencil icon > *Version:* **New version** > **Deploy**.
Either way the link stays the same.

To change the owner names, statuses or priorities, edit the lists at the top
of `Code.gs`, push, run `setup` once from the Apps Script editor, then publish a new version.

## Tests

`tests/mock.js` is a small stand-in for Google's Sheet and Apps Script services,
so the real `Code.gs` can run on this PC.

```
node tests/server-test.js Code.gs     # 47 checks on saving, conflicts, dates, setup
node tests/build-preview.js .         # builds tests/preview.html with sample projects
```

Open `tests/preview.html` in a browser to click around the page with sample data.
Add `?test=1` to the end of the address to run the 28 page checks. The results
appear at the bottom of the page.
