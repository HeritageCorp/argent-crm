param(
  [string]$ApiKey = $env:FREELLMAPI_API_KEY,
  [string]$BaseUrl = $(if ($env:FREELLMAPI_BASE_URL) { $env:FREELLMAPI_BASE_URL } else { 'http://127.0.0.1:3002/v1' }),
  [string]$Model = $(if ($env:FREELLMAPI_MODEL) { $env:FREELLMAPI_MODEL } else { 'auto' })
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  $ApiKey = Read-Host 'Clé unifiée FreeLLMAPI (freellmapi-...)'
}
if ([string]::IsNullOrWhiteSpace($ApiKey)) { throw 'Une clé FreeLLMAPI est nécessaire.' }

$configDir = Join-Path $env:USERPROFILE '.copilot'
$configPath = Join-Path $configDir 'providers.json'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

if (Test-Path -LiteralPath $configPath) {
  $raw = Get-Content -LiteralPath $configPath -Raw
  $config = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { [pscustomobject]@{} }
} else {
  $config = [pscustomobject]@{}
}

if (-not ($config.PSObject.Properties.Name -contains 'providers')) { $config | Add-Member -NotePropertyName providers -NotePropertyValue @() }
if (-not ($config.PSObject.Properties.Name -contains 'models')) { $config | Add-Member -NotePropertyName models -NotePropertyValue @() }

$providers = @($config.providers | Where-Object { $_.name -ne 'freellmapi' })
$providers += [pscustomobject]@{ name = 'freellmapi'; type = 'openai'; baseUrl = $BaseUrl.TrimEnd('/'); apiKey = $ApiKey }
$models = @($config.models | Where-Object { $_.provider -ne 'freellmapi' })
$models += [pscustomobject]@{ id = $Model; provider = 'freellmapi'; wireModel = $Model; maxPromptTokens = 32000; maxOutputTokens = 4096 }

$out = [pscustomobject]@{ providers = $providers; models = $models }
$out | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8
Write-Host "FreeLLMAPI ajouté à GitHub Copilot CLI : $configPath"
Write-Host "Redémarre Copilot CLI puis utilise /model pour sélectionner freellmapi/auto."
