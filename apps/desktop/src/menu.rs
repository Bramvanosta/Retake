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
//! - The shell's own items follow the shell: Check for Updates… by the update's state (update.rs `set`:
//!   desktop_core update_flow `menu_item`, fixed words, no version), Install / Uninstall the retake Command… by what is
//!   installed — the server's enum on the pipe (`cli`, read from the disk by the server, never the page's) and whether
//!   this is the installed app (desktop_core setup `cli_items`). Their labels stay the shell's.
//! - `CONTEXT_MENUS`: the context menus the page may ask for by id (`desktop_menu` {popup} → a `context` pipe line),
//!   each item a page command of MENUS with MENUS's label; shown only through the gate (desktop_core::menu: a real
//!   secondary click in the window's content, once, within 1.5 s — macos.rs's monitor records it) at that click's
//!   place, never while a question of the shell is up or off the Studio's origin. A pick sends `studio:command` with the
//!   menu's id beside the command's (`context_command_js`: a pair of the table only).
//! - Threads: every native item and every lock of this module is the main thread's — other threads queue a
//!   closure (`on_main`, fire-and-forget) and never wait.
//! - `TITLE_BAR`: the standard macOS title bar (the overlay's drag band is BL-126); `Overlay` lets the
//!   page draw under a transparent title bar with the window buttons inset. `SHELL_FLAG_JS`, a constant main-frame init
//!   script, tells the page which one it is under (`window.__studioShell`): the page then keeps the buttons' room (80 px
//!   for the overlay) and binds no shortcut of its own (the menu's accelerators send the commands: a key never acts
//!   twice).

use desktop_core::menu::ContextGate;
use desktop_core::setup::{cli_code, cli_from_code, cli_items, CliItems};
use desktop_core::update_flow::UpdateItem;
use desktop_core::{CliState, MenuItemState};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use tauri::menu::{AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, LogicalPosition, Manager, TitleBarStyle, WebviewWindowBuilder, Wry};

/// The shell's own commands.
pub const OPEN_WORKSPACE: &str = "open-workspace";
/// File › Show Workspace in Finder (the shell's own workspace path: no page input).
pub const SHOW_IN_FINDER: &str = "show-in-finder";
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
            // ⌘, — macOS's Settings key: the app's set-up is its settings.
            Item::Cmd { id: SET_UP, label: "Set Up {app}…", accelerator: Some("CmdOrCtrl+,"), enabled: true },
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
            Item::Cmd { id: SHOW_IN_FINDER, label: "Show Workspace in Finder", accelerator: None, enabled: true },
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
    // The keys of the menu bar and of the page; the installed app's command line — greyed in a developer build (its
    // server is no app's), then by what is installed (`shell_items`).
    (
        "Help",
        &[
            page("help-shortcuts", "Keyboard Shortcuts", None),
            Item::Separator,
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

/// The shell's own items that follow the shell's state (Check for Updates…, Install / Uninstall the retake
/// Command…), by id.
static SHELL_ITEMS: Mutex<Vec<(&'static str, MenuItem<Wry>)>> = Mutex::new(Vec::new());

/// What the shell's own items show, the latest value each (any thread stores it, the main thread reads it when it
/// shows them: a closure queued earlier never shows an older value over a newer one): the update's item and its
/// enabled bit (update_flow `UpdateItem::code`), the server's last word on the command's link (setup `cli_code`; 0:
/// not told by this session's server), whether this is the installed app.
static WANT_UPDATE: AtomicU8 = AtomicU8::new(UpdateItem::Check.code(true));
static WANT_CLI: AtomicU8 = AtomicU8::new(0);
static WANT_BUNDLED: AtomicBool = AtomicBool::new(false);
/// The last state logged (test mode; main thread).
static SHELL_LOGGED: Mutex<String> = Mutex::new(String::new());

/// The context menus the page may ask for, by id: page commands of MENUS (their labels are MENUS's), separators.
/// The page's own table (ui-kit/commands.ts CONTEXT_MENUS) is compared with this one by a static test.
pub const CONTEXT_MENUS: &[(&str, &[Option<&str>])] = &[
    // A scenario's poster (Productions, its smart groups): its modes, its review report and comments.
    ("scenario", &[Some("mode-script"), Some("mode-shoot"), Some("mode-edit"), Some("mode-review"), None, Some("go-report"), Some("go-comments")]),
];

/// The context menus, built once (`build`), by id.
static CONTEXT_BUILT: Mutex<Vec<(&'static str, Menu<Wry>)>> = Mutex::new(Vec::new());
/// The last secondary click in the window (macos.rs's monitor; main thread).
static GATE: Mutex<ContextGate> = Mutex::new(ContextGate::new());
/// A refused context request was logged (the next ones are not: a looping page writes no flood of lines).
static SAID_REFUSED: AtomicBool = AtomicBool::new(false);

fn locked<T>(m: &'static Mutex<T>) -> std::sync::MutexGuard<'static, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Every native item and every lock of this module is the main thread's: a Tauri menu setter called from
/// another thread waits for the main thread (`run_on_main_thread`, then a reply), so a thread that held PAGE_ITEMS
/// across one — the pipe reader's `apply`, before — froze the app against a click (`clicked`, main thread, the same
/// lock). The other threads only queue: `on_main` is fire-and-forget, the setters then run in place.
fn on_main(f: impl FnOnce() + Send + 'static) {
    if let Some(app) = crate::APP.get() {
        let _ = app.run_on_main_thread(f);
    }
}

/// The main thread's check, before a lock or a setter of this module (anything else is a bug: said, skipped).
fn main_thread(what: &str) -> bool {
    let ok = objc2::MainThreadMarker::new().is_some();
    if !ok {
        crate::log(&format!("menu: {what} off the main thread: skipped"));
    }
    ok
}

/// The window page's state of its commands (`desktop_menu`, a pipe line desktop_core checked): enabled, checked, which
/// of a toggle's two fixed labels. Ids the menu does not hold are ignored; a page command the page never names keeps its
/// last state (enabled at first). From any thread (the pipe reader): applied on the main thread.
pub fn apply(items: Vec<MenuItemState>) {
    on_main(move || {
        apply_now(&items);
        // Test mode: the page is up — RETAKE_DESKTOP_TEST_MENU's item, once (the menu-event path of a click).
        crate::test_menu_once();
    });
}

fn apply_now(items: &[MenuItemState]) {
    if !main_thread("apply") {
        return;
    }
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

/// A page command was clicked (main thread: `on_menu_event`): a check item gets back the check the page last said
/// (macOS toggled it; the page's next state, if the click changed anything, sets it again).
pub fn clicked(id: &str) {
    if !main_thread("clicked") {
        return;
    }
    if let Some((_, Handle::Check(c, checked))) = page_items().iter().find(|(i, _)| *i == id) {
        let _ = c.set_checked(*checked);
    }
}

/// The update's item changed (update.rs `set`, from any thread, only on a change): shown on the main thread.
pub fn update_item(item: UpdateItem, enabled: bool) {
    WANT_UPDATE.store(item.code(enabled), Ordering::SeqCst);
    on_main(shell_items_now);
}

/// The server's word on the command's link (child.rs, a `cli` pipe line), or None — a new session forgets the last
/// server's (main.rs `open`, before a server starts).
pub fn cli_state(state: Option<CliState>) {
    WANT_CLI.store(cli_code(state), Ordering::SeqCst);
    on_main(shell_items_now);
}

/// Whether this is the installed app (main.rs, once its launch config is read).
pub fn set_bundled(bundled: bool) {
    WANT_BUNDLED.store(bundled, Ordering::SeqCst);
    on_main(shell_items_now);
}

/// Show the shell's own items as the latest values say (main thread); test mode logs each change.
fn shell_items_now() {
    if !main_thread("shell_items") {
        return;
    }
    let (item, update_on) = UpdateItem::from_code(WANT_UPDATE.load(Ordering::SeqCst));
    let CliItems { install, install_label, remove } = cli_items(WANT_BUNDLED.load(Ordering::SeqCst), cli_from_code(WANT_CLI.load(Ordering::SeqCst)));
    for (id, it) in locked(&SHELL_ITEMS).iter() {
        let (text, on) = match *id {
            CHECK_UPDATES => (item.label(), update_on),
            CLI_INSTALL => (install_label.label(), install),
            CLI_REMOVE => ("Uninstall the retake Command…", remove),
            _ => continue,
        };
        let _ = it.set_text(text);
        let _ = it.set_enabled(on);
    }
    if crate::test_mode() {
        let onoff = |b: bool| if b { "on" } else { "off" };
        let line = format!("(test mode) shell menu: {CHECK_UPDATES} \"{}\" {}; {CLI_INSTALL} \"{}\" {}; {CLI_REMOVE} {}", item.label(), onoff(update_on), install_label.label(), onoff(install), onoff(remove));
        let mut logged = locked(&SHELL_LOGGED);
        if *logged != line {
            crate::log(&line);
            *logged = line;
        }
    }
}

/// A secondary click in the window's content (macos.rs's monitor, main thread), at this place.
pub fn secondary_clicked(at: (f64, f64)) {
    if !main_thread("secondary_clicked") {
        return;
    }
    locked(&GATE).clicked(crate::now_ms(), at);
}

/// A menu that is not ours began tracking (macos.rs's observer, main thread): the last click is used up — a page
/// asking now would stack our menu on WebKit's.
pub fn other_menu_began() {
    if !main_thread("other_menu_began") {
        return;
    }
    locked(&GATE).forget();
}

/// The page asks for context menu `id` (child.rs, a `context` pipe line): on the main thread, through the gate.
pub fn context(id: String) {
    on_main(move || popup_now(&id));
}

fn refused(why: &str) {
    if !SAID_REFUSED.swap(true, Ordering::SeqCst) {
        crate::log(&format!("context menu refused: {why} (the next refusals are not said)"));
    } else if crate::test_mode() {
        crate::log(&format!("(test mode) context menu refused: {why}"));
    }
}

/// On the main thread: show context menu `id` at the last secondary click — only once per click, within its reach,
/// never while a question of the shell is up, a signal asked to quit or the window is off the Studio's origin.
fn popup_now(id: &str) {
    if !main_thread("popup") {
        return;
    }
    let Some(app) = crate::APP.get() else { return };
    let Some(items) = CONTEXT_MENUS.iter().find(|(m, _)| *m == id).map(|(_, items)| *items) else { return refused("a menu this app does not have") };
    if crate::guard::GUARD_OPEN.load(Ordering::SeqCst) || crate::macos::modal_up() {
        return refused("another question is open");
    }
    if !crate::window_on_studio(app) {
        return refused("no Studio page in the window");
    }
    let mut at = locked(&GATE).take(crate::now_ms());
    if at.is_err() && crate::test_env("RETAKE_DESKTOP_TEST_RIGHT_CLICKS").and_then(|v| v.parse::<u32>().ok()).is_some_and(|n| n > TEST_CLICKS.fetch_add(1, Ordering::SeqCst)) {
        // Test mode: an armed right-click (one per menu), at a fixed place of the content.
        at = Ok((120.0, 160.0));
    }
    let (x, y) = match at {
        Ok(p) => p,
        Err(r) => return refused(r.words()),
    };
    let Some(menu) = locked(&CONTEXT_BUILT).iter().find(|(m, _)| *m == id).map(|(_, menu)| menu.clone()) else { return };
    let Some(w) = app.get_webview_window(crate::WINDOW) else { return };
    if crate::test_mode() {
        let labels: Vec<&str> = items.iter().flatten().filter_map(|c| label_of(c)).collect();
        crate::log(&format!("(test mode) context menu: {id} ({})", labels.join(", ")));
    }
    // Test mode picks an item (RETAKE_DESKTOP_TEST_CONTEXT_PICK: a command id of this menu) by its place.
    let pick = crate::test_env("RETAKE_DESKTOP_TEST_CONTEXT_PICK").and_then(|c| items.iter().position(|i| *i == Some(c.as_str()))).map(|i| i as isize);
    crate::macos::popup(
        || {
            let _ = w.popup_menu_at(&menu, LogicalPosition::new(x, y));
        },
        pick,
    );
}

/// Test mode's armed right-clicks used so far.
static TEST_CLICKS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// A page command's label in MENUS.
fn label_of(id: &str) -> Option<&'static str> {
    MENUS.iter().flat_map(|(_, items)| items.iter()).find_map(|i| match i {
        Item::Page { id: p, label, .. } if *p == id => Some(*label),
        _ => None,
    })
}

/// A context item's native id: `ctx:<menu>:<command>`.
fn context_item_id(menu: &str, command: &str) -> String {
    format!("ctx:{menu}:{command}")
}

/// The script that sends a context menu's pick: for a (menu, command) pair of CONTEXT_MENUS only (anything else:
/// None), both JSON-quoted into one constant shape.
pub fn context_command_js(native_id: &str) -> Option<String> {
    let rest = native_id.strip_prefix("ctx:")?;
    let (menu, command) = rest.split_once(':')?;
    let known = CONTEXT_MENUS.iter().any(|(m, items)| *m == menu && items.contains(&Some(command)));
    known.then(|| format!("window.dispatchEvent(new CustomEvent('studio:command', {{ detail: {{ id: {}, context: {} }} }}))", desktop_core::json::quote(command), desktop_core::json::quote(menu)))
}

pub fn build(app: &AppHandle, name: &str) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    let mut held: Vec<(&'static str, Handle)> = Vec::new();
    let mut shell: Vec<(&'static str, MenuItem<Wry>)> = Vec::new();
    for (title, items) in MENUS {
        let mut built: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::with_capacity(items.len());
        for i in items.iter() {
            built.push(match i {
                Item::Cmd { id, label, accelerator, enabled } => {
                    let item = MenuItem::with_id(app, *id, label.replace("{app}", name), *enabled, *accelerator)?;
                    if [CHECK_UPDATES, CLI_INSTALL, CLI_REMOVE].contains(id) {
                        shell.push((id, item.clone()));
                    }
                    Box::new(item)
                }
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
    *locked(&SHELL_ITEMS) = shell;
    // The context menus, once: no accelerators, MENUS's labels.
    let mut ctx: Vec<(&'static str, Menu<Wry>)> = Vec::new();
    for (id, items) in CONTEXT_MENUS {
        let m = Menu::new(app)?;
        for i in items.iter() {
            match i {
                Some(c) => m.append(&MenuItem::with_id(app, context_item_id(id, c), label_of(c).unwrap_or(c), true, None::<&str>)?)?,
                None => m.append(&PredefinedMenuItem::separator(app)?)?,
            }
        }
        ctx.push((id, m));
    }
    *locked(&CONTEXT_BUILT) = ctx;
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

/// The page's flag (main frame only, before the page's own scripts): which title bar it is under, and whether this is
/// a debug build (`inspect`: ⌥-right-click keeps WebKit's menu, its Inspect Element — context-menu.ts).
pub const SHELL_FLAG_JS: &str = match (&TITLE_BAR, cfg!(debug_assertions)) {
    (TitleBar::Standard, false) => "window.__studioShell = Object.freeze({ titleBar: 'standard' });",
    (TitleBar::Standard, true) => "window.__studioShell = Object.freeze({ titleBar: 'standard', inspect: true });",
    (TitleBar::Overlay { .. }, false) => "window.__studioShell = Object.freeze({ titleBar: 'overlay' });",
    (TitleBar::Overlay { .. }, true) => "window.__studioShell = Object.freeze({ titleBar: 'overlay', inspect: true });",
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
