<#
.SYNOPSIS
  글씨 교정 앱의 AI 조언 서버(server.py)를 Google Cloud Run에 배포합니다.

.DESCRIPTION
  처음 한 번 준비할 것
    1. gcloud auth login            (브라우저가 열리면 로그인)
    2. 프로젝트에 결제 계정 연결     (무료 사용량 안에서 써도 Cloud Run은 연결을 요구합니다)

  실행 (이 폴더에서)
    powershell -ExecutionPolicy Bypass -File .\deploy-cloudrun.ps1
    powershell -ExecutionPolicy Bypass -File .\deploy-cloudrun.ps1 -NewAccessCode    # 접속 코드를 새로 만들 때
    powershell -ExecutionPolicy Bypass -File .\deploy-cloudrun.ps1 -NewGeminiKey     # 앱 전용 Gemini 키를 새로 만들 때

  Gemini 키
    -GeminiProject로 정한 프로젝트(기본은 서버 프로젝트)에 앱 전용 키를 만들어(Gemini API만 쓰도록 제한)
    Secret Manager에 바로 넣습니다. 결제가 연결되지 않은 프로젝트를 정하면 Gemini 무료 등급으로 돌아갑니다.
      예) .\deploy-cloudrun.ps1 -GeminiProject <결제 없는 프로젝트ID> -NewGeminiKey
    키 값은 화면에 나오지 않습니다. 내 PC의 GEMINI_API_KEY(다른 도구와 같이 쓰는 키)는 쓰지 않으므로,
    앱의 사용량과 비용이 이 프로젝트에만 잡히고 한도도 이 프로젝트에만 걸 수 있습니다.

  하는 일
    API 켜기 -> Gemini 키와 접속 코드를 Secret Manager에 보관 -> 빌드와 배포
    -> 동작 확인 -> config.js에 서버 주소 기록
  config.js를 커밋하고 푸시해야 GitHub Pages의 앱에 AI 조언 버튼이 나옵니다.
#>
param(
  [string]$Project = '',
  [string]$Region = 'asia-northeast3',          # 서울
  [string]$Service = 'writing-coach-advice',
  [string]$GeminiProject = '',                  # Gemini 키를 만들 프로젝트(비우면 서버 프로젝트)
  [string]$AllowedOrigin = 'https://leeyunhome.github.io',
  [int]$DailyLimit = 100,                       # 서버가 세는 하루 횟수(서버가 다시 켜지면 초기화)
  [int]$GeminiPerDay = 100,                     # Google이 막는 하루 횟수(모델별, 이 프로젝트에만)
  [int]$GeminiPerMinute = 10,                   # Google이 막는 분당 횟수(이 프로젝트에만)
  [int]$PerIpDailyLimit = 30,
  [int]$MinIntervalSeconds = 15,
  [switch]$NewAccessCode,
  [switch]$NewGeminiKey
)

# Windows PowerShell 5.1에서 'Stop'으로 두면 gcloud가 진행 상황을 stderr에 쓸 때도 멈추므로,
# 오류는 종료 코드로 직접 확인합니다.
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot

$GeminiSecret = 'writing-coach-gemini-key'
$CodeSecret = 'writing-coach-access-code'

function Fail([string]$message) {
  Write-Host "실패: $message" -ForegroundColor Red
  exit 1
}

function Invoke-Gcloud {
  # gcloud를 실행하고 실패하면 멈춥니다. 표준 출력을 돌려줍니다.
  $output = & gcloud @args
  if ($LASTEXITCODE -ne 0) { Fail "gcloud $($args -join ' ')" }
  return $output
}

function Test-Secret([string]$name) {
  & gcloud secrets describe $name --project $Project --format='value(name)' 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Set-Secret([string]$name, [string]$value) {
  # 값을 명령줄에 드러내지 않도록 임시 파일로 넘기고 바로 지웁니다. 줄바꿈 없이 그대로 씁니다.
  $exists = Test-Secret $name
  if ($exists) {
    $current = (& gcloud secrets versions access latest --secret $name --project $Project 2>$null) -join "`n"
    if ($LASTEXITCODE -eq 0 -and $current -eq $value) { return }
  }
  $tmp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($tmp, $value)
    if ($exists) {
      Invoke-Gcloud secrets versions add $name --project $Project --data-file $tmp | Out-Null
    } else {
      Invoke-Gcloud secrets create $name --project $Project --replication-policy automatic --data-file $tmp | Out-Null
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

# ---------- 0. 준비 상태 확인 ----------
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { Fail 'gcloud가 없습니다. Google Cloud SDK를 설치해 주세요.' }

$account = (& gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>$null)
if (-not $account) { Fail '로그인이 필요합니다. 먼저 gcloud auth login 을 실행해 주세요.' }
& gcloud auth print-access-token 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "로그인이 만료됐습니다($account). gcloud auth login 을 다시 실행해 주세요." }

if (-not $Project) { $Project = (& gcloud config get-value project 2>$null) }
if (-not $Project) { Fail '프로젝트가 정해져 있지 않습니다. -Project <프로젝트ID> 로 지정해 주세요.' }
if (-not $GeminiProject) { $GeminiProject = $Project }
Write-Host "계정: $account | 프로젝트: $Project | Gemini 키 프로젝트: $GeminiProject | 지역: $Region | 서비스: $Service"

$billing = (& gcloud billing projects describe $Project --format='value(billingEnabled)' 2>$null)
if ($billing -eq 'False') {
  Fail "프로젝트 $Project 에 결제 계정이 연결돼 있지 않습니다. https://console.cloud.google.com/billing/linkedaccount?project=$Project 에서 연결해 주세요."
} elseif ($billing -ne 'True') {
  Write-Host '주의: 결제 계정 연결 여부를 확인하지 못했습니다. 배포 중 결제 관련 오류가 나면 연결해 주세요.' -ForegroundColor Yellow
}

# ---------- 1. 필요한 API 켜기 ----------
Write-Host '1/5 필요한 Google Cloud API를 켭니다...'
Invoke-Gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com `
  --project $Project | Out-Null
Invoke-Gcloud services enable generativelanguage.googleapis.com apikeys.googleapis.com --project $GeminiProject | Out-Null

# ---------- 2. 비밀 값 보관 ----------
Write-Host '2/5 Gemini 키와 접속 코드를 Secret Manager에 보관합니다...'
if ($NewGeminiKey -or -not (Test-Secret $GeminiSecret)) {
  # 앱 전용 키: Gemini API만 부를 수 있게 제한합니다. 키 값은 변수에만 담고 출력하지 않습니다.
  # 이 명령은 키 값이 든 결과 전체를 stderr에도 출력하므로 stderr를 버립니다(키가 화면에 남지 않게).
  $keyString = ((& gcloud services api-keys create --project $GeminiProject `
    --display-name 'writing-coach advice server' `
    --api-target=service=generativelanguage.googleapis.com `
    --format='value(response.keyString)' 2>$null) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $keyString) { Fail '앱 전용 Gemini 키를 만들지 못했습니다(키 출력을 숨기려고 gcloud 오류 내용도 숨겼습니다).' }
  Set-Secret $GeminiSecret $keyString
  $keyString = $null
  Write-Host '    앱 전용 Gemini 키를 새로 만들어 보관했습니다.'
}

$accessCode = $null
if ($NewAccessCode -or -not (Test-Secret $CodeSecret)) {
  # 헷갈리는 글자(0과 O, 1과 I)를 뺀 32글자 중 10자리.
  # 256이 32로 나누어떨어지므로 글자마다 뽑힐 확률이 같습니다.
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  $bytes = New-Object byte[] 10
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $accessCode = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
  Set-Secret $CodeSecret $accessCode
  # 뒤 단계에서 실패해도 코드를 잃지 않도록 만든 즉시 보여 줍니다.
  Write-Host "    새 접속 코드: $accessCode (이 화면에서만 보입니다)" -ForegroundColor Green
}

$projectNumber = (Invoke-Gcloud projects describe $Project --format='value(projectNumber)')
$runtimeAccount = "$projectNumber-compute@developer.gserviceaccount.com"
foreach ($secret in @($GeminiSecret, $CodeSecret)) {
  Invoke-Gcloud secrets add-iam-policy-binding $secret --project $Project `
    --member "serviceAccount:$runtimeAccount" --role roles/secretmanager.secretAccessor --quiet | Out-Null
}
# 새로 만든 프로젝트는 소스 빌드에 쓰는 기본 계정에 권한이 없어 빌드가 거절됩니다.
# Cloud Run 문서가 안내하는 빌더 역할을 줍니다(이미 있으면 그대로).
Invoke-Gcloud projects add-iam-policy-binding $Project `
  --member "serviceAccount:$runtimeAccount" --role roles/run.builder --condition None --quiet | Out-Null

# Google 쪽 사용량 한도. 서버의 횟수 제한과 달리 서버가 다시 켜져도 초기화되지 않는 실제 상한입니다.
$token = ((& gcloud auth print-access-token 2>$null) | Out-String).Trim()
$quotaHeaders = @{ Authorization = "Bearer $token"; 'X-Goog-User-Project' = $Project }
$geminiProjectNumber = (Invoke-Gcloud projects describe $GeminiProject --format='value(projectNumber)')
$quotaBase = "https://serviceusage.googleapis.com/v1beta1/projects/$geminiProjectNumber/services/generativelanguage.googleapis.com/consumerQuotaMetrics"

function Set-QuotaOverride([string]$limitPath, [int]$value) {
  $uri = "$quotaBase/$limitPath/consumerOverrides"
  $body = @{ overrideValue = "$value" } | ConvertTo-Json
  try {
    $existing = (Invoke-RestMethod -Uri $uri -Headers $quotaHeaders).overrides
    if ($existing) {
      $target = "https://serviceusage.googleapis.com/v1beta1/$($existing[0].name)"
      Invoke-RestMethod -Method Patch -Uri "${target}?force=true&updateMask=overrideValue" -Headers $quotaHeaders -ContentType 'application/json' -Body $body | Out-Null
    } else {
      Invoke-RestMethod -Method Post -Uri "${uri}?force=true" -Headers $quotaHeaders -ContentType 'application/json' -Body $body | Out-Null
    }
  } catch {
    Fail "Gemini 사용량 한도를 걸지 못했습니다: $($_.Exception.Message)"
  }
}

$geminiBilling = (& gcloud billing projects describe $GeminiProject --format='value(billingEnabled)' 2>$null)
if ($geminiBilling -eq 'True') {
  Write-Host "    Gemini 사용량 한도: 하루 ${GeminiPerDay}회(모델별), 분당 ${GeminiPerMinute}회"
  Set-QuotaOverride 'generativelanguage.googleapis.com%2Fgenerate_requests_per_model_per_day/limits/%2Fd%2Fmodel%2Fproject' $GeminiPerDay
  Set-QuotaOverride 'generativelanguage.googleapis.com%2Fgenerate_content_requests/limits/%2Fmin%2Fproject%2Fregion' $GeminiPerMinute
} else {
  Write-Host "    Gemini 키 프로젝트에 결제가 없어 무료 등급으로 돌아갑니다(요금 없음, Google의 무료 한도 적용)."
}

# ---------- 3. 빌드와 배포 ----------
Write-Host '3/5 빌드하고 배포합니다(처음에는 3~5분 걸립니다)...'
# 사용량 제한을 서버 메모리에서 세므로 인스턴스는 1개로 묶습니다.
$envVars = "API_ONLY=1,ALLOWED_ORIGINS=$AllowedOrigin,DAILY_LIMIT=$DailyLimit,PER_IP_DAILY_LIMIT=$PerIpDailyLimit,MIN_INTERVAL_SECONDS=$MinIntervalSeconds"
Invoke-Gcloud run deploy $Service --project $Project --region $Region --source . `
  --allow-unauthenticated --max-instances 1 --min-instances 0 --concurrency 10 `
  --memory 512Mi --cpu 1 --timeout 120 `
  --set-secrets "GEMINI_API_KEY=${GeminiSecret}:latest,ACCESS_CODE=${CodeSecret}:latest" `
  --set-env-vars $envVars --quiet | Out-Null

$url = ((Invoke-Gcloud run services describe $Service --project $Project --region $Region --format='value(status.url)') | Out-String).Trim()
if (-not $url) { Fail '배포한 서버 주소를 읽지 못했습니다.' }

# ---------- 4. 동작 확인 ----------
Write-Host "4/5 서버가 답하는지 확인합니다: $url/api/advice"
try {
  $status = Invoke-RestMethod -Uri "$url/api/advice" -TimeoutSec 60
} catch {
  Fail "서버가 답하지 않습니다: $($_.Exception.Message)"
}
if (-not $status.available) { Fail '서버는 떴지만 Gemini 키를 읽지 못했습니다(available=false).' }
Write-Host "    available=$($status.available), needsCode=$($status.needsCode)"

# ---------- 5. 앱 설정에 주소 기록 ----------
Write-Host '5/5 config.js에 서버 주소를 기록합니다...'
$configPath = Join-Path $PSScriptRoot 'config.js'
$config = [IO.File]::ReadAllText($configPath)
$config = [regex]::Replace($config, "adviceApi:\s*'[^']*'", "adviceApi: '$url'")
[IO.File]::WriteAllText($configPath, $config)

Write-Host ''
Write-Host "배포 완료: $url" -ForegroundColor Green
if ($accessCode) {
  Write-Host "접속 코드: $accessCode" -ForegroundColor Green
  Write-Host '  이 코드는 다시 표시되지 않습니다. 함께 테스트할 사람에게만 알려 주세요.'
} else {
  Write-Host "접속 코드는 그대로입니다. 확인: gcloud secrets versions access latest --secret $CodeSecret --project $Project"
}
Write-Host '다음 할 일: config.js를 커밋하고 푸시하면 GitHub Pages의 앱에 AI 조언 버튼이 나옵니다.'
