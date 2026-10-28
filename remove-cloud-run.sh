#!/usr/bin/env bash
# Takes the Project Tracker off Google Cloud Run: removes everything deploy-cloud-run.sh made.
# Leaves the Google Sheet and the Apps Script version exactly as they are.
# Does not switch IAP off for the project, in case something else (MasterDash) uses it.
set -uo pipefail
cd "$(dirname "$0")"
source ./cloud.env

if command -v gcloud >/dev/null 2>&1; then G=gcloud; else G="$LOCALAPPDATA/google-cloud-sdk/bin/gcloud.cmd"; fi
NAME=project-tracker
SA="$NAME@$PROJECT.iam.gserviceaccount.com"

LABEL=$("$G" run services describe "$NAME" --project "$PROJECT" --region "$REGION" --format='value(metadata.labels.app)' 2>/dev/null)
if [ -n "$LABEL" ] && [ "$LABEL" != "$NAME" ]; then
  echo "STOP: the service called $NAME is not the tracker's. Nothing removed."
  exit 1
fi

echo "Removing the Cloud Run service (its sign-in permissions go with it)"
"$G" run services delete "$NAME" --project "$PROJECT" --region "$REGION" --quiet

echo "Removing the tracker's image storage"
"$G" artifacts repositories delete "$NAME" --project "$PROJECT" --location "$REGION" --quiet

echo "Taking the server account off the Sheet, then deleting it"
TOKEN=$("$G" auth print-access-token)
PERM=$(curl -s "https://www.googleapis.com/drive/v3/files/$SHEET_ID/permissions?fields=permissions(id,emailAddress)" \
  -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=(JSON.parse(s).permissions||[]).find(x=>x.emailAddress===process.argv[1]);console.log(p?p.id:"")})' "$SA")
[ -n "$PERM" ] && curl -s -X DELETE "https://www.googleapis.com/drive/v3/files/$SHEET_ID/permissions/$PERM" \
  -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT"
"$G" iam service-accounts delete "$SA" --project "$PROJECT" --quiet

echo "Done. The tracker is no longer in the Cloud project."
