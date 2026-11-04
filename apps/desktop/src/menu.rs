//! The window's chrome in one place (DESIGN §4j): the native menu, built from ONE command table, and the title-bar
//! style switch.
//!
//! - `MENUS`: every item of the menu bar, in order. A `Cmd` is the shell's own command (id, label, accelerator,
//!   enabled) handled in main.rs `on_menu_event`; a `Page` is one of the page's commands (L5.9: the View menu's
//!   Command Palette ⌘K, the modes Script · Shoot · Edit · Review ⌘1 – ⌘4, the inspector ⌥⌘I), sent to the page as a
//!   `studio:command` event by `page_command_js` — its id one of the page's MENU_COMMANDS (ui-kit/commands.ts; a static
//!   test compares the two lists), always enabled (a command the page cannot run says so in its status bar); a `Std` is
//!   a macOS standard item (Edit's undo / copy / paste…, which reach the page's fields). L5.11a: the Scenario menu's
//!   Rehearse ⌘R, Capture ⇧⌘R, Render ⌘B and Stop ⌘. are page commands too (the page's command bus gives them to their
//!   owner: the status bar, a screen, a live recording); ⌘S and ⌘Enter stay the page's (desktop-config.test.ts pins it).
//! - `TITLE_BAR`: the standard macOS title bar (L5.9 shipped it: the overlay's drag band is BL-126); `Overlay` lets the
//!   page draw under a transparent title bar with the window buttons inset. `SHELL_FLAG_JS`, a constant main-frame init
//!   script, tells the page which one it is under (`window.__studioShell`): the page then keeps the buttons' room (80 px
//!   for the overlay) and binds no shortcut of its own (the menu's accelerators send the commands: a key never acts
//!   twice). Nothing goes from the page to the shell.

use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, LogicalPosition, TitleBarStyle, WebviewWindowBuilder, Wry};

/// The shell's own commands.
pub const OPEN_WORKSPACE: &str = "open-workspace";
pub const SHOW_WINDOW: &str = "show-window";
/// L5.16c, the Help menu: the Set-up sheet (a `studio:setup` page event, desktop_core::setup::setup_page_js), on the
/// command's section for Install / Uninstall the retake Command… (those two say "move the app" first when it runs from a
/// translocated copy, its disk image or /Volumes).
pub const SET_UP: &str = "set-up";
pub const CLI_INSTALL: &str = "cli-install";
pub const CLI_REMOVE: &str = "cli-remove";
/// L5.16d: Help › Check for Updates… (update.rs: an alert with the answer, or the Studio's update sheet).
pub const CHECK_UPDATES: &str = "check-updates";

/// A macOS standard item.
#[derive(Clone, Copy)]
pub enum Std {
    About,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    FullScreen,
    Minimize,
    Zoom,
}

pub enum Item {
    /// id, label (`{app}`: the app's name), accelerator, enabled.
    Cmd { id: &'static str, label: &'static str, accelerator: Option<&'static str>, enabled: bool },
    /// A page command: id (one of the page's MENU_COMMANDS), label, accelerator.
    Page { id: &'static str, label: &'static str, accelerator: Option<&'static str> },
    Std(Std),
    Separator,
}

/// The menu bar. The first menu's title is the app's name (macOS shows the app name there anyway).
pub const MENUS: &[(&str, &[Item])] = &[
    ("", &[Item::Std(Std::About), Item::Separator, Item::Std(Std::Hide), Item::Std(Std::HideOthers), Item::Std(Std::ShowAll), Item::Separator, Item::Std(Std::Quit)]),
    ("File", &[Item::Cmd { id: OPEN_WORKSPACE, label: "Open Workspace…", accelerator: Some("CmdOrCtrl+O"), enabled: true }, Item::Separator, Item::Std(Std::CloseWindow)]),
    // ⌘Z ⌘C ⌘V ⌘X ⌘A in the page's fields. No Reload item (critique M1: WKWebView never asks before leaving unsaved
    // text; ⌘R stays free for the redesign's Rehearse).
    ("Edit", &[Item::Std(Std::Undo), Item::Std(Std::Redo), Item::Separator, Item::Std(Std::Cut), Item::Std(Std::Copy), Item::Std(Std::Paste), Item::Std(Std::SelectAll)]),
    (
        "View",
        &[
            Item::Page { id: "palette", label: "Command Palette…", accelerator: Some("CmdOrCtrl+K") },
            Item::Separator,
            Item::Page { id: "mode-script", label: "Script", accelerator: Some("CmdOrCtrl+1") },
            Item::Page { id: "mode-shoot", label: "Shoot", accelerator: Some("CmdOrCtrl+2") },
            Item::Page { id: "mode-edit", label: "Edit", accelerator: Some("CmdOrCtrl+3") },
            Item::Page { id: "mode-review", label: "Review", accelerator: Some("CmdOrCtrl+4") },
            Item::Separator,
            Item::Page { id: "inspector", label: "Show or Hide Inspector", accelerator: Some("Alt+CmdOrCtrl+I") },
            Item::Separator,
            Item::Std(Std::FullScreen),
        ],
    ),
    // L5.11a: the scenario in context (the page says in its status bar why a command cannot act; menu state is BL-126).
    (
        "Scenario",
        &[
            Item::Page { id: "rehearse", label: "Rehearse", accelerator: Some("CmdOrCtrl+R") },
            Item::Page { id: "capture", label: "Capture", accelerator: Some("Shift+CmdOrCtrl+R") },
            Item::Page { id: "render", label: "Render", accelerator: Some("CmdOrCtrl+B") },
            Item::Separator,
            Item::Page { id: "stop", label: "Stop", accelerator: Some("CmdOrCtrl+.") },
        ],
    ),
    // ⌘0 brings back a window closed with ⌘W (review B M3: the Dock icon is the only other way; ⌘Tab shows no window).
    ("Window", &[Item::Std(Std::Minimize), Item::Std(Std::Zoom), Item::Separator, Item::Cmd { id: SHOW_WINDOW, label: "Show Studio Window", accelerator: Some("CmdOrCtrl+0"), enabled: true }]),
    // L5.16c: the installed app's set-up (the page says so in a development build: its server is no app's).
    (
        "Help",
        &[
            Item::Cmd { id: SET_UP, label: "Set Up {app}…", accelerator: None, enabled: true },
            Item::Cmd { id: CHECK_UPDATES, label: "Check for Updates…", accelerator: None, enabled: true },
            Item::Separator,
            Item::Cmd { id: CLI_INSTALL, label: "Install the retake Command…", accelerator: None, enabled: true },
            Item::Cmd { id: CLI_REMOVE, label: "Uninstall the retake Command…", accelerator: None, enabled: true },
        ],
    ),
];

pub fn build(app: &AppHandle, name: &str) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for (title, items) in MENUS {
        let built: Vec<Box<dyn IsMenuItem<Wry>>> = items
            .iter()
            .map(|i| -> tauri::Result<Box<dyn IsMenuItem<Wry>>> {
                Ok(match i {
                    Item::Cmd { id, label, accelerator, enabled } => Box::new(MenuItem::with_id(app, *id, label.replace("{app}", name), *enabled, *accelerator)?),
                    Item::Page { id, label, accelerator } => Box::new(MenuItem::with_id(app, *id, *label, true, *accelerator)?),
                    Item::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                    Item::Std(s) => Box::new(match s {
                        Std::About => PredefinedMenuItem::about(app, None, Some(AboutMetadata { name: Some(name.into()), version: Some(env!("CARGO_PKG_VERSION").into()), ..Default::default() }))?,
                        Std::Hide => PredefinedMenuItem::hide(app, None)?,
                        Std::HideOthers => PredefinedMenuItem::hide_others(app, None)?,
                        Std::ShowAll => PredefinedMenuItem::show_all(app, None)?,
                        Std::Quit => PredefinedMenuItem::quit(app, None)?,
                        Std::CloseWindow => PredefinedMenuItem::close_window(app, None)?,
                        Std::Undo => PredefinedMenuItem::undo(app, None)?,
                        Std::Redo => PredefinedMenuItem::redo(app, None)?,
                        Std::Cut => PredefinedMenuItem::cut(app, None)?,
                        Std::Copy => PredefinedMenuItem::copy(app, None)?,
                        Std::Paste => PredefinedMenuItem::paste(app, None)?,
                        Std::SelectAll => PredefinedMenuItem::select_all(app, None)?,
                        Std::FullScreen => PredefinedMenuItem::fullscreen(app, None)?,
                        Std::Minimize => PredefinedMenuItem::minimize(app, None)?,
                        Std::Zoom => PredefinedMenuItem::maximize(app, None)?,
                    }),
                })
            })
            .collect::<tauri::Result<_>>()?;
        let refs: Vec<&dyn IsMenuItem<Wry>> = built.iter().map(|b| b.as_ref()).collect();
        menu.append(&Submenu::with_items(app, if title.is_empty() { name } else { title }, true, &refs)?)?;
    }
    Ok(menu)
}

/// The title-bar style.
#[allow(dead_code)]
pub enum TitleBar {
    /// The standard macOS title bar (L5.2: today's Studio has no title-bar zone).
    Standard,
    /// A transparent title bar over the page, no title text, the window buttons at `buttons` (points from the top
    /// left). The page keeps its content clear of the buttons and marks its drag zone; WKWebView honours no
    /// `app-region` and Tauri's `data-tauri-drag-region` needs the page's IPC (refused here), so the redesign adds a
    /// native drag strip in the shell (DESIGN §4j).
    Overlay { buttons: (f64, f64) },
}

/// THE switch. L5.9 keeps the standard bar: an overlay needs a native drag band whose WebKit edge cases were not
/// proven (DESIGN §4j, BACKLOG BL-126); `TitleBar::Overlay { buttons: (16.0, 18.0) }` is the value that waits for it.
pub const TITLE_BAR: TitleBar = TitleBar::Standard;

/// The page's flag (main frame only, before the page's own scripts): which title bar it is under.
pub const SHELL_FLAG_JS: &str = match TITLE_BAR {
    TitleBar::Standard => "window.__studioShell = Object.freeze({ titleBar: 'standard' });",
    TitleBar::Overlay { .. } => "window.__studioShell = Object.freeze({ titleBar: 'overlay' });",
};

/// The script that sends a page command, for a `Page` id of `MENUS` only (anything else: None).
pub fn page_command_js(id: &str) -> Option<String> {
    let known = MENUS.iter().flat_map(|(_, items)| items.iter()).any(|i| matches!(i, Item::Page { id: p, .. } if *p == id));
    known.then(|| format!("window.dispatchEvent(new CustomEvent('studio:command', {{ detail: {{ id: {} }} }}))", desktop_core::json::quote(id)))
}

pub fn title_bar(b: WebviewWindowBuilder<'_, Wry, AppHandle>) -> WebviewWindowBuilder<'_, Wry, AppHandle> {
    match TITLE_BAR {
        TitleBar::Standard => b,
        TitleBar::Overlay { buttons: (x, y) } => b.title_bar_style(TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(LogicalPosition::new(x, y)),
    }
}
