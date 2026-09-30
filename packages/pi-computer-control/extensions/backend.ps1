# pi-computer-control backend (Windows)
# Persistent JSON-RPC host over stdio: one JSON object per line.
# Node side sends {"id":N,"method":"...","params":{...}} and reads
# {"id":N,"ok":true,"result":{...}} | {"id":N,"ok":false,"error":"..."}
# All text payloads are base64(utf8) so console code pages never corrupt CJK.
#
# v0.2 additions:
#   - Window management: list / activate / minimize / maximize / move / resize / close
#   - Window-scoped screenshot via PrintWindow (works for covered windows too, best effort)
#   - Background (focus-preserving) input to a specific window via PostMessage
#     (mouse click/scroll + WM_CHAR typing + key combos; no focus stealing)
#   - UIA element lookup and invocation: find controls by name substring / automationId /
#     control type, get their on-screen bounds (great for precise clicking)
#   - Version handshake on ping

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
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool CloseWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern int GetDeviceCaps(IntPtr hdc, int index);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int attrSize);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);

    [StructLayout(LayoutKind.Sequential)]
    private struct GUITHREADINFO
    {
        public int cbSize; public uint flags; public IntPtr hwndActive; public IntPtr hwndFocus;
        public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize;
        public IntPtr hwndCaret; public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
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

    private const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
    private const uint WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
    private const uint WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208;
    private const uint WM_MOUSEWHEEL = 0x020A, WM_MOUSEHWHEEL = 0x020E;
    private const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102, WM_IME_CHAR = 0x0286;
    private const uint WM_CLOSE = 0x0010;

    private const int SW_HIDE = 0, SW_SHOWNORMAL = 1, SW_SHOWMINIMIZED = 2, SW_SHOWMAXIMIZED = 3, SW_RESTORE = 9;

    // DPI / extended window styles
    private const int GWL_STYLE = -16;
    private const long WS_CHILD = 0x40000000L;
    private const long WS_VISIBLE = 0x10000000L;

    // DWMWA_EXTENDED_FRAME_BOUNDS = 9 -> avoids invisible resize borders in window rects
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

    public const string Version = "0.2.0";

    private static void EncodeLparam(uint flags, int x, int y, out IntPtr lp)
    {
        // MK flags layout for mouse messages
        lp = (IntPtr)((y << 16) | (x & 0xFFFF));
    }

    private static bool IsTopLevelVisible(IntPtr h)
    {
        if (!IsWindowVisible(h)) return false;
        if (IsIconic(h)) return false; // skip minimized windows
        // Skip tool/child windows: need a title and WS_VISIBLE on a top-level window
        var sb = new StringBuilder(256);
        GetWindowTextW(h, sb, 256);
        if (sb.Length == 0) return false;
        long style = (long)GetWindowLong(h, GWL_STYLE) & 0xFFFFFFFFL;
        if ((style & WS_CHILD) != 0) return false;
        if ((style & WS_VISIBLE) == 0) return false;
        return true;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public const uint Version2 = 0;

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
            { "backendVersion", Version },
        };
    }

    // ------------------------------------------------------------------
    // Window enumeration
    // ------------------------------------------------------------------
    public static List<Dictionary<string, object>> ListWindows(string filter)
    {
        var result = new List<Dictionary<string, object>>();
        EnumWindows((h, lp) =>
        {
            if (!IsTopLevelVisible(h)) return true;
            var title = new StringBuilder(512);
            GetWindowTextW(h, title, 512);
            var cls = new StringBuilder(256);
            GetClassNameW(h, cls, 256);
            string t = title.ToString();
            if (!string.IsNullOrEmpty(filter) && t.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) return true;
            RECT r;
            if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0)
                GetWindowRect(h, out r);
            uint pid; GetWindowThreadProcessId(h, out pid);
            result.Add(new Dictionary<string, object>
            {
                { "hwnd", h.ToInt64() },
                { "title", t },
                { "className", cls.ToString() },
                { "pid", pid },
                { "x", r.Left }, { "y", r.Top },
                { "width", r.Right - r.Left }, { "height", r.Bottom - r.Top },
                { "minimized", IsIconic(h) },
                { "maximized", IsZoomed(h) },
                { "foreground", h == GetForegroundWindow() },
            });
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static Dictionary<string, object> WindowInfo(IntPtr h)
    {
        if (!IsWindow(h)) throw new Exception("Invalid window handle.");
        var title = new StringBuilder(512); GetWindowTextW(h, title, 512);
        var cls = new StringBuilder(256); GetClassNameW(h, cls, 256);
        RECT r;
        if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0)
            GetWindowRect(h, out r);
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT rc; GetClientRect(h, out rc);
        return new Dictionary<string, object>
        {
            { "hwnd", h.ToInt64() },
            { "title", title.ToString() },
            { "className", cls.ToString() },
            { "pid", pid },
            { "x", r.Left }, { "y", r.Top },
            { "width", r.Right - r.Left }, { "height", r.Bottom - r.Top },
            { "clientWidth", rc.Right - rc.Left }, { "clientHeight", rc.Bottom - rc.Top },
            { "minimized", IsIconic(h) },
            { "maximized", IsZoomed(h) },
            { "foreground", h == GetForegroundWindow() },
        };
    }

    public static void ActivateWindow(IntPtr h)
    {
        if (!IsWindow(h)) throw new Exception("Invalid window handle.");
        if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
        SetForegroundWindow(h);
    }

    public static void ShowWindowState(IntPtr h, string state)
    {
        if (!IsWindow(h)) throw new Exception("Invalid window handle.");
        switch ((state ?? "").ToLowerInvariant())
        {
            case "minimize": ShowWindow(h, SW_SHOWMINIMIZED); break;
            case "maximize": ShowWindow(h, SW_SHOWMAXIMIZED); break;
            case "restore": ShowWindow(h, SW_RESTORE); break;
            case "hide": ShowWindow(h, SW_HIDE); break;
            case "show": ShowWindow(h, SW_SHOWNORMAL); break;
            default: throw new Exception("Unknown state: " + state);
        }
    }

    public static void MoveWindow(IntPtr h, int x, int y, int w, int hgt)
    {
        if (!IsWindow(h)) throw new Exception("Invalid window handle.");
        if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
        MoveWindowInternal(h, x, y, w, hgt, true);
    }

    [DllImport("user32.dll")] private static extern bool MoveWindowInternal(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

    public static Dictionary<string, object> CloseWindow2(IntPtr h)
    {
        if (!IsWindow(h)) throw new Exception("Invalid window handle.");
        PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        return new Dictionary<string, object> { { "sent", true } };
    }

    // ------------------------------------------------------------------
    // Window-scoped screenshot via PrintWindow (best-effort for covered windows)
    // ------------------------------------------------------------------
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr hdc);

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
                outBmp = new Bitmap(ow, oh);
                using (var g2 = Graphics.FromImage(outBmp))
                {
                    g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g2.DrawImage(bmp, 0, 0, ow, oh);
                }
            }

            using (var ms = new MemoryStream())
            {
                bool isPng = (fmt == "png") || GetEncoder(ImageFormat.Jpeg) == null;
                if (isPng) { outBmp.Save(ms, ImageFormat.Png); }
                else
                {
                    var codec = GetEncoder(ImageFormat.Jpeg);
                    var p = new System.Drawing.Imaging.EncoderParameters(1);
                    p.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(1, Math.Min(100, quality)));
                    outBmp.Save(ms, codec, p);
                }
                return new Dictionary<string, object>
                {
                    { "image", Convert.ToBase64String(ms.ToArray()) },
                    { "regionX", rx }, { "regionY", ry }, { "regionWidth", rw }, { "regionHeight", rh },
                    { "imageWidth", ow }, { "imageHeight", oh },
                    { "virtualLeft", vs.Left }, { "virtualTop", vs.Top },
                    { "virtualWidth", vs.Width }, { "virtualHeight", vs.Height },
                    { "mimeType", isPng ? "image/png" : "image/jpeg" },
                };
            }
        }
    }

    public static Dictionary<string, object> WindowScreenshot(IntPtr h, int maxW, int maxH, string fmt, int quality)
    {
        if (!IsWindow(h) || !IsWindowVisible(h)) throw new Exception("Invalid or invisible window handle.");
        if (IsIconic(h)) throw new Exception("Window is minimized; restore it first.");
        RECT r;
        if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0)
            GetWindowRect(h, out r);
        int w = r.Right - r.Left, hgt = r.Bottom - r.Top;
        if (w <= 0 || hgt <= 0) throw new Exception("Window rect is empty.");

        IntPtr hdcScreen = GetDC(IntPtr.Zero);
        IntPtr hdcMem = CreateCompatibleDC(hdcScreen);
        IntPtr bmp = CreateCompatibleBitmap(hdcScreen, w, hgt);
        IntPtr old = SelectObject(hdcMem, bmp);
        try
        {
            // PW_RENDERFULLCONTENT = 2 (Win 8.1+) captures DWM-composed content incl. Chromium
            if (!PrintWindow(h, hdcMem, 2))
                PrintWindow(h, hdcMem, 0);

            using (var src = Image.FromHbitmap(bmp))
            {
                double scale = 1.0;
                if (maxW > 0 && w > maxW) scale = Math.Min(scale, (double)maxW / w);
                if (maxH > 0 && hgt > maxH) scale = Math.Min(scale, (double)maxH / hgt);
                int ow = Math.Max(1, (int)Math.Round(w * scale));
                int oh = Math.Max(1, (int)Math.Round(hgt * scale));

                using (var ms = new MemoryStream())
                {
                    Image outImg = src;
                    if (scale < 1.0)
                    {
                        var resized = new Bitmap(ow, oh);
                        using (var g2 = Graphics.FromImage(resized))
                        {
                            g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            g2.DrawImage(src, 0, 0, ow, oh);
                        }
                        outImg = resized;
                    }
                    if (fmt == "png") outImg.Save(ms, ImageFormat.Png);
                    else
                    {
                        var codec = GetEncoder(ImageFormat.Jpeg);
                        if (codec != null)
                        {
                            var p = new System.Drawing.Imaging.EncoderParameters(1);
                            p.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(1, Math.Min(100, quality)));
                            outImg.Save(ms, codec, p);
                        }
                        else outImg.Save(ms, ImageFormat.Png);
                    }
                    if (outImg != src) outImg.Dispose();
                    return new Dictionary<string, object>
                    {
                        { "image", Convert.ToBase64String(ms.ToArray()) },
                        { "regionX", r.Left }, { "regionY", r.Top },
                        { "regionWidth", w }, { "regionHeight", hgt },
                        { "imageWidth", ow }, { "imageHeight", oh },
                        { "virtualLeft", 0 }, { "virtualTop", 0 },
                        { "virtualWidth", w }, { "virtualHeight", hgt },
                        { "mimeType", (fmt == "png" || GetEncoder(ImageFormat.Jpeg) == null) ? "image/png" : "image/jpeg" },
                    };
                }
            }
        }
        finally
        {
            SelectObject(hdcMem, old);
            DeleteObject(bmp);
            DeleteDC(hdcMem);
            ReleaseDC(IntPtr.Zero, hdcScreen);
        }
    }

    private static ImageCodecInfo GetEncoder(ImageFormat format)
    {
        foreach (var c in ImageCodecInfo.GetImageDecoders())
            if (c.FormatID == format.Guid) return c;
        return null;
    }

    // ------------------------------------------------------------------
    // Background (focus-preserving) input to a specific window via PostMessage
    // Keyboard/typing is routed to the thread's FOCUSED child control
    // (via GetGUIThreadInfo) so text lands in the right control; if no focus
    // info is available it falls back to the top-level HWND.
    // Mouse coords are CLIENT-AREA coordinates relative to the window.
    // NOTE: this works for classic Win32 controls (EDIT, etc.) and many
    // WinForms/WPF apps; apps using custom input pipelines (Chromium, WinUI3)
    // may ignore synthetic PostMessage input - use foreground actions for those.
    // ------------------------------------------------------------------
    private static IntPtr MakeLParam(int x, int y)
    {
        return (IntPtr)((y << 16) | (x & 0xFFFF));
    }

    private static IntPtr FocusedChild(IntPtr h)
    {
        uint pid; var tid = GetWindowThreadProcessId(h, out pid);
        var gti = new GUITHREADINFO();
        gti.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(tid, ref gti) && gti.hwndFocus != IntPtr.Zero)
        {
            return gti.hwndFocus;
        }
        return h;
    }

    public static void BgClick(IntPtr h, int x, int y, string button)
    {
        if (!IsWindow(h)) throw new Exception("Invalid window handle.");
        IntPtr lp = MakeLParam(x, y);
        uint msgDown, msgUp;
        switch ((button ?? "left").ToLowerInvariant())
        {
            case "right": msgDown = WM_RBUTTONDOWN; msgUp = WM_RBUTTONUP; break;
            case "middle": msgDown = WM_MBUTTONDOWN; msgUp = WM_MBUTTONUP; break;
            default: msgDown = WM_LBUTTONDOWN; msgUp = WM_LBUTTONUP; break;
        }
        PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, lp);
        Thread.Sleep(10);
        PostMessage(h, msgDown, IntPtr.Zero, lp);
        Thread.Sleep(30);
        PostMessage(h, msgUp, IntPtr.Zero, lp);
    }

    public static void BgClickDouble(IntPtr h, int x, int y, string button)
    {
        BgClick(h, x, y, button);
        Thread.Sleep(60);
        BgClick(h, x, y, button);
    }

    public static void BgScroll(IntPtr h, int x, int y, int deltaY, int deltaX)
    {
        if (!IsWindow(h)) throw new Exception("Invalid window handle.");
        IntPtr lp = MakeLParam(x, y);
        if (deltaY != 0)
            PostMessage(h, WM_MOUSEWHEEL, (IntPtr)((unchecked((uint)(deltaY * 120)) << 16) | 0), lp);
        if (deltaX != 0)
            PostMessage(h, WM_MOUSEHWHEEL, (IntPtr)((unchecked((uint)(deltaX * 120)) << 16) | 0), lp);
    }


    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern IntPtr VirtualAllocEx(IntPtr proc, IntPtr addr, IntPtr size, uint allocType, uint protect);
    [DllImport("kernel32.dll")] private static extern bool WriteProcessMemory(IntPtr proc, IntPtr baseAddr, byte[] buffer, IntPtr size, out IntPtr written);
    [DllImport("kernel32.dll")] private static extern bool VirtualFreeEx(IntPtr proc, IntPtr addr, IntPtr size, uint freeType);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    private const uint PROCESS_VM_OPERATION = 0x0008, PROCESS_VM_WRITE = 0x0010, PROCESS_VM_READ = 0x00000020, PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, MEM_RELEASE = 0x8000;
    private const uint PAGE_READWRITE = 0x04;
    private const uint EM_REPLACESEL = 0x00C2;

    [DllImport("user32.dll", EntryPoint = "SendMessageW")] private static extern int SendMessageLength(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    private const uint WM_GETTEXTLENGTH = 0x000E;

    private static bool BgReplaceSel(IntPtr target, string text)
    {
        int initialLen = SendMessageLength(target, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);
        uint pid; GetWindowThreadProcessId(target, out pid);
        IntPtr proc = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid);
        if (proc == IntPtr.Zero) return false;
        try
        {
            byte[] payload = System.Text.Encoding.Unicode.GetBytes(text + "\0");
            IntPtr remote = VirtualAllocEx(proc, IntPtr.Zero, (IntPtr)payload.Length, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            if (remote == IntPtr.Zero) return false;
            try
            {
                IntPtr written;
                if (!WriteProcessMemory(proc, remote, payload, (IntPtr)payload.Length, out written)) return false;
                // wParam: 1 = allow undo. Send (not Post) so the buffer stays alive until handled.
                SendMessageW(target, EM_REPLACESEL, (IntPtr)1, remote);
                // Verify by checking the text length actually grew
                int len = SendMessageLength(target, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);
                return len >= initialLen + text.Length;
            }
            finally { VirtualFreeEx(proc, remote, IntPtr.Zero, MEM_RELEASE); }
        }
        finally { CloseHandle(proc); }
    }


    public static void BgTypeText(IntPtr h, string text)
    {
        if (!IsWindow(h)) throw new Exception("Invalid window handle.");
        IntPtr target = FocusedChild(h);
        // EM_REPLACESEL (0x00C2) with a UTF-16 string allocated in the target process
        // is the most robust "type into focused control" path: handles CJK, emoji,
        // surrogates, no IME/codepage issues. Falls back to WM_CHAR/WM_IME_CHAR loop
        // for controls that reject it (e.g. non-EDIT hosts).
        try
        {
            if (BgReplaceSel(target, text)) return;
        }
        catch { }
        foreach (char c in text)
        {
            if (c <= 0x7F)
            {
                PostMessage(target, WM_CHAR, (IntPtr)c, IntPtr.Zero);
                Thread.Sleep(2);
            }
            else
            {
                byte[] bytes = System.Text.Encoding.Default.GetBytes(new char[] { c });
                if (bytes.Length == 2)
                {
                    ushort w = (ushort)((bytes[0] << 8) | bytes[1]);
                    PostMessage(target, WM_IME_CHAR, (IntPtr)w, IntPtr.Zero);
                }
                else if (bytes.Length == 1)
                {
                    PostMessage(target, WM_IME_CHAR, (IntPtr)bytes[0], IntPtr.Zero);
                }
                else
                {
                    PostMessage(target, WM_CHAR, (IntPtr)c, IntPtr.Zero);
                }
                Thread.Sleep(2);
            }
        }
    }

    public static void BgPressKeys(IntPtr h, int[] vks)
    {
        if (!IsWindow(h)) throw new Exception("Invalid window handle.");
        IntPtr target = FocusedChild(h);
        foreach (int vk in vks)
            PostMessage(target, WM_KEYDOWN, (IntPtr)vk, IntPtr.Zero);
        for (int i = vks.Length - 1; i >= 0; i--)
            PostMessage(target, WM_KEYUP, (IntPtr)vks[i], IntPtr.Zero);
    }

    // ------------------------------------------------------------------
    // UIA: find elements by name / automationId / control type; return bounds
    // ------------------------------------------------------------------
    public static List<Dictionary<string, object>> FindElements(IntPtr h, string name, string automationId, string controlType, int limit)
    {
        var results = new List<Dictionary<string, object>>();
        var root = System.Windows.Automation.AutomationElement.FromHandle(h);
        if (root == null) throw new Exception("Cannot attach UIA to this window.");
        var cond = System.Windows.Automation.Condition.TrueCondition;
        var elements = root.FindAll(System.Windows.Automation.TreeScope.Descendants, cond);
        int count = 0;
        foreach (System.Windows.Automation.AutomationElement el in elements)
        {
            if (count >= (limit <= 0 ? 15 : limit)) break;
            string n = el.Current.Name ?? "";
            string aid = el.Current.AutomationId ?? "";
            string ct = el.Current.ControlType != null && el.Current.ControlType.ProgrammaticName != null
                ? el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") : "";
            bool match = true;
            if (!string.IsNullOrEmpty(name) && n.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) match = false;
            if (match && !string.IsNullOrEmpty(automationId) && aid.IndexOf(automationId, StringComparison.OrdinalIgnoreCase) < 0) match = false;
            if (match && !string.IsNullOrEmpty(controlType) && !ct.Equals(controlType, StringComparison.OrdinalIgnoreCase)) match = false;
            if (!match) continue;
            var rect = el.Current.BoundingRectangle;
            results.Add(new Dictionary<string, object>
            {
                { "name", n },
                { "automationId", aid },
                { "controlType", ct },
                { "enabled", el.Current.IsEnabled },
                { "x", (int)rect.X }, { "y", (int)rect.Y },
                { "width", (int)rect.Width }, { "height", (int)rect.Height },
                { "centerX", (int)(rect.X + rect.Width / 2) }, { "centerY", (int)(rect.Y + rect.Height / 2) },
            });
            count++;
        }
        return results;
    }

    public static Dictionary<string, object> InvokeElement(IntPtr h, string name, string automationId)
    {
        var root = System.Windows.Automation.AutomationElement.FromHandle(h);
        if (root == null) throw new Exception("Cannot attach UIA to this window.");
        var cond = System.Windows.Automation.Condition.TrueCondition;
        var elements = root.FindAll(System.Windows.Automation.TreeScope.Descendants, cond);
        foreach (System.Windows.Automation.AutomationElement el in elements)
        {
            string n = el.Current.Name ?? "";
            string aid = el.Current.AutomationId ?? "";
            bool match = true;
            if (!string.IsNullOrEmpty(name) && n.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) match = false;
            if (match && !string.IsNullOrEmpty(automationId) && aid.IndexOf(automationId, StringComparison.OrdinalIgnoreCase) < 0) match = false;
            if (!match || string.IsNullOrEmpty(name) && string.IsNullOrEmpty(automationId)) continue;
            if (!string.IsNullOrEmpty(name) && string.IsNullOrEmpty(automationId) && n.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) continue;
            if (!el.Current.IsEnabled) continue;

            // Try InvokePattern first
            object pat;
            if (el.TryGetCurrentPattern(System.Windows.Automation.InvokePattern.Pattern, out pat))
            {
                ((System.Windows.Automation.InvokePattern)pat).Invoke();
                return ElementResult(el, "invoked");
            }
            if (el.TryGetCurrentPattern(System.Windows.Automation.TogglePattern.Pattern, out pat))
            {
                ((System.Windows.Automation.TogglePattern)pat).Toggle();
                return ElementResult(el, "toggled");
            }
            if (el.TryGetCurrentPattern(System.Windows.Automation.SelectionItemPattern.Pattern, out pat))
            {
                ((System.Windows.Automation.SelectionItemPattern)pat).Select();
                return ElementResult(el, "selected");
            }
            if (el.TryGetCurrentPattern(System.Windows.Automation.ExpandCollapsePattern.Pattern, out pat))
            {
                var ec = (System.Windows.Automation.ExpandCollapsePattern)pat;
                if (ec.Current.ExpandCollapseState == System.Windows.Automation.ExpandCollapseState.Expanded) ec.Collapse();
                else ec.Expand();
                return ElementResult(el, "expanded/collapsed");
            }
            // Fallback: scroll into view and click its center with real input
            el.SetFocus();
            var r = el.Current.BoundingRectangle;
            Click((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), "left", 1);
            return ElementResult(el, "clicked (fallback)");
        }
        throw new Exception("No matching enabled element found" +
            (name != null ? " with name containing \"" + name + "\"" : "") +
            (automationId != null ? " with automationId containing \"" + automationId + "\"" : "") + ".");
    }

    private static Dictionary<string, object> ElementResult(System.Windows.Automation.AutomationElement el, string action)
    {
        var rect = el.Current.BoundingRectangle;
        return new Dictionary<string, object>
        {
            { "action", action },
            { "name", el.Current.Name ?? "" },
            { "automationId", el.Current.AutomationId ?? "" },
            { "controlType", el.Current.ControlType != null && el.Current.ControlType.ProgrammaticName != null
                ? el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") : "" },
            { "centerX", (int)(rect.X + rect.Width / 2) },
            { "centerY", (int)(rect.Y + rect.Height / 2) },
        };
    }

    // ------------------------------------------------------------------
    // Foreground input (v0.1, unchanged)
    // ------------------------------------------------------------------
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
'@ -ReferencedAssemblies System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes, WindowsBase

function Decode-Text([string]$b64) {
    if ([string]::IsNullOrEmpty($b64)) { return "" }
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}

# Resolve a window handle from either an explicit hwnd or (1-based) index into the last listWindows call.
$script:lastWindowList = @()
function Resolve-Hwnd($p) {
    if ($null -ne $p.hwnd -and [int64]$p.hwnd -ne 0) { return [IntPtr][int64]$p.hwnd }
    if ($null -ne $p.index -and [int]$p.index -ge 0) {
        if ([int]$p.index -ge $script:lastWindowList.Count) { throw "Window index $([int]$p.index) is stale; call listWindows again." }
        return [IntPtr][int64]$script:lastWindowList[[int]$p.index]
    }
    throw "Provide 'hwnd' (from listWindows) or 'index'."
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
            "ping"       { $r = @{ pong = $true; version = [CC]::Version } }
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

            # --- v0.2: window management ---
            "listWindows" {
                $script:lastWindowList = @()
                $all = [CC]::ListWindows([string]$p.filter)
                $limit = 40
                if ($null -ne $p.limit) { $limit = [int]$p.limit }
                $winList = New-Object System.Collections.Generic.List[object]
                foreach ($w in $all) {
                    if ($winList.Count -ge $limit) { break }
                    $script:lastWindowList += [IntPtr][int64]$w.hwnd
                    $winList.Add($w)
                }
                $r = @{ windows = $winList; total = $all.Count; shown = [Math]::Min($limit, $all.Count) }
            }
            "windowInfo"   { $h = Resolve-Hwnd $p; $r = [CC]::WindowInfo($h) }
            "activateWindow" { $h = Resolve-Hwnd $p; [CC]::ActivateWindow($h); $r = @{ done = $true } }
            "setWindowState" { $h = Resolve-Hwnd $p; [CC]::ShowWindowState($h, [string]$p.state); $r = @{ done = $true } }
            "moveWindow" {
                $h = Resolve-Hwnd $p
                [CC]::MoveWindow($h, [int]$p.x, [int]$p.y, [int]$p.width, [int]$p.height)
                $r = [CC]::WindowInfo($h)
            }
            "closeWindow"  { $h = Resolve-Hwnd $p; $r = [CC]::CloseWindow2($h) }
            "windowScreenshot" { $h = Resolve-Hwnd $p; $r = [CC]::WindowScreenshot($h, [int]$p.maxW, [int]$p.maxH, [string]$p.fmt, [int]$p.quality) }

            # --- v0.2: background (focus-preserving) input ---
            "bgClick" {
                $h = Resolve-Hwnd $p
                [CC]::BgClick($h, [int]$p.x, [int]$p.y, [string]$p.button)
                $r = @{ done = $true }
            }
            "bgDoubleClick" {
                $h = Resolve-Hwnd $p
                [CC]::BgClickDouble($h, [int]$p.x, [int]$p.y, [string]$p.button)
                $r = @{ done = $true }
            }
            "bgScroll" {
                $h = Resolve-Hwnd $p
                [CC]::BgScroll($h, [int]$p.x, [int]$p.y, [int]$p.deltaY, [int]$p.deltaX)
                $r = @{ done = $true }
            }
            "bgType"       { $h = Resolve-Hwnd $p; [CC]::BgTypeText($h, (Decode-Text $p.textB64)); $r = @{ done = $true } }
            "bgKey"        { $h = Resolve-Hwnd $p; [CC]::BgPressKeys($h, @($p.vks | ForEach-Object { [int]$_ })); $r = @{ done = $true } }

            # --- v0.2: UIA ---
            "findElements" {
                $h = Resolve-Hwnd $p
                $r = @{ elements = [CC]::FindElements($h, [string]$p.name, [string]$p.automationId, [string]$p.controlType, [int]$p.limit) }
            }
            "invokeElement" {
                $h = Resolve-Hwnd $p
                $r = [CC]::InvokeElement($h, [string]$p.name, [string]$p.automationId)
            }
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
