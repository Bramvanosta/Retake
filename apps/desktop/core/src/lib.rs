//! The desktop shell's rules (L5.2, DESIGN §4j), kept free of Tauri and of any crate so that their tests run in the
//! default suite: the supervised line, the navigation allow-list, what may be printed, the launch config, the
//! workspace order, the remembered workspace and the stop sequence.

pub mod config;
pub mod json;
pub mod rules;
pub mod stop;

pub use config::{child_env_dropped, choose_workspace, is_workspace, launch_config, read_remembered, studio_home, write_remembered, ConfigError, LaunchConfig, Source};
pub use rules::{is_ipc_noise, loopback_port, navigation_allowed, navigation_decision, origin, parse_ui_line, redact, route_ok, sanitize, Admit, Allowed, LineError, Navigation, RateLimit, UiLine};
pub use stop::{stop_child, Stopped};

/// A fresh scratch folder for one test (under the system temporary folder).
#[cfg(test)]
pub(crate) fn test_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("desktop-core-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
