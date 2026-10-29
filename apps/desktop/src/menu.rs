//! The window's chrome in one place (DESIGN §4j): the native menu, built from ONE command table, and the title-bar
//! style switch.
//!
//! - `MENUS`: every item of the menu bar, in order. A `Cmd` is the shell's own command (id, label, accelerator,
//!   enabled) handled in main.rs `on_menu_event`; a `Std` is a macOS standard item (Edit's undo / copy / paste…, which
//!   reach the page's fields). The redesign's command palette maps its commands onto this table (DESIGN §4j). The shell
//!   binds no Studio shortcut: ⌘R, ⇧⌘R, ⌘B, ⌘., ⌘S and ⌘Enter stay the page's (desktop-config.test.ts pins it).
//! - `TITLE_BAR`: the standard macOS title bar today; `Overlay` lets the page draw under a transparent title bar with
//!   the window buttons inset (the page must then provide the drag region and a left inset: DESIGN §4j).

use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, LogicalPosition, TitleBarStyle, WebviewWindowBuilder, Wry};

/// The shell's own commands.
pub const OPEN_WORKSPACE: &str = "open-workspace";
pub const SHOW_WINDOW: &str = "show-window";

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
    /// id, label, accelerator, enabled.
    Cmd { id: &'static str, label: &'static str, accelerator: Option<&'static str>, enabled: bool },
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
    ("View", &[Item::Std(Std::FullScreen)]),
    // ⌘0 brings back a window closed with ⌘W (review B M3: the Dock icon is the only other way; ⌘Tab shows no window).
    ("Window", &[Item::Std(Std::Minimize), Item::Std(Std::Zoom), Item::Separator, Item::Cmd { id: SHOW_WINDOW, label: "Show Studio Window", accelerator: Some("CmdOrCtrl+0"), enabled: true }]),
];

pub fn build(app: &AppHandle, name: &str) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for (title, items) in MENUS {
        let built: Vec<Box<dyn IsMenuItem<Wry>>> = items
            .iter()
            .map(|i| -> tauri::Result<Box<dyn IsMenuItem<Wry>>> {
                Ok(match i {
                    Item::Cmd { id, label, accelerator, enabled } => Box::new(MenuItem::with_id(app, *id, *label, *enabled, *accelerator)?),
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

/// THE switch: the redesign sets `TitleBar::Overlay { buttons: (16.0, 20.0) }` (DESIGN §4j).
pub const TITLE_BAR: TitleBar = TitleBar::Standard;

pub fn title_bar(b: WebviewWindowBuilder<'_, Wry, AppHandle>) -> WebviewWindowBuilder<'_, Wry, AppHandle> {
    match TITLE_BAR {
        TitleBar::Standard => b,
        TitleBar::Overlay { buttons: (x, y) } => b.title_bar_style(TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(LogicalPosition::new(x, y)),
    }
}
