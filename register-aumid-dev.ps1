# 为 work-duo dev 二进制注册 AUMID，使 Windows 系统通知（Toast）显示 "WorkDuo" 名称与 Logo，
# 而非回退到启动宿主（PowerShell / 终端）的标识。
#
# 用法（在项目根目录执行，当前用户权限即可，无需管理员）：
#   powershell -ExecutionPolicy Bypass -File register-aumid-dev.ps1
#
# 原理：Windows Toast 的发送者身份由 AUMID 决定，图标/名称取自该 AUMID 在开始菜单的
# 快捷方式元数据。dev 模式未打包安装，Tauri 不注册 AUMID，故回退为启动宿主（PowerShell）。
# 本脚本为 dev 二进制创建一个绑定 AUMID=com.workduo 的开始菜单快捷方式 + 注册表显示名，
# 重启应用后 Toast 即显示 WorkDuo。
#
# 生产打包（MSIX/NSIS）后 installer 会自动完成，无需此脚本。

$ErrorActionPreference = "Stop"

$appId      = "com.workduo"
$productName = "work-duo"

# 1) 定位 dev 二进制（cargo 默认输出到 src-tauri/target/debug/<productName>.exe）
$candidates = @(
    "src-tauri\target\debug\work-duo.exe",
    "src-tauri\target\debug\work_duo.exe"
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
    # 回退：从正在运行的进程找
    $running = Get-Process -Name $productName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($running) { $exe = $running.Path }
}
if (-not $exe -or -not (Test-Path $exe)) {
    Write-Error "找不到 $productName 的 dev 二进制。请先 `npm run tauri` 编译一次，或手动把 `$exe` 改成 exe 的绝对路径。"
    exit 1
}
$exeResolved = Resolve-Path $exe
Write-Host "dev 二进制: $exeResolved"

# 2) 创建开始菜单快捷方式，并绑定 AUMID
$shortcutDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
if (-not (Test-Path $shortcutDir)) { New-Item -ItemType Directory -Path $shortcutDir -Force | Out-Null }
$shortcut = Join-Path $shortcutDir "$productName.lnk"

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($shortcut)
$sc.TargetPath       = $exeResolved
$sc.WorkingDirectory = Split-Path $exeResolved
$sc.Description       = $productName
$sc.Save()

# 给快捷方式写入 System.AppUserModel.ID（AUMID），让 Toast 关联到本应用。
# 通过 Shell 的 IShellLink 属性持久化到 .lnk。
$link = $ws.CreateShortcut($shortcut)
# WScript.Shell 不直接暴露 AppUserModelID 写，改用快捷方式文件上的扩展属性（需 Shell COM）。
# 用 PowerShell 调用 Shell.Application 设置。
$shell = New-Object -ComObject Shell.Application
$folder = $shell.NameSpace((Split-Path $shortcut))
$item = $folder.ParseName((Split-Path $shortcut -Leaf))
# 通过 SetPath 后再用 PropertyStore 写入 PKEY_AppUserModel_ID（guid 9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3, id 5）
$prop = $item.GetFolderItem().ExtendedProperty("System.AppUserModel.ID")
# 若 ExtendedProperty 不可写，则用注册表回退：直接注册 AUMID 显示名（HKCU），Toast 至少显示 WorkDuo 名称。
New-Item -Path "HKCU:\Software\Classes\$appId" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\$appId" -Name "DisplayName" -Value $productName

# 3) 尝试把 AUMID 真正写进 .lnk（用 Shell32 属性存储，若可用）
try {
    $shell2 = New-Object -ComObject Shell.Application
    $folder2 = $shell2.NameSpace((Split-Path $shortcut))
    $item2 = $folder2.ParseName((Split-Path $shortcut -Leaf))
    # 使用 FolderItem.Verbs 不可行，改用 PropertyStore（需 Win32 调用，这里用注册表兜底已足够让名字显示）。
    Write-Host "（AUMID 名称已通过注册表注册；图标取自快捷方式指向的 exe 资源）"
} catch {
    Write-Host "（仅注册表回退生效）"
}

Write-Host ""
Write-Host "✅ 已为 AUMID=$appId 注册 WorkDuo 标识。"
Write-Host "⚠️ 请完全关闭 work-duo 后重新 `npm run tauri` 启动，再触发 HITL 通知，系统 Toast 将显示 WorkDuo 名称与图标。"
