@echo off
echo.
echo Counting project source lines...
powershell -NoProfile -ExecutionPolicy Bypass "$env:CLB_ROOT='%~dp0'; $m='::PS'+'CODE::'; $c=(Get-Content -Raw -LiteralPath '%~f0') -split $m; Invoke-Expression $c[1]"
echo.
pause
exit /b 0

::PSCODE::
$ErrorActionPreference = 'Stop'
$root = $env:CLB_ROOT
$rootLen = $root.TrimEnd('\', '/').Length + 1

$exts = '.py', '.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.html'
$exclDirs = 'node_modules', 'dist', 'build', '.venv', 'venv', 'env',
            '__pycache__', '.git', 'coverage', '.vite', '.pytest_cache',
            'htmlcov', 'data', 'tmp', '.mypy_cache', '.idea', '.vscode'
$exclSet = @{}
foreach ($d in $exclDirs) { $exclSet[$d.ToLower()] = $true }

# Test folders are kept in the walk and tagged, so the report can show both
# production-only and tests-included totals from a single pass.
$testDirs = @{}
foreach ($d in 'tests', 'test', '__tests__') { $testDirs[$d] = $true }

# Stack-based walk so excluded folders are pruned (never descended into).
$files = New-Object System.Collections.Generic.List[System.IO.FileInfo]
$stack = New-Object System.Collections.Generic.Stack[string]
$stack.Push($root)
while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    try { $children = Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop } catch { continue }
    foreach ($c in $children) {
        if ($c.PSIsContainer) {
            if (-not $exclSet.ContainsKey($c.Name.ToLower())) { $stack.Push($c.FullName) }
        }
        elseif ($exts -contains $c.Extension.ToLower()) {
            $files.Add($c)
        }
    }
}

$records = foreach ($f in $files) {
    $rel = $f.FullName.Substring($rootLen)
    $segs = $rel -split '[\\/]'
    $n = $f.Name.ToLower()
    $isTest = $false
    foreach ($s in $segs) { if ($testDirs.ContainsKey($s.ToLower())) { $isTest = $true; break } }
    if (-not $isTest -and ($n -like '*.test.*' -or $n -like '*.spec.*' -or
            $n -like 'test_*' -or $n -like '*_test.py' -or $n -eq 'conftest.py')) {
        $isTest = $true
    }
    $content = @(Get-Content -LiteralPath $f.FullName -ErrorAction SilentlyContinue)
    $lc = ($content | Measure-Object -Line).Lines
    # Generated bundles (esbuild *-core.user.js) carry an AUTO-GENERATED banner
    # on line 1 -- counting them double-counts their src/ modules, so tag here
    # and split them out of the production total below.
    $isGen = ($content.Count -gt 0 -and $content[0] -match 'AUTO-GENERATED')
    [pscustomobject]@{ Ext = $f.Extension.ToLower(); Top = $segs[0]; Lines = [int]$lc; IsTest = $isTest; IsGenerated = $isGen }
}

if (-not $records) { Write-Host 'No source files found.'; return }

$gen  = @($records | Where-Object { $_.IsGenerated })
$prod = @($records | Where-Object { -not $_.IsTest -and -not $_.IsGenerated })
$test = @($records | Where-Object { $_.IsTest -and -not $_.IsGenerated })
$prodLines = ($prod | Measure-Object -Property Lines -Sum).Sum
$testLines = ($test | Measure-Object -Property Lines -Sum).Sum
$genLines  = ($gen  | Measure-Object -Property Lines -Sum).Sum
if (-not $prodLines) { $prodLines = 0 }
if (-not $testLines) { $testLines = 0 }
if (-not $genLines)  { $genLines  = 0 }
$fmt = '  {0,-18}{1,8}{2,12}'

Write-Host ''
Write-Host 'Production code by extension (tests excluded):'
Write-Host ($fmt -f 'EXT', 'FILES', 'LINES')
Write-Host ('  ' + ('-' * 38))
foreach ($g in ($prod | Group-Object Ext | Sort-Object Name)) {
    Write-Host ($fmt -f $g.Name, $g.Count, (($g.Group | Measure-Object -Property Lines -Sum).Sum))
}

Write-Host ''
Write-Host 'Production code by top-level folder:'
Write-Host ($fmt -f 'FOLDER', 'FILES', 'LINES')
Write-Host ('  ' + ('-' * 38))
foreach ($g in ($prod | Group-Object Top |
        Sort-Object @{ Expression = { ($_.Group | Measure-Object -Property Lines -Sum).Sum }; Descending = $true })) {
    Write-Host ($fmt -f $g.Name, $g.Count, (($g.Group | Measure-Object -Property Lines -Sum).Sum))
}

Write-Host ''
Write-Host 'Summary:'
Write-Host ($fmt -f 'CATEGORY', 'FILES', 'LINES')
Write-Host ('  ' + ('-' * 38))
Write-Host ($fmt -f 'Production code', $prod.Count, $prodLines)
Write-Host ($fmt -f 'Tests', $test.Count, $testLines)
Write-Host ('  ' + ('-' * 38))
Write-Host ($fmt -f 'GRAND TOTAL', ($prod.Count + $test.Count), ($prodLines + $testLines))
Write-Host ''
Write-Host ($fmt -f 'Generated (excl.)', $gen.Count, $genLines)
Write-Host '  (esbuild core bundles -- already counted as their src/ modules)'
Write-Host ''
