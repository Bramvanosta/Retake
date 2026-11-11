//! The desktop shell's rules (L5.2, DESIGN §4j), kept free of Tauri and of any crate so that their tests run in the
//! default suite: the supervised line, the navigation allow-list, what may be printed, the launch config, the
//! workspace order, the remembered workspace and the stop sequence; L5.2b: the server's pipe lines (pipe), the words of
//! the quit question and the notifications (words), when a job end becomes a notification (notify); L5.12d: the quit
//! question's flow, page first and the native alert as the fallback (guard_flow); L5.16c: the installed app's first run
//! and Set-up sheet — where it runs from, the first-run alert, the `studio:setup` event, the lines for the server (setup);
//! L5.16d: the updater's rules — which build updates itself, when it checks, what an install waits for, the lines for
//! the server and the remembered checks (update_flow); BL-168: the restart after an update, once this process is gone
//! (relaunch).

pub mod config;
pub mod guard_flow;
pub mod json;
pub mod notify;
pub mod pipe;
pub mod relaunch;
pub mod rules;
pub mod setup;
pub mod stop;
pub mod update_flow;
pub mod words;

pub use config::{child_env_dropped, choose_workspace, launch_json_path, CHILD_ENV_DROPPED, test_mode_allowed, is_workspace, launch_config, not_workspace_text, read_remembered, retake_home, write_remembered, ConfigError, LaunchConfig, Source};
pub use rules::{is_ipc_noise, loopback_port, navigation_allowed, navigation_decision, origin, parse_ui_line, redact, route_ok, sanitize, Admit, Allowed, LineError, Navigation, RateLimit, UiLine};
pub use guard_flow::{Ask, Effect, Flow, Reply};
pub use notify::{Auth, AuthAnswer, AuthStep, Decision, Notifier, Permission};
pub use pipe::{parse_pipe_line, JobEnd, JobKind, Line, LineReader, Pending, PipeMsg, Reason, SetupAction, UnsavedKind, UpdateAction, PIPE_LINE_MAX};
pub use setup::{app_of_exe, install_location, FirstRun, InstallLocation};
pub use stop::{stop_child, Stopped};
pub use words::{guard_question, notification_text, quit_action, restart_buttons, restart_note, Action, Question, RestartButtons};

/// A fresh scratch folder for one test (under the system temporary folder).
#[cfg(test)]
pub(crate) fn test_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("desktop-core-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
