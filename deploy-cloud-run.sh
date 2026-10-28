#!/usr/bin/env bash
# Puts the Project Tracker on Google Cloud Run. Safe to run again: it updates in place.
#
# The Cloud project is shared with MasterDash, so the tracker keeps to itself:
#   - everything it creates is named "project-tracker" and labelled app=project-tracker
#   - its own image storage (not the shared cloud-run-source-deploy one), old images cleaned up
#   - permissions are set on the tracker's own service only; nothing project-wide is changed
#   - at most 1 copy runs, so it cannot use up quota or the free allowance
#   - remove-cloud-run.sh takes all of it away again
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
NAME=project-tracker
SA="$NAME@$PROJECT.iam.gserviceaccount.com"
REPO="$REGION-docker.pkg.dev/$PROJECT/$NAME/$NAME"
NUMBER=$("$G" projects describe "$PROJECT" --format='value(projectNumber)')

# Never take over a service of the same name that someone else made.
OWNER_LABEL=$("$G" run services describe "$NAME" --project "$PROJECT" --region "$REGION" \
  --format='value(metadata.labels.app)' 2>/dev/null || true)
if "$G" run services describe "$NAME" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 && [ "$OWNER_LABEL" != "$NAME" ]; then
  echo "STOP: a Cloud Run service called $NAME already exists and is not the tracker's. Nothing changed."
  exit 1
fi

echo "1/7 Switching on the sign-in gate (IAP). This only makes it available; it is turned on per service."
"$G" services enable iap.googleapis.com --project "$PROJECT"

echo "2/7 Server account (no project roles: it can only reach what is shared with it)"
"$G" iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||
  "$G" iam service-accounts create "$NAME" --project "$PROJECT" --display-name "Project Tracker (Cloud Run)" \
    --description "Project Tracker only. Can edit the tracker Sheet; has no project roles."

echo "3/7 Giving the server account edit access to the tracker Sheet (only that Sheet)"
curl -sf -X POST "https://www.googleapis.com/drive/v3/files/$SHEET_ID/permissions?sendNotificationEmail=false" \
  -H "Authorization: Bearer $("$G" auth print-access-token)" -H "x-goog-user-project: $PROJECT" \
  -H "Content-Type: application/json" -d "{\"role\":\"writer\",\"type\":\"user\",\"emailAddress\":\"$SA\"}" >/dev/null

echo "4/7 The tracker's own image storage, keeping only the 2 newest builds"
"$G" artifacts repositories describe "$NAME" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1 ||
  "$G" artifacts repositories create "$NAME" --project "$PROJECT" --location "$REGION" --repository-format docker \
    --labels "app=$NAME" --description "Project Tracker images only"
POLICY=$(mktemp)
cat > "$POLICY" <<'JSON'
[{"name": "keep-2-newest", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 2}},
 {"name": "delete-older", "action": {"type": "Delete"}, "condition": {"tagState": "any"}}]
JSON
"$G" artifacts repositories set-cleanup-policies "$NAME" --project "$PROJECT" --location "$REGION" \
  --policy "$POLICY" --no-dry-run >/dev/null
rm -f "$POLICY"

echo "5/7 Building and deploying (2-4 minutes)"
"$G" run deploy "$NAME" --source . --image "$REPO" --project "$PROJECT" --region "$REGION" \
  --service-account "$SA" --no-allow-unauthenticated --iap --labels "app=$NAME" \
  --max-instances 1 --memory 256Mi --cpu 1 \
  --set-env-vars "^;^SHEET_ID=$SHEET_ID;ALLOWED_DOMAIN=riya.travel;ALLOWED_EMAILS=$PEOPLE" --quiet

echo "6/7 Letting the sign-in gate call the tracker (this service only)"
"$G" run services add-iam-policy-binding "$NAME" --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:service-$NUMBER@gcp-sa-iap.iam.gserviceaccount.com" --role roles/run.invoker >/dev/null

echo "7/7 Who can open the page (this service only)"
for email in ${PEOPLE//,/ }; do
  "$G" iap web add-iam-policy-binding --project "$PROJECT" --region "$REGION" --resource-type cloud-run \
    --service "$NAME" --member "user:$email" --role roles/iap.httpsResourceAccessor >/dev/null
  echo "    $email"
done

echo
echo "Done. Link:"
"$G" run services describe "$NAME" --project "$PROJECT" --region "$REGION" --format='value(status.url)'
