<#
.SYNOPSIS
  Deploys the ads-optimizer stack to Google Cloud. Idempotent - safe to re-run.

.DESCRIPTION
  Provisions and deploys, in dependency order:
    1. Cloud Tasks queues (sync-tasks, recommendation-tasks)
    2. Firestore security rules + composite indexes
    3. Cloud Functions (the sync task dispatcher)
    4. Cloud Run (the reasoner worker / recommendation API)
    5. IAM bindings, using the service account discovered from step 4

  DEPLOYING IS NOT RUNNING. Nothing here enqueues a task, starts a sync, or calls the
  Anthropic API. Cost after a successful run is close to zero until you trigger work -
  Cloud Run scales to zero, and the queues are idle. The first genuinely expensive
  operation is B3's insights backfill. Trigger that deliberately, not from this script.

  DELIBERATELY NOT DONE HERE (both are outward-facing, not deployment):
    - Registering Shopify webhooks. That is a MUTATING call that makes the live store
      start sending traffic, on a token that also carries 5 write_* scopes. See B6's notes.
    - Creating Cloud Scheduler jobs. Those would start real syncs on a timer.

.PARAMETER Project
  GCP project id. Defaults to sng-meta-ads-optimizer. Always passed explicitly to every
  command, because this machine's gcloud default project is a DIFFERENT project
  (sng-inventory) and relying on the default would deploy to the wrong place.

.PARAMETER SkipChecks
  Skip `npm run check`. Don't, unless you just ran it.

.PARAMETER DryRun
  Print every command without executing anything.

.EXAMPLE
  .\scripts\deploy.ps1 -DryRun
  .\scripts\deploy.ps1
  .\scripts\deploy.ps1 -Only run
#>
[CmdletBinding()]
param(
  [string]$Project = "sng-meta-ads-optimizer",
  [string]$Region  = "asia-south1",
  [string]$ServiceName = "reasoner-worker",
  [ValidateSet("all", "queues", "firestore", "functions", "run", "iam")]
  [string]$Only = "all",
  [switch]$SkipChecks,
  [switch]$DryRun
)

# Deliberately "Continue", not "Stop". This script drives native CLIs (gcloud, firebase, npm),
# and under Windows PowerShell 5.1 a native command's stderr is wrapped in an ErrorRecord - which
# "Stop" turns into a terminating error. gcloud writes to stderr routinely EVEN ON SUCCESS
# (progress, "Created queue", auth notices), so "Stop" aborts on healthy output, and a normal
# "queue does not exist" probe kills the run. Correctness here comes from checking $LASTEXITCODE
# explicitly after every native call and throwing ourselves - see Invoke-Step.
$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
if (-not (Test-Path (Join-Path $RepoRoot "package.json"))) {
  throw "Could not locate the repo root from $PSScriptRoot (no package.json at $RepoRoot)."
}

# Windows PowerShell 5.1 compatible throughout - no ternary, no ??, no -AsHashtable.

function Write-Step { param([string]$Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Write-Note { param([string]$Text) Write-Host "    $Text" -ForegroundColor DarkGray }
function Write-Ok   { param([string]$Text) Write-Host "    OK: $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "    WARN: $Text" -ForegroundColor Yellow }

function Invoke-Step {
  param([string]$Description, [scriptblock]$Command)
  Write-Note $Description
  if ($DryRun) { Write-Host "    [dry-run] $Command" -ForegroundColor DarkYellow; return $null }
  # No 2>&1 here: see the $ErrorActionPreference comment above. Native output (including
  # stderr) goes straight to the console, and success is judged solely by the exit code.
  $global:LASTEXITCODE = 0
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "FAILED: $Description (exit $LASTEXITCODE)" }
}

# Existence probe for a native command. Swallows all output and reports only success/failure,
# so a legitimate "not found" never reaches the console as a scary error.
function Test-NativeSucceeds {
  param([scriptblock]$Command)
  $global:LASTEXITCODE = 0
  & $Command *> $null
  return ($LASTEXITCODE -eq 0)
}

function Should-Run { param([string]$Name) return ($Only -eq "all" -or $Only -eq $Name) }

Write-Host "ads-optimizer deploy" -ForegroundColor White
Write-Host "  project : $Project"
Write-Host "  region  : $Region"
Write-Host "  scope   : $Only"
if ($DryRun) { Write-Host "  MODE    : DRY RUN (nothing will be executed)" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------------------
# Preflight. Fail here rather than halfway through a deploy.
# ---------------------------------------------------------------------------------------
Write-Step "Preflight"

$account = (gcloud config get-value account 2>$null)
if (-not $account) { throw "Not authenticated. Run: gcloud auth login" }
Write-Ok "gcloud account: $account"

# Confirm the target project is actually reachable by this account, BEFORE creating anything.
$probe = gcloud projects describe $Project --format="value(projectId)" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host ($probe | Out-String) -ForegroundColor Red
  throw "Cannot access project '$Project'. Check the id and that this account has access."
}
Write-Ok "project reachable: $Project"

$defaultProject = (gcloud config get-value project 2>$null)
if ($defaultProject -and $defaultProject -ne $Project) {
  Write-Warn "gcloud's DEFAULT project is '$defaultProject', not '$Project'."
  Write-Warn "Every command below passes --project explicitly, so this is safe - but never drop that flag."
}

if (-not $SkipChecks) {
  Write-Note "Running npm run check (pass -SkipChecks to skip)..."
  if (-not $DryRun) {
    npm run check
    if ($LASTEXITCODE -ne 0) { throw "npm run check failed. Fix it before deploying." }
  }
  Write-Ok "tests and typecheck pass"
}

# ---------------------------------------------------------------------------------------
# 1. Cloud Tasks queues. Two, deliberately: a Fable turn's retry/backoff profile differs
#    from a sync task's, and an operator will want to tune them independently (D4's note).
# ---------------------------------------------------------------------------------------
if (Should-Run "queues") {
  Write-Step "1. Cloud Tasks queues"
  foreach ($queue in @("sync-tasks", "recommendation-tasks")) {
    $q = $queue  # capture for the scriptblock closures below
    if (Test-NativeSucceeds { gcloud tasks queues describe $q --location=$Region --project=$Project }) {
      Write-Ok "$q already exists (skipping)"
    } else {
      Invoke-Step "creating queue $q" { gcloud tasks queues create $q --location=$Region --project=$Project }
      Write-Ok "$q created"
    }
  }
}

# ---------------------------------------------------------------------------------------
# 2. Firestore rules + indexes. Rules are deny-all for clients (A2, sec 17.1) - the web app
#    reads through the API, never directly. Indexes back the queries C2/C3/D1 issue.
# ---------------------------------------------------------------------------------------
if (Should-Run "firestore") {
  Write-Step "2. Firestore rules and indexes"
  Invoke-Step "deploying firestore rules + indexes" { npx firebase deploy --only firestore --project $Project --non-interactive }
  Write-Ok "rules and indexes deployed"
  Write-Note "Rules deny ALL client access by design; index builds may take minutes to finish server-side."
}

# ---------------------------------------------------------------------------------------
# 3. Cloud Functions. The predeploy hook in firebase.json runs functions/scripts/bundle.mjs,
#    which esbuild-bundles the root ESM project into the CommonJS shim (B1's design).
# ---------------------------------------------------------------------------------------
if (Should-Run "functions") {
  Write-Step "3. Cloud Functions (sync dispatcher + Shopify webhook receiver)"

  # A first manual deploy of this project landed both functions in us-central1, because v2
  # defaults there and no region was set. functions/src/index.ts now pins asia-south1 to match
  # Firestore. Deploying does NOT move a function across regions - it creates a new one and
  # leaves the old one running. Warn if the us-central1 pair is still there.
  if (-not $DryRun) {
    foreach ($fn in @("syncTaskDispatch", "shopifyWebhookReceive")) {
      $f = $fn
      if (Test-NativeSucceeds { gcloud functions describe $f --region=us-central1 --project=$Project --gen2 }) {
        Write-Warn "$f still exists in us-central1 (wrong region, from an earlier deploy)."
        Write-Warn "  Delete after this deploy succeeds in $($Region):"
        Write-Warn "  gcloud functions delete $f --region=us-central1 --project=$Project --gen2 --quiet"
      }
    }
  }
  Invoke-Step "deploying functions" { npx firebase deploy --only functions --project $Project --non-interactive }
  Write-Ok "functions deployed"

  if (-not $DryRun) {
    $fnUrl = gcloud functions describe syncTaskDispatch --region=$Region --project=$Project --format="value(serviceConfig.uri)" 2>$null
    if ($fnUrl) { Write-Ok "syncTaskDispatch URL: $fnUrl"; Write-Note "This is SYNC_DISPATCH_TARGET_URL for the sync queue client." }
  }
}

# ---------------------------------------------------------------------------------------
# 4. Cloud Run reasoner worker. Built via scripts/cloudbuild.reasoner.yaml because the
#    Dockerfile lives at services/reasoner/job/ but needs the REPO ROOT as build context.
# ---------------------------------------------------------------------------------------
if (Should-Run "run") {
  Write-Step "4. Cloud Run reasoner worker"
  # Artifact Registry, not gcr.io: Container Registry is deprecated, and `gcloud run deploy
  # --source` already created this regional repo on the first (buildpacks) attempt. Regional
  # also means the image sits next to the service rather than in a US multi-region bucket.
  $repo = "cloud-run-source-deploy"
  $image = "$Region-docker.pkg.dev/$Project/$repo/$ServiceName"

  if (-not (Test-NativeSucceeds { gcloud artifacts repositories describe $repo --location=$Region --project=$Project })) {
    Invoke-Step "creating Artifact Registry repo $repo" {
      gcloud artifacts repositories create $repo --repository-format=docker --location=$Region --project=$Project
    }
  }

  Invoke-Step "building image ($image) via Cloud Build" {
    gcloud builds submit --project=$Project --config=scripts/cloudbuild.reasoner.yaml --substitutions="_IMAGE=$image" .
  }
  Write-Ok "image built and pushed"

  $envVars = "RECOMMENDATION_QUEUE_LOCATION=$Region,RECOMMENDATION_QUEUE_NAME=recommendation-tasks,GOOGLE_CLOUD_PROJECT=$Project"
  Invoke-Step "deploying Cloud Run service $ServiceName" {
    gcloud run deploy $ServiceName --image=$image --region=$Region --project=$Project `
      --no-allow-unauthenticated --set-env-vars=$envVars
  }
  Write-Ok "$ServiceName deployed"

  if (-not $DryRun) {
    $runUrl = gcloud run services describe $ServiceName --region=$Region --project=$Project --format="value(status.url)" 2>$null
    if ($runUrl) {
      Write-Ok "service URL: $runUrl"
      Write-Note "REASONER_WORKER_TASK_URL = $runUrl/tasks/dispatch"
    }
  }
}

# ---------------------------------------------------------------------------------------
# 5. IAM. The reasoner's service account is DISCOVERED from the deployed service rather
#    than assumed - Cloud Run defaults to the compute default SA unless told otherwise,
#    and guessing it here would grant Secret Manager access to the wrong identity.
# ---------------------------------------------------------------------------------------
if (Should-Run "iam") {
  Write-Step "5. IAM bindings"

  $syncSa = "sync-functions@$Project.iam.gserviceaccount.com"
  Invoke-Step "granting $syncSa roles/cloudtasks.enqueuer" {
    gcloud projects add-iam-policy-binding $Project --member="serviceAccount:$syncSa" --role="roles/cloudtasks.enqueuer" --condition=None
  }
  Write-Ok "sync-functions can enqueue Cloud Tasks"

  if ($DryRun) {
    Write-Note "[dry-run] would discover the reasoner service account and grant it secretAccessor + run.invoker"
  } else {
    $runSa = gcloud run services describe $ServiceName --region=$Region --project=$Project --format="value(spec.template.spec.serviceAccountName)" 2>$null
    if (-not $runSa) {
      $projectNumber = gcloud projects describe $Project --format="value(projectNumber)" 2>$null
      $runSa = "$projectNumber-compute@developer.gserviceaccount.com"
      Write-Warn "Service has no explicit service account; using the compute default: $runSa"
      Write-Warn "For least privilege, create a dedicated SA and redeploy with --service-account."
    }
    Write-Ok "reasoner service account: $runSa"

    Invoke-Step "granting $runSa access to anthropic-api-key" {
      gcloud secrets add-iam-policy-binding anthropic-api-key --project=$Project --member="serviceAccount:$runSa" --role="roles/secretmanager.secretAccessor"
    }
    Write-Ok "reasoner can read the Anthropic key"

    Invoke-Step "granting $runSa roles/run.invoker on $ServiceName" {
      gcloud run services add-iam-policy-binding $ServiceName --region=$Region --project=$Project --member="serviceAccount:$runSa" --role="roles/run.invoker"
    }
    Write-Ok "Cloud Tasks can invoke the worker"
  }
}

# ---------------------------------------------------------------------------------------
Write-Step "Done"
Write-Host @"
Deployed. NOTHING IS RUNNING YET - no sync has been triggered and no model call made.

Before you act on any recommendation:
  * Set your REAL targets. targetRoas (3.0) and targetCpaMinorUnits (150000 = INR 1500)
    are placeholders; the measured account CPA is INR 1761. Every ABOVE_TARGET /
    BELOW_TARGET verdict and every D5 guardrail hangs on these. They live in
    settings/{accountId}.statisticalThresholds - a Firestore write, not a redeploy.

Suggested first run, smallest to largest:
  1. Trigger ONE Meta entity sync and inspect syncRuns before anything else.
  2. Then a short insights window. B3's full backfill is the first costly operation.
  3. Then request a single recommendation and read it end to end.

Still NOT done, deliberately (both are outward-facing, not deployment):
  * Shopify webhook registration - makes your LIVE store start sending traffic, via a
    mutating call on a token that also holds 5 write_* scopes. See B6's notes.
  * Cloud Scheduler jobs - would start syncs on a timer.
Ask for those separately once the manual runs above look right.
"@ -ForegroundColor White
