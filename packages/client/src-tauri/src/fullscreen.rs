#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScreenRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl ScreenRect {
    pub const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self { left, top, right, bottom }
    }
}

pub fn is_fullscreen_bounds(window: ScreenRect, monitor: ScreenRect) -> bool {
    const TOLERANCE: i32 = 3;
    (window.left - monitor.left).abs() <= TOLERANCE
        && (window.top - monitor.top).abs() <= TOLERANCE
        && (window.right - monitor.right).abs() <= TOLERANCE
        && (window.bottom - monitor.bottom).abs() <= TOLERANCE
}

#[cfg(target_os = "windows")]
pub fn is_foreground_fullscreen(own_window: windows::Win32::Foundation::HWND) -> bool {
    use std::mem::size_of;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetShellWindow, GetWindowRect, IsIconic,
    };

    unsafe {
        let foreground = GetForegroundWindow();
        if foreground == HWND::default()
            || foreground == own_window
            || foreground == GetShellWindow()
            || IsIconic(foreground).as_bool()
        {
            return false;
        }

        let mut window_rect = RECT::default();
        if GetWindowRect(foreground, &mut window_rect).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST);
        if monitor.is_invalid() {
            return false;
        }
        let mut monitor_info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut monitor_info).as_bool() {
            return false;
        }

        is_fullscreen_bounds(
            ScreenRect::new(window_rect.left, window_rect.top, window_rect.right, window_rect.bottom),
            ScreenRect::new(
                monitor_info.rcMonitor.left,
                monitor_info.rcMonitor.top,
                monitor_info.rcMonitor.right,
                monitor_info.rcMonitor.bottom,
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{is_fullscreen_bounds, ScreenRect};

    #[test]
    fn exact_monitor_bounds_are_fullscreen() {
        let monitor = ScreenRect::new(0, 0, 1920, 1080);
        assert!(is_fullscreen_bounds(ScreenRect::new(0, 0, 1920, 1080), monitor));
    }

    #[test]
    fn maximized_work_area_is_not_fullscreen() {
        let monitor = ScreenRect::new(0, 0, 1920, 1080);
        assert!(!is_fullscreen_bounds(ScreenRect::new(0, 0, 1920, 1040), monitor));
    }

    #[test]
    fn small_dpi_border_difference_is_tolerated_on_secondary_monitor() {
        let monitor = ScreenRect::new(-2560, 0, 0, 1440);
        assert!(is_fullscreen_bounds(ScreenRect::new(-2562, -2, 2, 1442), monitor));
    }
}
