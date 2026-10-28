# Project Tracker

A webpage to track our projects: what's upcoming, in progress, in testing and
delivered, who owns it, and when it's due.

The data lives in a **Google Sheet**. The same webpage runs in two places, both
reading and writing that one Sheet:

- **Google Cloud Run** (main link). A short link, faster, with sign-in by Google
  (IAP) for the people on our list only. Costs about ₹0 at our size.
- **Google Apps Script** (backup link). Free. It also runs the trigger that keeps
  *Updated at* correct when someone edits the Sheet directly.

| File | What it is |
|---|---|
| `server.js` | Cloud Run server: serves the page, reads and writes the Sheet. No npm packages. |
| `Dockerfile`, `package.json`, `.gcloudignore` | How Cloud Run builds it. Only those files and `Index.html` are uploaded. |
| `deploy-cloud-run.sh` | Puts it on Cloud Run (see below). Reads `cloud.env`, which is **not committed**. |
| `remove-cloud-run.sh` | Takes it off Cloud Run again. The Sheet and the Apps Script version stay. |
| `Code.gs` | Apps Script version of the server. Keep its lists in step with `server.js`. |
| `Index.html` | The webpage |
| `appsscript.json` | Google settings: India time, page runs as whoever opens it, riya.travel accounts only |
| `Local.gs` | Who to share the Sheet with + our starting project list. **Not committed** (real data). |
| `data/seed-projects.csv` | The same starting list as a spreadsheet file. **Not committed.** |
| `tests/` | Checks for the code, run on this PC (see the end of this file) |

The live tracker is owned by our **shared intern Google account**. Gaurav and Bhargavi have
edit access with their own accounts. Only people with edit access to the Sheet
can change anything.

## Google Cloud Run

```
gcloud auth login --enable-gdrive-access      # once, as your riya.travel account
bash deploy-cloud-run.sh                      # first time and after every code change
```

`cloud.env` (next to the script, not on GitHub) holds the Cloud project, region,
Sheet ID and `PEOPLE`, the comma-separated emails allowed in. **Everyone on
that list can edit**, because the server writes to the Sheet with its own
account. The script:

1. switches on IAP, Google's sign-in gate in front of the page;
2. makes a server account with no project roles;
3. shares **only the tracker Sheet** with that account as Editor;
4. makes the tracker's own image storage, keeping the 2 newest builds;
5. builds and deploys, at most 1 copy running (keeps it inside the free tier,
   and lets the server do one save at a time);
6. lets IAP call the server and nobody else;
7. gives each person on `PEOPLE` access through IAP.

To add someone later: add their email to `PEOPLE` and run the script again.

### Sharing the Cloud project with MasterDash

The tracker lives in the Cloud project made for MasterDash, so it keeps out of
MasterDash's way:

- everything it creates is named `project-tracker` and labelled
  `app=project-tracker` (the service, its account, its image storage), so the
  billing report shows its cost separately;
- it builds into its own image storage, not the shared `cloud-run-source-deploy`,
  and keeps only the 2 newest images;
- permissions are set on the tracker's own service only, never project-wide;
- it has no secrets, no scheduler jobs, and runs at most 1 copy;
- the deploy stops if a service called `project-tracker` exists that isn't ours.

`bash remove-cloud-run.sh` removes all of it.

## Google Apps Script setup


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
node tests/cloud-test.js              # 27 checks on server.js, against a stand-in Sheets API
node tests/server-test.js Code.gs     # 47 checks on Code.gs: saving, conflicts, dates, setup
node tests/build-preview.js .         # builds tests/preview.html with sample projects
```

Open `tests/preview.html` in a browser to click around the page with sample data.
Add `?test=1` to the end of the address to run the 28 page checks. The results
appear at the bottom of the page.
