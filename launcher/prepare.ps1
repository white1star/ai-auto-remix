# 首次双击「启动.bat」时若缺少运行时，会自动调用本脚本。
# 也可以单独双击「安装运行时.bat」手动执行，例如装坏了要重装。
#
# 做的事：把 Node 与 ffmpeg 下载到 ..\runtime，只取需要的 exe，其余丢掉。
# 全程不写注册表、不改系统 PATH，删掉整个文件夹即彻底清除。

param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Root = Split-Path -Parent $PSScriptRoot
$Rt   = Join-Path $Root 'runtime'
New-Item -ItemType Directory -Force -Path $Rt | Out-Null

$NodeVer  = 'v22.22.2'
$NodeZip  = "node-$NodeVer-win-x64.zip"
$NodeBase = "https://nodejs.org/dist/$NodeVer"
$FfUrl    = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ('remix-rt-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

function Say($msg)  { Write-Host "  $msg" }
function Good($msg) { Write-Host "  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }

function Fetch($url, $out){
  Say "下载 $url"
  $wc = New-Object Net.WebClient
  $wc.Headers.Add('User-Agent', 'Mozilla/5.0')
  $wc.DownloadFile($url, $out)
  $mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
  Say "  → $mb MB"
}

# 从 zip 里只取指定的几个文件，不整包解压
function Pluck($zipPath, $wantNames, $destDir){
  $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    foreach ($n in $wantNames){
      $entry = $zip.Entries | Where-Object { $_.Name -eq $n } | Select-Object -First 1
      if (-not $entry) { throw "压缩包里没有 $n" }
      $dest = Join-Path $destDir $n
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
    }
  } finally { $zip.Dispose() }
}

Write-Host ''
Write-Host ('─' * 58)
Write-Host '  准备运行时（只需一次，之后离线可用）'
Write-Host ('─' * 58)
Write-Host ''
Write-Host '  首次运行需要下载 Node 与 ffmpeg，约 150 MB。'
Write-Host '  网络慢的话请耐心等一会儿，中途不要关窗口。'
Write-Host ''

try {
  # ---------- Node ----------
  $nodeExe = Join-Path $Rt 'node.exe'
  if ($Force -or -not (Test-Path $nodeExe)) {
    $zip = Join-Path $Tmp 'node.zip'
    Fetch "$NodeBase/$NodeZip" $zip

    Say '校验 SHA256'
    $shas = Join-Path $Tmp 'SHASUMS256.txt'
    Fetch "$NodeBase/SHASUMS256.txt" $shas
    $line = Select-String -Path $shas -SimpleMatch $NodeZip | Select-Object -First 1
    if ($line) {
      $want = ($line.Line -split '\s+')[0].ToUpper()
      $got  = (Get-FileHash $zip -Algorithm SHA256).Hash.ToUpper()
      if ($want -ne $got) { throw "Node 安装包校验不通过（可能下载被截断），请重试" }
      Good '  校验通过'
    } else { Warn '  官方清单里没找到该版本，跳过校验' }

    Say '解出 node.exe'
    Pluck $zip @('node.exe') $Rt
    $v = & $nodeExe -v
    Good "  Node $v 就绪"
  } else { Good '  Node 已就绪' }

  # ---------- ffmpeg / ffprobe ----------
  $ffExe  = Join-Path $Rt 'ffmpeg.exe'
  $fpExe  = Join-Path $Rt 'ffprobe.exe'
  if ($Force -or -not (Test-Path $ffExe) -or -not (Test-Path $fpExe)) {
    $zip = Join-Path $Tmp 'ffmpeg.zip'
    Fetch $FfUrl $zip
    Say '解出 ffmpeg.exe / ffprobe.exe'
    Pluck $zip @('ffmpeg.exe', 'ffprobe.exe') $Rt
    $v = (& $ffExe -version 2>&1 | Select-Object -First 1)
    Good "  $v"
  } else { Good '  ffmpeg 已就绪' }

  # ---------- 配音 ----------
  $tts = Join-Path $Rt 'edge-tts\edge-tts.exe'
  if (Test-Path $tts) { Good '  配音组件已就绪' }
  else { Warn '  未发现配音组件（edge-tts），成片将只有字幕没有旁白' }

  Write-Host ''
  Write-Host ('─' * 58)
  Good '运行时准备完成'
  Write-Host ('─' * 58)
  Write-Host ''
} catch {
  Write-Host ''
  Write-Host ('─' * 58)
  Write-Host '  运行时准备失败' -ForegroundColor Red
  Write-Host ''
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
  Write-Host '  常见原因：没有联网、公司网络限制、代理未配置。'
  Write-Host '  可以让管理员把 runtime 目录整体拷到本目录后重试。'
  Write-Host ('─' * 58)
  exit 1
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
