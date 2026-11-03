//! Which Node runs which CLI (`launch.json`, written by `pnpm desktop:build`) with which environment, which workspace
//! opens, and the remembered one (`<Retake home>/desktop.json`).

use crate::json::{self, Json};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// What the app runs: `node <cli> --root <workspace> ui --supervised`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchConfig {
    pub node: PathBuf,
    pub cli: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    /// No launch.json where the app looks (a bare binary, or a moved app).
    Missing(PathBuf),
    Invalid(String),
    /// A path that is not absolute, or not a regular file (`what`: node / cli).
    BadPath { what: &'static str, path: String, why: &'static str },
    /// Only one of RETAKE_NODE / RETAKE_CLI.
    HalfEnv,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Missing(p) => write!(f, "{} is missing: build the app with pnpm desktop:build (or run pnpm desktop:dev)", p.display()),
            ConfigError::Invalid(e) => write!(f, "launch.json is not valid ({e}): build the app again with pnpm desktop:build"),
            ConfigError::BadPath { what, path, why } => write!(
                f,
                "the {what} this app runs ({path}) {why}: run pnpm build and pnpm desktop:build again in the repository (the Node.js that builds it is the one the app runs)"
            ),
            ConfigError::HalfEnv => write!(f, "set both RETAKE_NODE and RETAKE_CLI, or neither"),
        }
    }
}

fn check(what: &'static str, p: &str) -> Result<PathBuf, ConfigError> {
    let bad = |why| ConfigError::BadPath { what, path: p.to_string(), why };
    let path = Path::new(p);
    if p.contains('\0') || !path.is_absolute() {
        return Err(bad("is not an absolute path"));
    }
    match fs::metadata(path) {
        Ok(m) if m.is_file() => Ok(path.to_path_buf()),
        Ok(_) => Err(bad("is not a file")),
        Err(_) => Err(bad("does not exist")),
    }
}

/// The launch config: the environment's `RETAKE_NODE` / `RETAKE_CLI` when `allow_env` (debug builds only:
/// a Finder-launched release app never takes them from `launchctl setenv`), else `launch_json`
/// (`{"version":1,"node":…,"cli":…}`). Both paths absolute, regular files.
pub fn launch_config(env_node: Option<&str>, env_cli: Option<&str>, allow_env: bool, launch_json: &Path) -> Result<LaunchConfig, ConfigError> {
    let env_node = env_node.filter(|s| !s.is_empty());
    let env_cli = env_cli.filter(|s| !s.is_empty());
    if allow_env {
        match (env_node, env_cli) {
            (Some(n), Some(c)) => return Ok(LaunchConfig { node: check("node", n)?, cli: check("cli", c)? }),
            (None, None) => {}
            _ => return Err(ConfigError::HalfEnv),
        }
    }
    let text = match fs::read_to_string(launch_json) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(ConfigError::Missing(launch_json.to_path_buf())),
        Err(e) => return Err(ConfigError::Invalid(e.to_string())),
    };
    let v = json::parse(&text).map_err(ConfigError::Invalid)?;
    if v.get("version").and_then(|x| x.as_uint(1000)) != Some(1) {
        return Err(ConfigError::Invalid("version is not 1".into()));
    }
    let field = |k: &str| v.get(k).and_then(Json::as_str).ok_or_else(|| ConfigError::Invalid(format!("no {k}")));
    let (node, cli) = (field("node")?, field("cli")?);
    Ok(LaunchConfig { node: check("node", node)?, cli: check("cli", cli)? })
}

/// Whether RETAKE_DESKTOP_TEST (its value `var`) puts the shell in test mode (L5.2b review A L2): `1`, and a parent
/// other than launchd (`parent_pid` 1: a Finder or Dock launch, which `launchctl setenv` could otherwise arm — no
/// question asked, notifications never posted, SIGUSR2 a quit). A test or a terminal starts the binary itself.
pub fn test_mode_allowed(var: Option<&str>, parent_pid: i32) -> bool {
    var == Some("1") && parent_pid != 1
}

/// Whether a release build drops this variable from the child's environment (review A L4): what makes Node.js or the
/// dynamic linker load code — `NODE_OPTIONS` (`--require`, `--import`…), `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`,
/// `DYLD_*`, `LD_PRELOAD` / `LD_LIBRARY_PATH` / `LD_AUDIT` — which a Finder launch would otherwise take from
/// `launchctl setenv`. Not an allow-list: the rest stays, as for `retake ui` in a terminal (an automated sign-in's
/// `{{env:NAME}}` secrets come from the environment the worker inherits).
pub fn child_env_dropped(name: &str) -> bool {
    matches!(name, "NODE_OPTIONS" | "NODE_PATH" | "NODE_REPL_EXTERNAL_MODULE" | "LD_PRELOAD" | "LD_LIBRARY_PATH" | "LD_AUDIT") || name.starts_with("DYLD_")
}

/// The CLI's own rule (`workspaceRoot`): a `retake.yaml`, or a `projects/` folder.
pub fn is_workspace(dir: &Path) -> bool {
    dir.join("retake.yaml").exists() || dir.join("projects").is_dir()
}

/// The workspace file before L5.13 (the CLI's core legacy.ts names it too): only named in the hint below.
const OLD_WORKSPACE_FILE: &str = "studio.yaml"; // old-name: the hint of a folder whose workspace file is the old one

/// The alert of File › Open Workspace… for a folder that is no workspace (L5.13a review A L6): one that holds the old
/// workspace file is told to rename it, as the CLI says.
pub fn not_workspace_text(dir: &Path) -> String {
    let d = dir.display();
    if dir.join(OLD_WORKSPACE_FILE).is_file() {
        return format!(
            "{d} has no retake.yaml or projects/ folder. Its {OLD_WORKSPACE_FILE}, if it is this tool's workspace file from before the rename, is not read any more: rename it retake.yaml, then open the folder again. The workspace open now stays open."
        );
    }
    format!("{d} has no retake.yaml or projects/ folder. The workspace open now stays open.")
}

/// Where the workspace came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Arg,
    Env,
    Remembered,
    Cwd,
    Picker,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Arg => "--root",
            Source::Env => "RETAKE_ROOT",
            Source::Remembered => "the last one opened",
            Source::Cwd => "the current folder",
            Source::Picker => "chosen",
        }
    }
}

/// The workspace to open first: `--root`, else `RETAKE_ROOT`, else the remembered one (still a folder), else the
/// current folder when it holds a `retake.yaml`; None: ask with the folder picker. The CLI decides whether it is a
/// workspace (`{"type":"error","code":"no_workspace"}`, exit 2 otherwise); File › Open Workspace… checks
/// `is_workspace` before it stops anything.
pub fn choose_workspace(arg: Option<&str>, env: Option<&str>, remembered: Option<PathBuf>, cwd: Option<&Path>) -> Option<(PathBuf, Source)> {
    if let Some(a) = arg.filter(|s| !s.trim().is_empty()) {
        return Some((PathBuf::from(a), Source::Arg));
    }
    if let Some(e) = env.filter(|s| !s.trim().is_empty()) {
        return Some((PathBuf::from(e.trim()), Source::Env));
    }
    if let Some(r) = remembered.filter(|r| r.is_dir()) {
        return Some((r, Source::Remembered));
    }
    if let Some(c) = cwd.filter(|c| c.join("retake.yaml").is_file()) {
        return Some((c.to_path_buf(), Source::Cwd));
    }
    None
}

/// The Retake home, as the CLI computes it: `RETAKE_HOME` (trimmed, `~` expanded, made absolute), else
/// `~/.retake`.
pub fn retake_home(env_home: Option<&str>, home: Option<&str>, cwd: Option<&Path>) -> Option<PathBuf> {
    let home = home.filter(|h| !h.is_empty()).map(PathBuf::from);
    match env_home.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => {
            let p = if v == "~" {
                home?
            } else if let Some(rest) = v.strip_prefix("~/") {
                home?.join(rest)
            } else {
                PathBuf::from(v)
            };
            if p.is_absolute() {
                Some(p)
            } else {
                Some(cwd?.join(p))
            }
        }
        None => Some(home?.join(".retake")),
    }
}

pub const REMEMBERED_FILE: &str = "desktop.json";

/// The workspace remembered in `<home>/desktop.json` (`{"version":1,"workspace":…}`), when it is an absolute path.
pub fn read_remembered(home: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(home.join(REMEMBERED_FILE)).ok()?;
    let v = json::parse(&text).ok()?;
    if v.get("version").and_then(|x| x.as_uint(1000)) != Some(1) {
        return None;
    }
    let p = PathBuf::from(v.get("workspace")?.as_str()?);
    p.is_absolute().then_some(p)
}

/// Remember `workspace` (absolute, UTF-8): `<home>/desktop.json`, mode 0600, written to a temporary file then renamed
/// (the home is created 0700 when missing).
pub fn write_remembered(home: &Path, workspace: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let ws = workspace.to_str().filter(|_| workspace.is_absolute()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not an absolute UTF-8 path"))?;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(home)?;
    let tmp = home.join(format!(".{REMEMBERED_FILE}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        f.write_all(format!("{{\"version\":1,\"workspace\":{}}}\n", json::quote(ws)).as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, home.join(REMEMBERED_FILE))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn test_mode_needs_its_variable_and_a_parent_other_than_launchd() {
        assert!(test_mode_allowed(Some("1"), 4242));
        assert!(!test_mode_allowed(Some("1"), 1));
        assert!(!test_mode_allowed(Some("0"), 4242));
        assert!(!test_mode_allowed(Some("true"), 4242));
        assert!(!test_mode_allowed(None, 4242));
    }

    #[test]
    fn launch_config_from_launch_json_and_debug_env() {
        let d = test_dir("launch");
        let node = d.join("node");
        let cli = d.join("bin.js");
        fs::write(&node, "").unwrap();
        fs::write(&cli, "").unwrap();
        let lj = d.join("launch.json");
        assert_eq!(launch_config(None, None, false, &lj), Err(ConfigError::Missing(lj.clone())));
        fs::write(&lj, format!("{{\"version\":1,\"node\":{},\"cli\":{}}}", json::quote(node.to_str().unwrap()), json::quote(cli.to_str().unwrap()))).unwrap();
        let want = LaunchConfig { node: node.clone(), cli: cli.clone() };
        assert_eq!(launch_config(None, None, false, &lj).unwrap(), want);
        // The environment wins in debug builds only.
        let other = d.join("other-node");
        fs::write(&other, "").unwrap();
        let (o, c) = (other.to_str().unwrap(), cli.to_str().unwrap());
        assert_eq!(launch_config(Some(o), Some(c), false, &lj).unwrap(), want);
        assert_eq!(launch_config(Some(o), Some(c), true, &lj).unwrap(), LaunchConfig { node: other.clone(), cli: cli.clone() });
        assert_eq!(launch_config(Some(o), None, true, &lj), Err(ConfigError::HalfEnv));
        assert!(matches!(launch_config(Some("node"), Some(c), true, &lj), Err(ConfigError::BadPath { why: "is not an absolute path", .. })));
        assert!(matches!(launch_config(Some(d.to_str().unwrap()), Some(c), true, &lj), Err(ConfigError::BadPath { why: "is not a file", .. })));
        assert!(matches!(launch_config(Some("/nonexistent/node"), Some(c), true, &lj), Err(ConfigError::BadPath { why: "does not exist", .. })));
        for bad in ["{}", "{\"version\":2,\"node\":\"/x\",\"cli\":\"/y\"}", "{\"version\":1,\"node\":\"/x\"}", "not json"] {
            fs::write(&lj, bad).unwrap();
            assert!(matches!(launch_config(None, None, false, &lj), Err(ConfigError::Invalid(_))), "{bad}");
        }
        fs::write(&lj, "{\"version\":1,\"node\":\"relative/node\",\"cli\":\"/y\"}").unwrap();
        assert!(matches!(launch_config(None, None, false, &lj), Err(ConfigError::BadPath { what: "node", .. })));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn workspace_order_arg_env_remembered_cwd_then_picker() {
        let d = test_dir("order");
        let (rem, cwd) = (d.join("rem"), d.join("cwd"));
        fs::create_dir_all(&rem).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::write(cwd.join("retake.yaml"), "").unwrap();
        let r = || Some(rem.clone());
        assert_eq!(choose_workspace(Some("/a"), Some("/b"), r(), Some(&cwd)), Some((PathBuf::from("/a"), Source::Arg)));
        assert_eq!(choose_workspace(Some(" "), Some("/b"), r(), Some(&cwd)), Some((PathBuf::from("/b"), Source::Env)));
        assert_eq!(choose_workspace(None, Some(""), r(), Some(&cwd)), Some((rem.clone(), Source::Remembered)));
        assert_eq!(choose_workspace(None, None, Some(d.join("gone")), Some(&cwd)), Some((cwd.clone(), Source::Cwd)));
        assert_eq!(choose_workspace(None, None, None, Some(&rem)), None);
        assert_eq!(choose_workspace(None, None, None, None), None);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_workspace_has_retake_yaml_or_projects_like_the_cli() {
        let d = test_dir("is-ws");
        assert!(!is_workspace(&d));
        fs::write(d.join("projects"), "").unwrap();
        assert!(!is_workspace(&d), "a projects file is no folder");
        fs::remove_file(d.join("projects")).unwrap();
        fs::create_dir(d.join("projects")).unwrap();
        assert!(is_workspace(&d));
        let y = d.join("y");
        fs::create_dir(&y).unwrap();
        fs::write(y.join("retake.yaml"), "").unwrap();
        assert!(is_workspace(&y));
        assert!(!is_workspace(&d.join("missing")));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_folder_with_the_old_workspace_file_is_told_to_rename_it() {
        let d = test_dir("old-ws");
        assert_eq!(not_workspace_text(&d), format!("{} has no retake.yaml or projects/ folder. The workspace open now stays open.", d.display()));
        fs::write(d.join(OLD_WORKSPACE_FILE), "version: 1\n").unwrap();
        assert!(!is_workspace(&d), "the old file alone is no workspace: nothing reads it");
        let text = not_workspace_text(&d);
        assert!(text.contains(&format!("Its {OLD_WORKSPACE_FILE}, if it is this tool's workspace file from before the rename, is not read any more: rename it retake.yaml")), "{text}");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_release_child_never_gets_a_code_loader_variable() {
        for v in ["NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT"] {
            assert!(child_env_dropped(v), "{v}");
        }
        for v in ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "RETAKE_HOME", "RETAKE_ROOT", "SHOP_TOKEN", "NODE_ENV", "node_options"] {
            assert!(!child_env_dropped(v), "{v}");
        }
    }

    #[test]
    fn retake_home_like_the_cli() {
        let cwd = Path::new("/w");
        assert_eq!(retake_home(None, Some("/Users/u"), Some(cwd)), Some(PathBuf::from("/Users/u/.retake")));
        assert_eq!(retake_home(Some("  "), Some("/Users/u"), Some(cwd)), Some(PathBuf::from("/Users/u/.retake")));
        assert_eq!(retake_home(Some("~/h"), Some("/Users/u"), Some(cwd)), Some(PathBuf::from("/Users/u/h")));
        assert_eq!(retake_home(Some("/abs/h "), None, None), Some(PathBuf::from("/abs/h")));
        assert_eq!(retake_home(Some("rel"), Some("/Users/u"), Some(cwd)), Some(PathBuf::from("/w/rel")));
        assert_eq!(retake_home(None, None, Some(cwd)), None);
    }

    #[test]
    fn desktop_json_is_written_0600_atomically_and_read_back() {
        let d = test_dir("remember");
        let home = d.join("home");
        assert_eq!(read_remembered(&home), None);
        let ws = d.join("My \"Workspace\" é");
        write_remembered(&home, &ws).unwrap();
        let f = home.join(REMEMBERED_FILE);
        assert_eq!(fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&home).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(read_remembered(&home), Some(ws.clone()));
        // Replaced, never appended; no temporary file left.
        write_remembered(&home, Path::new("/other")).unwrap();
        assert_eq!(read_remembered(&home), Some(PathBuf::from("/other")));
        assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
        assert!(write_remembered(&home, Path::new("relative")).is_err());
        fs::write(&f, "{\"version\":1,\"workspace\":\"relative\"}").unwrap();
        assert_eq!(read_remembered(&home), None);
        fs::remove_dir_all(&d).unwrap();
    }
}
