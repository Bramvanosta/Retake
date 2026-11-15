//! The context menus' gate (DESIGN §4j): the window page may ask for one of the shell's context menus (an id of
//! menu.rs CONTEXT_MENUS, through the server's `desktop_menu` {popup}), but the shell trusts no page timing — a menu
//! shows only right after a real secondary click in the window's page, once per click. The shell's NSEvent monitor
//! records each mouse-down `secondary_click` accepts; a request takes the last click (`ContextGate::take`) within
//! CONTEXT_REACH_MS, at that click's place.

/// How long after a secondary click its context menu may still show (ms): the page's `contextmenu` event, the
/// server's op and the pipe line in between.
pub const CONTEXT_REACH_MS: u64 = 1500;

/// A mouse-down the shell's monitor saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseDown {
    Right,
    Left,
    Other,
}

/// A secondary click in the window's page: the right button, or the left one with Control — in the main window
/// (not an alert, the folder panel or another window) and inside its content (not the title bar).
pub fn secondary_click(kind: MouseDown, control: bool, main_window: bool, in_content: bool) -> bool {
    main_window
        && in_content
        && match kind {
            MouseDown::Right => true,
            MouseDown::Left => control,
            MouseDown::Other => false,
        }
}

/// Why a context menu was not shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// No secondary click in the window since the last menu.
    NoClick,
    /// The click was longer ago than CONTEXT_REACH_MS.
    Late,
}

impl Refused {
    pub fn words(self) -> &'static str {
        match self {
            Refused::NoClick => "no right-click in the window",
            Refused::Late => "the right-click was too long ago",
        }
    }
}

/// The last secondary click (its time in ms, its place in the window's content, points from the top left).
#[derive(Debug, Default)]
pub struct ContextGate {
    click: Option<(u64, (f64, f64))>,
}

impl ContextGate {
    pub const fn new() -> Self {
        ContextGate { click: None }
    }

    pub fn clicked(&mut self, now_ms: u64, at: (f64, f64)) {
        self.click = Some((now_ms, at));
    }

    /// Another menu opened (WebKit's own, in a text field; the menu bar): the click it answered opens none of ours.
    pub fn forget(&mut self) {
        self.click = None;
    }

    /// May a context menu show now: once per click (the click is used up either way), within CONTEXT_REACH_MS of it;
    /// its place.
    pub fn take(&mut self, now_ms: u64) -> Result<(f64, f64), Refused> {
        let (t, at) = self.click.take().ok_or(Refused::NoClick)?;
        if now_ms < t || now_ms - t > CONTEXT_REACH_MS {
            return Err(Refused::Late);
        }
        Ok(at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_context_gate_opens_once_per_secondary_click_within_reach() {
        let mut g = ContextGate::default();
        assert_eq!(g.take(10), Err(Refused::NoClick));
        g.clicked(1000, (12.0, 34.0));
        assert_eq!(g.take(1000 + CONTEXT_REACH_MS - 1), Ok((12.0, 34.0)));
        // Once: the same click opens no second menu.
        assert_eq!(g.take(1000 + CONTEXT_REACH_MS - 1), Err(Refused::NoClick));
        g.clicked(5000, (1.0, 2.0));
        assert_eq!(g.take(5000 + CONTEXT_REACH_MS), Ok((1.0, 2.0)));
        g.clicked(9000, (1.0, 2.0));
        assert_eq!(g.take(9000 + CONTEXT_REACH_MS + 1), Err(Refused::Late));
        // A late request used the click up too.
        assert_eq!(g.take(9000 + CONTEXT_REACH_MS + 2), Err(Refused::NoClick));
        // A clock that went back is no reach.
        g.clicked(20_000, (0.0, 0.0));
        assert_eq!(g.take(19_999), Err(Refused::Late));
        // A menu that is not ours opened on the click (WebKit's own): ours never stacks on it.
        g.clicked(25_000, (3.0, 3.0));
        g.forget();
        assert_eq!(g.take(25_001), Err(Refused::NoClick));
        // The newest click counts.
        g.clicked(30_000, (1.0, 1.0));
        g.clicked(30_500, (2.0, 2.0));
        assert_eq!(g.take(31_000), Ok((2.0, 2.0)));
        assert_eq!(CONTEXT_REACH_MS, 1500);
    }

    #[test]
    fn a_secondary_click_is_the_right_button_or_control_left_in_the_main_window_content() {
        assert!(secondary_click(MouseDown::Right, false, true, true));
        assert!(secondary_click(MouseDown::Right, true, true, true));
        assert!(secondary_click(MouseDown::Left, true, true, true));
        assert!(!secondary_click(MouseDown::Left, false, true, true));
        assert!(!secondary_click(MouseDown::Other, true, true, true));
        // An alert, the folder panel, another window; the title bar.
        assert!(!secondary_click(MouseDown::Right, false, false, true));
        assert!(!secondary_click(MouseDown::Right, false, true, false));
        assert_eq!(Refused::NoClick.words(), "no right-click in the window");
    }
}
