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
| `data/seed-projects.csv` | Starting list of our existing projects. **Not committed** (real data). |
| `tests/` | Checks for the code, run on this PC (see the end of this file) |

## Setup (once, about 15 minutes)

One person does this. The Sheet will belong to them.

**1. Make the Sheet.**
Go to <https://sheets.new>. Name it `Project Tracker`.
Go to File > Settings and set the time zone to *(GMT+05:30) India Standard Time*.

**2. Load the starting list (optional).**
File > Import > Upload > choose `data/seed-projects.csv`.
Set *Import location* to **Replace current sheet**, then click *Import data*.

**3. Add the code.**
In the Sheet: Extensions > Apps Script.
- Click `Code.gs`, delete everything in it, and paste in all of `Code.gs` from this folder.
- Click **+** next to *Files* > **HTML**. Name it `Index` (it adds `.html` for you).
  Delete everything in it and paste in all of `Index.html`.
- Press Ctrl+S.

**4. Run setup.**
In the toolbar, pick `setup` from the dropdown (next to *Debug*), then click **Run**.
Google asks for permission: *Review permissions* > choose your account > *Allow*.
If it says *"Google hasn't verified this app"*, click *Advanced* > *Go to Project Tracker*.
This is your own script, so it's safe.
Wait for *Execution completed*. The Sheet now has a **Projects** tab with
dropdowns and a **History** tab.

**5. Share the Sheet** with the other person as **Editor** (Share button, top right).
Only people with edit access to the Sheet can change anything in the tracker.

**6. Publish the webpage.**
In Apps Script: **Deploy > New deployment** > gear icon > **Web app**.
- *Execute as:* **User accessing the web app**
- *Who has access:* **Anyone within riya.travel** (if that isn't offered: *Anyone with Google account*)

Click **Deploy** and copy the *Web app URL*. Bookmark it and send it to the other person.

**7.** The other person opens the link and allows permissions once.

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

Saving in Apps Script is **not** enough. The webpage keeps running the old
version until you publish a new one:
**Deploy > Manage deployments** > pencil icon > *Version:* **New version** > **Deploy**.
The link stays the same.

To change the owner names, statuses or priorities, edit the lists at the top
of `Code.gs`, run `setup` again, then publish a new version.

## Tests

`tests/mock.js` is a small stand-in for Google's Sheet and Apps Script services,
so the real `Code.gs` can run on this PC.

```
node tests/server-test.js Code.gs     # 41 checks on saving, conflicts, dates, setup
node tests/build-preview.js .         # builds tests/preview.html with sample projects
```

Open `tests/preview.html` in a browser to click around the page with sample data.
Add `?test=1` to the end of the address to run the 28 page checks. The results
appear at the bottom of the page.
