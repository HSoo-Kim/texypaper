param(
  [Parameter(Mandatory=$true)][ValidateSet('probe','windows','close','open','exit','double-click','capture')][string]$Action,
  [int]$AppPid=0,
  [string]$Evidence='',
  [switch]$Headed
)
$ErrorActionPreference='Stop'
$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
if (-not $Headed -and $Action -notin @('windows','close')) {
  throw 'HEADED_PERMISSION_REQUIRED: this action can raise desktop surfaces or move physical input. Explicit user permission and -Headed are required.'
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class TraySmokeNative {
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 public sealed class Window { public long Handle; public uint Pid; public string Title; public string Class; public bool Visible; public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
 public static Window[] Windows(uint owner) {
  var found=new List<Window>(); EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);
   if(owner==0||owner==pid){var title=new StringBuilder(1024);var cls=new StringBuilder(256);GetWindowText(h,title,1024);GetClassName(h,cls,256);Rect r;GetWindowRect(h,out r);
    found.Add(new Window{Handle=h.ToInt64(),Pid=pid,Title=title.ToString(),Class=cls.ToString(),Visible=IsWindowVisible(h),Left=r.Left,Top=r.Top,Right=r.Right,Bottom=r.Bottom});}return true;},IntPtr.Zero);return found.ToArray();
 }
 public static uint Owner(IntPtr h){uint pid;GetWindowThreadProcessId(h,out pid);return pid;}
 public static void Click(int x,int y,bool right,bool twice) {
  if(!SetCursorPos(x,y))throw new Exception("Could not position native cursor");
  mouse_event(right?0x0008u:0x0002u,0,0,0,UIntPtr.Zero);mouse_event(right?0x0010u:0x0004u,0,0,0,UIntPtr.Zero);
  if(twice){System.Threading.Thread.Sleep(70);mouse_event(0x0002,0,0,0,UIntPtr.Zero);mouse_event(0x0004,0,0,0,UIntPtr.Zero);}
 }
}
'@
[void][TraySmokeNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
$A=[System.Windows.Automation.AutomationElement]
$T=[System.Windows.Automation.TreeScope]
$C=[System.Windows.Automation.ControlType]
$record=[ordered]@{action=$Action;pid=$AppPid;at=[datetime]::UtcNow.ToString('o');method='Native Explorer UI Automation discovery and Win32 physical notification-area input'}
$cursor=New-Object TraySmokeNative+Point
[void][TraySmokeNative]::GetCursorPos([ref]$cursor)
$chevron=$null
$openedOverflow=$false
function Capture-Rect($rect,[string]$target) {
 if(-not $target){return}
 $x=[int][Math]::Floor($rect.Left);$y=[int][Math]::Floor($rect.Top)
 $width=[int][Math]::Ceiling($rect.Right)-$x;$height=[int][Math]::Ceiling($rect.Bottom)-$y
 if($width -le 0 -or $height -le 0 -or $width -gt 12000 -or $height -gt 12000){throw 'NATIVE_CAPTURE_UNAVAILABLE: invalid native evidence rectangle.'}
 $bitmap=[System.Drawing.Bitmap]::new($width,$height);$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
 try{$graphics.CopyFromScreen($x,$y,0,0,[System.Drawing.Size]::new($width,$height));$bitmap.Save($target,[System.Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}
}
function Shell-Roots {
 $roots=@()
 foreach($window in [TraySmokeNative]::Windows(0)) {
  if($window.Visible -and $window.Class -in @('Shell_TrayWnd','Shell_SecondaryTrayWnd','NotifyIconOverflowWindow','TopLevelWindowForOverflowXamlIsland')) {
   $process=Get-Process -Id $window.Pid -ErrorAction Stop
   if($process.ProcessName -ne 'explorer'){throw 'TRAY_OWNERSHIP_MISMATCH: notification area is not owned by Explorer.'}
   $roots+=$A::FromHandle([IntPtr]$window.Handle)
  }
 }
 if($roots.Count -eq 0){throw 'NATIVE_NOTIFICATION_AREA_UNAVAILABLE: no visible Explorer notification-area root. Use an unlocked interactive Windows desktop; no OS settings were changed.'}
 return $roots
}
function Find-Icons {
 $found=@();$seen=@{}
 $condition=[System.Windows.Automation.PropertyCondition]::new($A::NameProperty,'TexyPaper')
 foreach($root in (Shell-Roots)) {
  foreach($element in $root.FindAll($T::Descendants,$condition)) {
   if($element.Current.IsOffscreen){continue}
   $rect=$element.Current.BoundingRectangle
   if($rect.Width -le 0 -or $rect.Height -le 0){continue}
   # Nested providers can expose the same icon twice; deduplicate actual screen bounds.
   $key="$($rect.Left),$($rect.Top),$($rect.Width),$($rect.Height)"
   if(-not $seen.ContainsKey($key)){$seen[$key]=$true;$found+=,$element}
  }
 }
 return $found
}
function Ensure-Overflow {
 $visible=@([TraySmokeNative]::Windows(0)|Where-Object {$_.Visible -and $_.Class -in @('NotifyIconOverflowWindow','TopLevelWindowForOverflowXamlIsland')})
 if($visible.Count){return}
 $condition=[System.Windows.Automation.PropertyCondition]::new($A::ControlTypeProperty,$C::Button)
 $candidates=@()
 foreach($root in (Shell-Roots)) {
  foreach($button in $root.FindAll($T::Descendants,$condition)) {
   if(-not $button.Current.IsOffscreen -and $button.Current.Name -match '^(Show hidden icons|Hidden icons|Hidden icon menu|Notification Chevron|숨겨진 아이콘 표시|숨겨진 아이콘|숨겨진 아이콘 메뉴)$'){$candidates+=,$button}
  }
 }
 if($candidates.Count -gt 1){throw 'TRAY_OVERFLOW_AMBIGUOUS: multiple Explorer overflow controls; no arbitrary shell target was clicked.'}
 if($candidates.Count -eq 0){return}
 $script:chevron=$candidates[0]
 $pattern=$null
 if(-not $script:chevron.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){throw 'TRAY_OVERFLOW_UNAVAILABLE: Explorer chevron has no InvokePattern. No taskbar settings were changed.'}
 $pattern.Invoke();$script:openedOverflow=$true
 $deadline=[datetime]::UtcNow.AddSeconds(5)
 do {
  $visible=@([TraySmokeNative]::Windows(0)|Where-Object {$_.Visible -and $_.Class -in @('NotifyIconOverflowWindow','TopLevelWindowForOverflowXamlIsland')})
  if($visible.Count){return};Start-Sleep -Milliseconds 100
 } while([datetime]::UtcNow -lt $deadline)
 throw 'TRAY_OVERFLOW_UNAVAILABLE: Explorer did not expose its overflow window. No taskbar settings were changed.'
}
function Owned-Windows {
 return @([TraySmokeNative]::Windows([uint32]$AppPid)|Where-Object {$_.Title -in @('TexyPaper','TexyPaper — AI')})
}
try {
 if($Action -ne 'probe') {
  if($AppPid -le 0){throw 'Exact owned application PID required.'}
  $ownedProcess=Get-Process -Id $AppPid -ErrorAction SilentlyContinue
  if(-not $ownedProcess){throw 'OWNED_APP_EXITED: launched application process no longer exists.'}
  $record.process=@{pid=$AppPid;startedAt=$ownedProcess.StartTime.ToUniversalTime().ToString('o');path=$ownedProcess.Path}
  $record.trayOwnerWindows=@([TraySmokeNative]::Windows([uint32]$AppPid)|Where-Object {$_.Class -eq 'tray_icon_app'})
  if($Action -in @('open','exit','double-click') -and $record.trayOwnerWindows.Count -ne 1){throw 'TRAY_OWNERSHIP_MISMATCH: expected one tray-icon owner HWND in the exact launched application process.'}
 }
 if($Action -eq 'windows'){$record.windows=@(Owned-Windows)}
 elseif($Action -eq 'close') {
  $windows=@(Owned-Windows|Where-Object {$_.Title -eq 'TexyPaper'})
  if($windows.Count -ne 1){throw 'Expected exactly one owned main window for WM_CLOSE.'}
  if(-not [TraySmokeNative]::PostMessage([IntPtr]$windows[0].Handle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Owned native WM_CLOSE could not be posted.'}
  $record.target=$windows[0];$record.message='WM_CLOSE (0x0010)'
 }
 elseif($Action -eq 'capture') {
  $windows=@(Owned-Windows|Where-Object {$_.Title -eq 'TexyPaper' -and $_.Visible})
  if($windows.Count -ne 1){throw 'Expected exactly one visible owned main window for capture.'}
  [void][TraySmokeNative]::SetForegroundWindow([IntPtr]$windows[0].Handle)
  Start-Sleep -Milliseconds 180
  if([TraySmokeNative]::Owner([TraySmokeNative]::GetForegroundWindow()) -ne $AppPid){throw 'NATIVE_CAPTURE_OCCLUDED: owned main could not be foregrounded; refusing a screenshot of another application.'}
  Capture-Rect $windows[0] $Evidence;$record.windows=$windows
 }
 else {
  # Always inspect overflow too: a second same-tooltip TexyPaper must never be guessed.
  Ensure-Overflow
  $icons=@(Find-Icons)
  $record.iconCount=$icons.Count
  if($Action -ne 'probe' -and $icons.Count -ne 1){throw "TRAY_ICON_UNAVAILABLE_OR_AMBIGUOUS: found $($icons.Count) visible TexyPaper icons across notification areas. No unrelated icon was clicked."}
  if($icons.Count -eq 1){
   $icon=$icons[0];$r=$icon.Current.BoundingRectangle
   $record.icon=@{tooltip=$icon.Current.Name;processId=$icon.Current.ProcessId;automationId=$icon.Current.AutomationId;bounds=@{left=$r.Left;top=$r.Top;right=$r.Right;bottom=$r.Bottom}}
   if($Action -eq 'probe'){Capture-Rect $r $Evidence}
   else {
    $point=New-Object TraySmokeNative+Point;$point.X=[int]($r.Left+$r.Width/2);$point.Y=[int]($r.Top+$r.Height/2)
    $hit=[TraySmokeNative]::WindowFromPoint($point);$hitPid=[TraySmokeNative]::Owner($hit)
    if((Get-Process -Id $hitPid -ErrorAction Stop).ProcessName -ne 'explorer'){throw 'TRAY_ICON_OCCLUDED: exact native icon point is not owned by Explorer; refusing physical input.'}
    Capture-Rect $r $(if($Evidence){[IO.Path]::ChangeExtension($Evidence,'.icon.png')}else{''})
    [TraySmokeNative]::Click($point.X,$point.Y,($Action -ne 'double-click'),($Action -eq 'double-click'))
    if($Action -ne 'double-click') {
     $deadline=[datetime]::UtcNow.AddSeconds(10);$menu=$null
     do {
      $menus=@([TraySmokeNative]::Windows([uint32]$AppPid)|Where-Object {$_.Visible -and $_.Class -eq '#32768'})
      if($menus.Count -gt 1){throw 'TRAY_MENU_AMBIGUOUS: multiple owned native popup menus.'}
      if($menus.Count -eq 1){$menu=$menus[0];break};Start-Sleep -Milliseconds 100
     } while([datetime]::UtcNow -lt $deadline)
     if(-not $menu){throw 'TRAY_MENU_UNAVAILABLE: icon right-click did not expose an application-owned native popup menu. Input was not repeated.'}
     $element=$A::FromHandle([IntPtr]$menu.Handle)
     $items=$element.FindAll($T::Descendants,[System.Windows.Automation.PropertyCondition]::new($A::ControlTypeProperty,$C::MenuItem))
     $labels=@($items|ForEach-Object {$_.Current.Name.Replace('&','')})
     $expected=$(if($Action -eq 'open'){@('Open TexyPaper','TexyPaper 열기')}else{@('Exit TexyPaper','TexyPaper 종료')})
     $matches=@($items|Where-Object {$_.Current.Name.Replace('&','') -in $expected})
     if($matches.Count -ne 1){throw "TRAY_MENU_UNAVAILABLE: exact $Action item missing from owned native menu."}
     $record.menu=@{handle=$menu.Handle;pid=$menu.Pid;labels=$labels;selected=$matches[0].Current.Name}
     Capture-Rect $menu $Evidence
     $invoke=$null
     if($matches[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)){$invoke.Invoke();$record.selectionMethod='Native menu UIA InvokePattern'}
     else {
      $item=$matches[0].Current.BoundingRectangle;$p=New-Object TraySmokeNative+Point;$p.X=[int]($item.Left+$item.Width/2);$p.Y=[int]($item.Top+$item.Height/2)
      if($item.Width -le 0 -or $item.Height -le 0 -or [TraySmokeNative]::Owner([TraySmokeNative]::WindowFromPoint($p)) -ne $AppPid){throw 'TRAY_MENU_OCCLUDED: refusing input outside the owned native menu.'}
      [TraySmokeNative]::Click($p.X,$p.Y,$false,$false);$record.selectionMethod='UIA-discovered owned native menu Win32 mouse input'
     }
    }
   }
  }
 }
 $record.passed=$true
 if($Evidence){$record.evidence=$Evidence}
 $record|ConvertTo-Json -Depth 8 -Compress
}
catch {
 $record.passed=$false;$record.error=$_.Exception.Message
 if($Evidence){$record|ConvertTo-Json -Depth 8|Set-Content -LiteralPath ([IO.Path]::ChangeExtension($Evidence,'.error.json')) -Encoding UTF8}
 [Console]::Error.WriteLine(($record|ConvertTo-Json -Depth 8 -Compress));exit 1
}
finally {
 # Restore only shell chrome this helper opened; never change taskbar preferences.
 if($openedOverflow -and $chevron){
  $visible=@([TraySmokeNative]::Windows(0)|Where-Object {$_.Visible -and $_.Class -in @('NotifyIconOverflowWindow','TopLevelWindowForOverflowXamlIsland')})
  if($visible.Count){try{$pattern=$null;if($chevron.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke()}}catch{}}
 }
 if($Headed){[void][TraySmokeNative]::SetCursorPos($cursor.X,$cursor.Y)}
}
