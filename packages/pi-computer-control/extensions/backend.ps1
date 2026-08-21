# pi-computer-control backend (Windows)
# Persistent JSON-RPC host over stdio: one JSON object per line.
# Node side sends {"id":N,"method":"...","params":{...}} and reads
# {"id":N,"ok":true,"result":{...}} | {"id":N,"ok":false,"error":"..."}
# All text payloads are base64(utf8) so console code pages never corrupt CJK.

$ErrorActionPreference = "Stop"

try {
    [Console]::InputEncoding  = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CC
{
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("gdi32.dll")] private static extern int GetDeviceCaps(IntPtr hdc, int index);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public int type; public INPUTUNION U; }

    private const int INPUT_MOUSE = 0;
    private const int INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTFLEFTDOWN = 0x0002, MOUSEEVENTFLEFTUP = 0x0004;
    private const uint MOUSEEVENTFRIGHTDOWN = 0x0008, MOUSEEVENTFRIGHTUP = 0x0010;
    private const uint MOUSEEVENTFMIDDLEDOWN = 0x0020, MOUSEEVENTFMIDDLEUP = 0x0040;
    private const uint MOUSEEVENTFWHEEL = 0x0800, MOUSEEVENTFHWHEEL = 0x01000;
    private const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    static CC()
    {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 -> physical pixel coordinates everywhere.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    }

    public static Dictionary<string, object> ScreenInfo()
    {
        var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
        var primary = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
        POINT p; GetCursorPos(out p);
        var hwnd = GetForegroundWindow();
        var sb = new StringBuilder(512);
        GetWindowTextW(hwnd, sb, 512);
        IntPtr dc = GetDC(IntPtr.Zero);
        int logPixelsX = GetDeviceCaps(dc, 88); // LOGPIXELSX
        ReleaseDC(IntPtr.Zero, dc);
        return new Dictionary<string, object>
        {
            { "virtualLeft", vs.Left }, { "virtualTop", vs.Top },
            { "virtualWidth", vs.Width }, { "virtualHeight", vs.Height },
            { "primaryWidth", primary.Width }, { "primaryHeight", primary.Height },
            { "cursorX", p.X }, { "cursorY", p.Y },
            { "activeWindowTitle", sb.ToString() },
            { "dpi", logPixelsX },
        };
    }

    public static Dictionary<string, object> Screenshot(int x, int y, int w, int h, int maxW, int maxH, string fmt, int quality)
    {
        var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
        int rx, ry, rw, rh;
        if (w <= 0 || h <= 0) { rx = vs.Left; ry = vs.Top; rw = vs.Width; rh = vs.Height; }
        else
        {
            rx = Math.Max(x, vs.Left); ry = Math.Max(y, vs.Top);
            rw = Math.Min(w, vs.Right - rx); rh = Math.Min(h, vs.Bottom - ry);
        }
        if (rw <= 0 || rh <= 0) throw new Exception("Screenshot region is empty or outside the screen.");

        using (var bmp = new Bitmap(rw, rh))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(rx, ry, 0, 0, new Size(rw, rh), CopyPixelOperation.SourceCopy);
            }

            double scale = 1.0;
            int ow = rw, oh = rh;
            if (maxW > 0 && rw > maxW) scale = Math.Min(scale, (double)maxW / rw);
            if (maxH > 0 && rh > maxH) scale = Math.Min(scale, (double)maxH / rh);

            Bitmap outBmp = bmp;
            if (scale < 1.0)
            {
                ow = Math.Max(1, (int)Math.Round(rw * scale));
                oh = Math.Max(1, (int)Math.Round(rh * scale));
                // do not dispose bmp yet; keep using it as source
                outBmp = new Bitmap(ow, oh);
                using (var g2 = Graphics.FromImage(outBmp))
                {
                    g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g2.DrawImage(bmp, 0, 0, ow, oh);
                }
            }

            using (var ms = new MemoryStream())
            {
                if (fmt == "png") { outBmp.Save(ms, ImageFormat.Png); }
                else
                {
                    var codec = GetEncoder(ImageFormat.Jpeg);
                    var p = new System.Drawing.Imaging.EncoderParameters(1);
                    p.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(1, Math.Min(100, quality)));
                    outBmp.Save(ms, codec, p);
                }
                if (outBmp != bmp) outBmp.Dispose();
                return new Dictionary<string, object>
                {
                    { "image", Convert.ToBase64String(ms.ToArray()) },
                    { "regionX", rx }, { "regionY", ry }, { "regionWidth", rw }, { "regionHeight", rh },
                    { "imageWidth", ow }, { "imageHeight", oh },
                    { "virtualLeft", vs.Left }, { "virtualTop", vs.Top },
                    { "virtualWidth", vs.Width }, { "virtualHeight", vs.Height },
                    { "mimeType", fmt == "png" ? "image/png" : "image/jpeg" },
                };
            }
        }
    }

    private static ImageCodecInfo GetEncoder(ImageFormat format)
    {
        foreach (var c in ImageCodecInfo.GetImageDecoders())
            if (c.FormatID == format.Guid) return c;
        return null;
    }

    public static void Move(int x, int y) { SetCursorPos(x, y); }

    private static void MouseButtonEvent(uint down, uint up, int count)
    {
        for (int i = 0; i < count; i++)
        {
            var inputs = new INPUT[2];
            inputs[0] = new INPUT { type = INPUT_MOUSE, U = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = down } } };
            inputs[1] = new INPUT { type = INPUT_MOUSE, U = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = up } } };
            SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (i + 1 < count) Thread.Sleep(50);
        }
    }

    public static void Click(int x, int y, string button, int count)
    {
        count = Math.Max(1, Math.Min(3, count));
        SetCursorPos(x, y);
        Thread.Sleep(15);
        switch ((button ?? "left").ToLowerInvariant())
        {
            case "right": MouseButtonEvent(MOUSEEVENTFRIGHTDOWN, MOUSEEVENTFRIGHTUP, count); break;
            case "middle": MouseButtonEvent(MOUSEEVENTFMIDDLEDOWN, MOUSEEVENTFMIDDLEUP, count); break;
            default: MouseButtonEvent(MOUSEEVENTFLEFTDOWN, MOUSEEVENTFLEFTUP, count); break;
        }
    }

    public static void Drag(int x1, int y1, int x2, int y2, string button, int steps)
    {
        steps = Math.Max(2, Math.Min(200, steps));
        uint down = MOUSEEVENTFLEFTDOWN, up = MOUSEEVENTFLEFTUP;
        switch ((button ?? "left").ToLowerInvariant())
        {
            case "right": down = MOUSEEVENTFRIGHTDOWN; up = MOUSEEVENTFRIGHTUP; break;
            case "middle": down = MOUSEEVENTFMIDDLEDOWN; up = MOUSEEVENTFMIDDLEUP; break;
        }
        SetCursorPos(x1, y1);
        Thread.Sleep(15);
        var one = new INPUT[1];
        one[0] = new INPUT { type = INPUT_MOUSE, U = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = down } } };
        SendInput(1, one, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(80);
        for (int i = 1; i <= steps; i++)
        {
            int cx = x1 + (x2 - x1) * i / steps;
            int cy = y1 + (y2 - y1) * i / steps;
            SetCursorPos(cx, cy);
            Thread.Sleep(8);
        }
        Thread.Sleep(40);
        one[0] = new INPUT { type = INPUT_MOUSE, U = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = up } } };
        SendInput(1, one, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Scroll(int x, int y, int deltaY, int deltaX)
    {
        if (x != int.MinValue || y != int.MinValue)
        {
            if (x == int.MinValue || y == int.MinValue)
            {
                POINT p; GetCursorPos(out p);
                if (x == int.MinValue) x = p.X; else y = p.Y;
            }
            SetCursorPos(x, y);
            Thread.Sleep(15);
        }
        if (deltaY != 0) SendOne(MOUSEEVENTFWHEEL, unchecked((uint)(deltaY * 120)));
        if (deltaX != 0) SendOne(MOUSEEVENTFHWHEEL, unchecked((uint)(deltaX * 120)));
    }

    private static void SendOne(uint flags, uint data)
    {
        var one = new INPUT[1];
        one[0] = new INPUT { type = INPUT_MOUSE, U = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = flags, mouseData = data } } };
        SendInput(1, one, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void TypeText(string text)
    {
        // Iterate UTF-16 code units: handles CJK and surrogate pairs via KEYEVENTF_UNICODE.
        foreach (char c in text)
        {
            var pair = new INPUT[2];
            pair[0] = new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0, wScan = (ushort)c, dwFlags = KEYEVENTF_UNICODE } } };
            pair[1] = new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0, wScan = (ushort)c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } };
            SendInput(2, pair, Marshal.SizeOf(typeof(INPUT)));
            Thread.Sleep(3);
        }
    }

    public static void PressKeys(int[] vks)
    {
        var inputs = new List<INPUT>();
        foreach (int vk in vks)
            inputs.Add(new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = (ushort)vk } } });
        for (int i = vks.Length - 1; i >= 0; i--)
            inputs.Add(new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = (ushort)vks[i], dwFlags = KEYEVENTF_KEYUP } } });
        SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    }

    public static Dictionary<string, object> CursorPos()
    {
        POINT p; GetCursorPos(out p);
        return new Dictionary<string, object> { { "x", p.X }, { "y", p.Y } };
    }
}
'@ -ReferencedAssemblies System.Drawing, System.Windows.Forms

function Decode-Text([string]$b64) {
    if ([string]::IsNullOrEmpty($b64)) { return "" }
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $req = $null
    try {
        $req = $line | ConvertFrom-Json
        $p = $req.params
        $r = $null
        switch ($req.method) {
            "ping"       { $r = @{ pong = $true } }
            "screenInfo" { $r = [CC]::ScreenInfo() }
            "cursorPos"  { $r = [CC]::CursorPos() }
            "screenshot" {
                $r = [CC]::Screenshot(
                    [int]$p.x, [int]$p.y, [int]$p.w, [int]$p.h,
                    [int]$p.maxW, [int]$p.maxH, [string]$p.fmt, [int]$p.quality)
            }
            "move"       { [CC]::Move([int]$p.x, [int]$p.y); $r = [CC]::CursorPos() }
            "click"      { [CC]::Click([int]$p.x, [int]$p.y, [string]$p.button, [int]$p.count); $r = @{ done = $true } }
            "drag"       { [CC]::Drag([int]$p.x1, [int]$p.y1, [int]$p.x2, [int]$p.y2, [string]$p.button, [int]$p.steps); $r = @{ done = $true } }
            "scroll" {
                $sx = [int]::MinValue; $sy = [int]::MinValue
                if ($null -ne $p.x) { $sx = [int]$p.x }
                if ($null -ne $p.y) { $sy = [int]$p.y }
                [CC]::Scroll($sx, $sy, [int]$p.deltaY, [int]$p.deltaX)
                $r = @{ done = $true }
            }
            "type"       { [CC]::TypeText((Decode-Text $p.textB64)); $r = @{ done = $true } }
            "key"        { [CC]::PressKeys(@($p.vks | ForEach-Object { [int]$_ })); $r = @{ done = $true } }
            "shutdown"   { $resp = @{ id = $req.id; ok = $true; result = @{bye=$true} }; [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 6)); exit 0 }
            default      { throw "Unknown method: $($req.method)" }
        }
        $resp = @{ id = $req.id; ok = $true; result = $r }
    } catch {
        $id = $null
        if ($null -ne $req) { $id = $req.id }
        $resp = @{ id = $id; ok = $false; error = [string]$_.Exception.Message }
    }
    [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 6))
}
