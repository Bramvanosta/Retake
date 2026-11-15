//! The window's chrome in one place (DESIGN §4j): the native menu, built from ONE command table, and the title-bar
//! style switch.
//!
//! - `MENUS`: every item of the menu bar, in order, laid out as macOS apps do (the app menu with About, Check for
//!   Updates…, Set Up…, Services, Hide, Quit; File, Edit, View, Go, Scenario; Window — the app's windows menu — and
//!   Help — its help menu: macOS adds the search field that finds any item). A `Cmd` is the shell's own command (id,
//!   label, accelerator, enabled) handled in main.rs `on_menu_event`; a `Page` is one of the page's commands, sent to the
//!   page as a `studio:command` event by `page_command_js` — its id one of the page's MENU_COMMANDS (ui-kit/commands.ts;
//!   a static test compares the two lists); a `Std` is a macOS standard item (Edit's undo / copy / paste…, which reach
//!   the page's fields). A page command is a plain item, a check item (the mode or view shown) or a toggle (two fixed
//!   labels: Show / Hide Inspector). The Scenario menu's Rehearse ⌘R, Capture ⇧⌘R, Render ⌘B and Stop ⌘. are page
//!   commands too (the page's command bus gives them to their owner: the status bar, a screen, a live recording); ⌘S
//!   and ⌘Enter stay the page's (desktop-config.test.ts pins it).
//! - The menu follows the page (on Ranch's model: the menu shows what can run now): the window page sends its
//!   commands' state through the server's `desktop_menu` op, one strict pipe line (desktop_core pipe.rs: ids, bools, a
//!   0 / 1 variant — never text), and `apply` greys out, checks or relabels the items it holds. Until the page says
//!   otherwise every page command is enabled (a command the page cannot run says so in its status bar).
//! - `TITLE_BAR`: the standard macOS title bar (the overlay's drag band is BL-126); `Overlay` lets the
//!   page draw under a transparent title bar with the window buttons inset. `SHELL_FLAG_JS`, a constant main-frame init
//!   script, tells the page which one it is under (`window.__studioShell`): the page then keeps the buttons' room (80 px
//!   for the overlay) and binds no shortcut of its own (the menu's accelerators send the commands: a key never acts
//!   twice).

use desktop_core::MenuItemState;
use std::sync::Mutex;
use tauri::menu::{AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, LogicalPosition, TitleBarStyle, WebviewWindowBuilder, Wry};

/// The shell's own commands.
pub const OPEN_WORKSPACE: &str = "open-workspace";
pub const SHOW_WINDOW: &str = "show-window";
/// The Help menu: the Set-up sheet (a `studio:setup` page event, desktop_core::setup::setup_page_js), on the
/// command's section for Install / Uninstall the retake Command… (those two say "move the app" first when it runs from a
/// translocated copy, its disk image or /Volumes).
pub const SET_UP: &str = "set-up";
pub const CLI_INSTALL: &str = "cli-install";
pub const CLI_REMOVE: &str = "cli-remove";
/// Help › Check for Updates… (update.rs: an alert with the answer, or the Studio's update sheet).
pub const CHECK_UPDATES: &str = "check-updates";

/// A macOS standard item.
#[derive(Clone, Copy)]
pub enum Std {
    About,
    Services,
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
    BringAllToFront,
}

/// How a page command shows in the menu: a plain item, a check item (the current mode or view), or a toggle (two
/// fixed labels: the page picks one by `variant`, never its text).
#[derive(Clone, Copy)]
pub enum Kind {
    Plain,
    Check,
    Toggle(&'static str),
}

pub enum Item {
    /// id, label (`{app}`: the app's name), accelerator, enabled.
    Cmd { id: &'static str, label: &'static str, accelerator: Option<&'static str>, enabled: bool },
    /// A page command: id (one of the page's MENU_COMMANDS), label, accelerator, kind. Enabled until the page says
    /// otherwise (`desktop_menu` through the pipe: `apply`).
    Page { id: &'static str, label: &'static str, accelerator: Option<&'static str>, kind: Kind },
    Std(Std),
    Separator,
}

const fn page(id: &'static str, label: &'static str, accelerator: Option<&'static str>) -> Item {
    Item::Page { id, label, accelerator, kind: Kind::Plain }
}
const fn check(id: &'static str, label: &'static str, accelerator: Option<&'static str>) -> Item {
    Item::Page { id, label, accelerator, kind: Kind::Check }
}

/// The menu bar, as macOS apps lay it out. The first menu's title is the app's name (macOS shows the app name there
/// anyway). The Window menu is the app's windows menu (macOS lists the windows under it) and the Help menu its help menu
/// (macOS adds its search field: it finds any item of the bar).
pub const MENUS: &[(&str, &[Item])] = &[
    (
        "",
        &[
            Item::Std(Std::About),
            Item::Separator,
            Item::Cmd { id: CHECK_UPDATES, label: "Check for Updates…", accelerator: None, enabled: true },
            Item::Cmd { id: SET_UP, label: "Set Up {app}…", accelerator: None, enabled: true },
            Item::Separator,
            Item::Std(Std::Services),
            Item::Separator,
            Item::Std(Std::Hide),
            Item::Std(Std::HideOthers),
            Item::Std(Std::ShowAll),
            Item::Separator,
            Item::Std(Std::Quit),
        ],
    ),
    (
        "File",
        &[
            page("new-scenario", "New Scenario…", Some("CmdOrCtrl+N")),
            Item::Cmd { id: OPEN_WORKSPACE, label: "Open Workspace…", accelerator: Some("CmdOrCtrl+O"), enabled: true },
            Item::Separator,
            Item::Std(Std::CloseWindow),
        ],
    ),
    // ⌘Z ⌘C ⌘V ⌘X ⌘A in the page's fields. No Reload item (WKWebView never asks before leaving unsaved text; ⌘R
    // is Rehearse).
    ("Edit", &[Item::Std(Std::Undo), Item::Std(Std::Redo), Item::Separator, Item::Std(Std::Cut), Item::Std(Std::Copy), Item::Std(Std::Paste), Item::Std(Std::SelectAll)]),
    (
        "View",
        &[
            page("palette", "Command Palette…", Some("CmdOrCtrl+K")),
            Item::Separator,
            check("mode-script", "Script", Some("CmdOrCtrl+1")),
            check("mode-shoot", "Shoot", Some("CmdOrCtrl+2")),
            check("mode-edit", "Edit", Some("CmdOrCtrl+3")),
            check("mode-review", "Review", Some("CmdOrCtrl+4")),
            Item::Separator,
            check("view-board", "Board", Some("Alt+CmdOrCtrl+1")),
            check("view-hooks", "Hooks", Some("Alt+CmdOrCtrl+2")),
            check("view-yaml", "YAML", Some("Alt+CmdOrCtrl+3")),
            Item::Separator,
            Item::Page { id: "inspector", label: "Show Inspector", accelerator: Some("Alt+CmdOrCtrl+I"), kind: Kind::Toggle("Hide Inspector") },
            Item::Separator,
            Item::Std(Std::FullScreen),
        ],
    ),
    // Where to go: back and forward in the page's history, the workspace, the open project's pages, the scenario's.
    (
        "Go",
        &[
            page("go-back", "Back", Some("CmdOrCtrl+[")),
            page("go-forward", "Forward", Some("CmdOrCtrl+]")),
            Item::Separator,
            page("go-welcome", "Welcome", Some("Shift+CmdOrCtrl+H")),
            Item::Separator,
            page("go-productions", "Productions", Some("Shift+CmdOrCtrl+P")),
            page("go-cast", "Locations and Cast", None),
            page("go-settings", "Project Settings", None),
            page("go-readme", "README", None),
            Item::Separator,
            page("go-library", "Components", None),
            page("go-themes", "Themes", None),
            Item::Separator,
            page("go-report", "Review Report", None),
            page("go-comments", "Comments", None),
        ],
    ),
    // The scenario in context: each item enabled while the page can run it (its status bar says why otherwise).
    (
        "Scenario",
        &[
            page("rehearse", "Rehearse", Some("CmdOrCtrl+R")),
            page("capture", "Capture", Some("Shift+CmdOrCtrl+R")),
            page("render", "Render", Some("CmdOrCtrl+B")),
            Item::Separator,
            page("stop", "Stop", Some("CmdOrCtrl+.")),
        ],
    ),
    // ⌘0 brings back a window closed with ⌘W (the Dock icon is the only other way; ⌘Tab shows no window).
    (
        "Window",
        &[
            Item::Std(Std::Minimize),
            Item::Std(Std::Zoom),
            Item::Separator,
            Item::Cmd { id: SHOW_WINDOW, label: "Show Studio Window", accelerator: Some("CmdOrCtrl+0"), enabled: true },
            Item::Separator,
            Item::Std(Std::BringAllToFront),
        ],
    ),
    // The installed app's command line (the page says so in a development build: its server is no app's).
    (
        "Help",
        &[
            Item::Cmd { id: CLI_INSTALL, label: "Install the retake Command…", accelerator: None, enabled: true },
            Item::Cmd { id: CLI_REMOVE, label: "Uninstall the retake Command…", accelerator: None, enabled: true },
        ],
    ),
];

/// A page command's native item, kept to follow the page's state.
enum Handle {
    Item { item: MenuItem<Wry>, label: &'static str, alt: Option<&'static str> },
    /// Its item and the check the page last said (a click toggles it natively: `clicked` puts it back).
    Check(CheckMenuItem<Wry>, bool),
}

/// The page commands' items of the menu built (`build`), by id.
static PAGE_ITEMS: Mutex<Vec<(&'static str, Handle)>> = Mutex::new(Vec::new());

fn page_items() -> std::sync::MutexGuard<'static, Vec<(&'static str, Handle)>> {
    PAGE_ITEMS.lock().unwrap_or_else(|e| e.into_inner())
}

/// The window page's state of its commands (`desktop_menu`, a pipe line desktop_core checked): enabled, checked, which
/// of a toggle's two fixed labels. Ids the menu does not hold are ignored; a page command the page never names keeps its
/// last state (enabled at first).
pub fn apply(items: &[MenuItemState]) {
    if crate::test_mode() {
        let ids = |f: &dyn Fn(&MenuItemState) -> bool| items.iter().filter(|i| f(i)).map(|i| i.id.as_str()).collect::<Vec<_>>().join(", ");
        crate::log(&format!("(test mode) menu: {} items; checked: {}; disabled: {}", items.len(), ids(&|i| i.checked == Some(true)), ids(&|i| !i.enabled)));
    }
    let mut held = page_items();
    for st in items {
        let Some((_, h)) = held.iter_mut().find(|(id, _)| *id == st.id) else { continue };
        match h {
            Handle::Item { item, label, alt } => {
                let _ = item.set_enabled(st.enabled);
                if let Some(alt) = alt {
                    let _ = item.set_text(if st.variant == 1 { *alt } else { *label });
                }
            }
            Handle::Check(c, checked) => {
                *checked = st.checked.unwrap_or(false);
                let _ = c.set_enabled(st.enabled);
                let _ = c.set_checked(*checked);
            }
        }
    }
}

/// A page command was clicked: a check item gets back the check the page last said (macOS toggled it; the page's next
/// state, if the click changed anything, sets it again).
pub fn clicked(id: &str) {
    if let Some((_, Handle::Check(c, checked))) = page_items().iter().find(|(i, _)| *i == id) {
        let _ = c.set_checked(*checked);
    }
}

pub fn build(app: &AppHandle, name: &str) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    let mut held: Vec<(&'static str, Handle)> = Vec::new();
    for (title, items) in MENUS {
        let mut built: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::with_capacity(items.len());
        for i in items.iter() {
            built.push(match i {
                Item::Cmd { id, label, accelerator, enabled } => Box::new(MenuItem::with_id(app, *id, label.replace("{app}", name), *enabled, *accelerator)?),
                Item::Page { id, label, accelerator, kind: Kind::Check } => {
                    let c = CheckMenuItem::with_id(app, *id, *label, true, false, *accelerator)?;
                    held.push((id, Handle::Check(c.clone(), false)));
                    Box::new(c)
                }
                Item::Page { id, label, accelerator, kind } => {
                    let item = MenuItem::with_id(app, *id, *label, true, *accelerator)?;
                    let alt = if let Kind::Toggle(alt) = kind { Some(*alt) } else { None };
                    held.push((id, Handle::Item { item: item.clone(), label, alt }));
                    Box::new(item)
                }
                Item::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                Item::Std(s) => Box::new(match s {
                    Std::About => PredefinedMenuItem::about(app, None, Some(AboutMetadata { name: Some(name.into()), version: Some(env!("CARGO_PKG_VERSION").into()), ..Default::default() }))?,
                    Std::Services => PredefinedMenuItem::services(app, None)?,
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
                    Std::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, None)?,
                }),
            });
        }
        let refs: Vec<&dyn IsMenuItem<Wry>> = built.iter().map(|b| b.as_ref()).collect();
        let sub = Submenu::with_items(app, if title.is_empty() { name } else { title }, true, &refs)?;
        menu.append(&sub)?;
        // macOS's own menus: the window list under Window, the search field under Help.
        if *title == "Window" {
            sub.set_as_windows_menu_for_nsapp()?;
        } else if *title == "Help" {
            sub.set_as_help_menu_for_nsapp()?;
        }
    }
    *page_items() = held;
    Ok(menu)
}

/// The title-bar style.
#[allow(dead_code)]
pub enum TitleBar {
    /// The standard macOS title bar (today's Studio has no title-bar zone).
    Standard,
    /// A transparent title bar over the page, no title text, the window buttons at `buttons` (points from the top
    /// left). The page keeps its content clear of the buttons and marks its drag zone; WKWebView honours no
    /// `app-region` and Tauri's `data-tauri-drag-region` needs the page's IPC (refused here), so the redesign adds a
    /// native drag strip in the shell (DESIGN §4j).
    Overlay { buttons: (f64, f64) },
}

/// THE switch. The standard bar stays: an overlay needs a native drag band whose WebKit edge cases were not
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
