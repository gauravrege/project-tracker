#!/usr/bin/env bash
# Puts the Project Tracker on Google Cloud Run. Safe to run again: it updates in place.
#
# Needs:
#   - gcloud logged in:   gcloud auth login --enable-gdrive-access
#   - cloud.env next to this file (not on GitHub), with:
#       PROJECT=<cloud project id>   REGION=asia-south1
#       SHEET_ID=<tracker sheet id>  PEOPLE=<comma-separated emails who may open and edit>
set -euo pipefail
cd "$(dirname "$0")"
source ./cloud.env

if command -v gcloud >/dev/null 2>&1; then G=gcloud; else G="$LOCALAPPDATA/google-cloud-sdk/bin/gcloud.cmd"; fi
SA="project-tracker@$PROJECT.iam.gserviceaccount.com"
NUMBER=$("$G" projects describe "$PROJECT" --format='value(projectNumber)')

echo "1/6 Switching on the sign-in gate (IAP)"
"$G" services enable iap.googleapis.com --project "$PROJECT"

echo "2/6 Server account (no project roles: it can only reach what is shared with it)"
"$G" iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||
  "$G" iam service-accounts create project-tracker --project "$PROJECT" --display-name "Project Tracker (Cloud Run)"

echo "3/6 Giving the server account edit access to the tracker Sheet (only that Sheet)"
curl -sf -X POST "https://www.googleapis.com/drive/v3/files/$SHEET_ID/permissions?sendNotificationEmail=false" \
  -H "Authorization: Bearer $("$G" auth print-access-token)" -H "x-goog-user-project: $PROJECT" \
  -H "Content-Type: application/json" -d "{\"role\":\"writer\",\"type\":\"user\",\"emailAddress\":\"$SA\"}" >/dev/null

echo "4/6 Building and deploying (2-4 minutes)"
"$G" run deploy project-tracker --source . --project "$PROJECT" --region "$REGION" \
  --service-account "$SA" --no-allow-unauthenticated --iap \
  --max-instances 1 --memory 256Mi --cpu 1 \
  --set-env-vars "^;^SHEET_ID=$SHEET_ID;ALLOWED_DOMAIN=riya.travel;ALLOWED_EMAILS=$PEOPLE" --quiet

echo "5/6 Letting the sign-in gate call the server"
"$G" run services add-iam-policy-binding project-tracker --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:service-$NUMBER@gcp-sa-iap.iam.gserviceaccount.com" --role roles/run.invoker >/dev/null

echo "6/6 Who can open the page"
for email in ${PEOPLE//,/ }; do
  "$G" iap web add-iam-policy-binding --project "$PROJECT" --region "$REGION" --resource-type cloud-run \
    --service project-tracker --member "user:$email" --role roles/iap.httpsResourceAccessor >/dev/null
  echo "    $email"
done

echo
echo "Done. Link:"
"$G" run services describe project-tracker --project "$PROJECT" --region "$REGION" --format='value(status.url)'
