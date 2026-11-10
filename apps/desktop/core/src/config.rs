//! Which Node runs which CLI (`launch.json`: version 1 written by `pnpm desktop:build`, the developer app; version 2
//! by `pnpm desktop:bundle`, the bundled app — L5.16) with which environment, which workspace opens, and the remembered
//! one (`<Retake home>/desktop.json`).

use crate::json::{self, Json};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// What the app runs: `node [--require <preload>] <cli> --root <workspace> ui --supervised`. `bundled`: the Node.js and
/// the engine are the app's own (launch.json version 2) — the words then say "reinstall Retake", never a repository
/// command. `preload`: the app's module lookup guard (version 2 only: Resources/node/guard.cjs — the app's code never
/// resolves a module from a node_modules folder above the app; given as an argument, NODE_OPTIONS being dropped).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchConfig {
    pub node: PathBuf,
    pub cli: PathBuf,
    pub bundled: bool,
    pub preload: Option<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    /// No launch.json where the app looks (a bare binary, or a moved app). The bool: the folder is a bundled app's
    /// (a `bundle.json` beside where launch.json should be) — its words name the disk image only, never pnpm.
    Missing(PathBuf, bool),
    /// launch.json unreadable or malformed (the bool: as for Missing, or a version 2 file).
    Invalid(String, bool),
    /// A path that is not absolute (version 1) or not relative inside the app (version 2), or not a regular file
    /// (`what`: node / cli; `bundled`: version 2).
    BadPath { what: &'static str, path: String, why: &'static str, bundled: bool },
    /// Only one of RETAKE_NODE / RETAKE_CLI.
    HalfEnv,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Missing(p, true) => write!(f, "{} is missing: this copy of Retake is damaged — install it again from its disk image", p.display()),
            ConfigError::Missing(p, false) => write!(
                f,
                "{} is missing: a development build of the app is made with pnpm desktop:build (or pnpm desktop:dev) in the repository",
                p.display()
            ),
            ConfigError::Invalid(e, true) => write!(f, "launch.json is not valid ({e}): this copy of Retake is damaged — install it again from its disk image"),
            ConfigError::Invalid(e, false) => write!(f, "launch.json is not valid ({e}): build the app again with pnpm desktop:build in the repository"),
            ConfigError::BadPath { what, path, why, bundled: true } => write!(
                f,
                "the {what} inside this app ({path}) {why}: this copy of Retake is damaged — install it again from its disk image"
            ),
            ConfigError::BadPath { what, path, why, bundled: false } => write!(
                f,
                "the {what} this app runs ({path}) {why}: run pnpm build and pnpm desktop:build again in the repository (the Node.js that builds it is the one the app runs)"
            ),
            ConfigError::HalfEnv => write!(f, "set both RETAKE_NODE and RETAKE_CLI, or neither"),
        }
    }
}

fn check(what: &'static str, p: &str) -> Result<PathBuf, ConfigError> {
    let bad = |why| ConfigError::BadPath { what, path: p.to_string(), why, bundled: false };
    let path = Path::new(p);
    if p.contains('\0') || !path.is_absolute() {
        return Err(bad("is not an absolute path"));
    }
    is_file(path.to_path_buf(), bad)
}

fn is_file(path: PathBuf, bad: impl Fn(&'static str) -> ConfigError) -> Result<PathBuf, ConfigError> {
    match fs::metadata(&path) {
        Ok(m) if m.is_file() => Ok(path),
        Ok(_) => Err(bad("is not a file")),
        Err(_) => Err(bad("does not exist")),
    }
}

/// A version 2 path: relative to launch.json's folder (the app's `Contents/Resources`), plain names only — no `..`,
/// no `.`, never absolute — then a regular file whose real path (links followed) is still inside the app's folder:
/// it can only name a file inside the app, whether or not the app's seal still holds (review B L2b).
fn check_inside(what: &'static str, p: &str, resources: &Path) -> Result<PathBuf, ConfigError> {
    use std::path::Component;
    let bad = |why| ConfigError::BadPath { what, path: p.to_string(), why, bundled: true };
    let path = Path::new(p);
    if p.is_empty() || p.contains('\0') || !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(bad("is not a relative path inside the app"));
    }
    let full = is_file(resources.join(path), bad)?;
    match (fs::canonicalize(&full), fs::canonicalize(resources)) {
        (Ok(real), Ok(root)) if real.starts_with(&root) => Ok(full),
        (Ok(_), Ok(_)) => Err(bad("leads out of the app through a link")),
        _ => Err(bad("does not exist")),
    }
}

/// The launch config: the environment's `RETAKE_NODE` / `RETAKE_CLI` when `allow_env` (debug builds only:
/// a Finder-launched release app never takes them from `launchctl setenv`), else `launch_json`:
/// `{"version":1,"node":…,"cli":…}` (the developer app: both paths absolute) or
/// `{"version":2,"bundled":true,"node":"node/bin/node","cli":"engine/dist/bin.js","preload":"node/guard.cjs"}` (the
/// bundled app: all three relative to launch.json's folder, inside it). All regular files.
pub fn launch_config(env_node: Option<&str>, env_cli: Option<&str>, allow_env: bool, launch_json: &Path) -> Result<LaunchConfig, ConfigError> {
    let env_node = env_node.filter(|s| !s.is_empty());
    let env_cli = env_cli.filter(|s| !s.is_empty());
    if allow_env {
        match (env_node, env_cli) {
            (Some(n), Some(c)) => return Ok(LaunchConfig { node: check("node", n)?, cli: check("cli", c)?, bundled: false, preload: None }),
            (None, None) => {}
            _ => return Err(ConfigError::HalfEnv),
        }
    }
    let resources = launch_json.parent().unwrap_or(Path::new("."));
    // A bundled app's folder holds bundle.json: its words for a missing or broken launch.json name no pnpm (review B L1).
    let in_bundle = resources.join("bundle.json").is_file();
    let text = match fs::read_to_string(launch_json) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(ConfigError::Missing(launch_json.to_path_buf(), in_bundle)),
        Err(e) => return Err(ConfigError::Invalid(e.to_string(), in_bundle)),
    };
    let v = json::parse(&text).map_err(|e| ConfigError::Invalid(e, in_bundle))?;
    let version = v.get("version").and_then(|x| x.as_uint(1000));
    let bundled_words = in_bundle || version == Some(2);
    let field = |k: &str| v.get(k).and_then(Json::as_str).ok_or_else(|| ConfigError::Invalid(format!("no {k}"), bundled_words));
    match version {
        Some(1) => {
            let (node, cli) = (field("node")?, field("cli")?);
            Ok(LaunchConfig { node: check("node", node)?, cli: check("cli", cli)?, bundled: false, preload: None })
        }
        Some(2) => {
            if v.get("bundled").and_then(Json::as_bool) != Some(true) {
                return Err(ConfigError::Invalid("version 2 is the bundled app's: bundled must be true".into(), true));
            }
            let (node, cli, preload) = (field("node")?, field("cli")?, field("preload")?);
            Ok(LaunchConfig { node: check_inside("node", node, resources)?, cli: check_inside("cli", cli, resources)?, bundled: true, preload: Some(check_inside("preload", preload, resources)?) })
        }
        _ => Err(ConfigError::Invalid("version is not 1 or 2".into(), bundled_words)),
    }
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
/// `{{env:NAME}}` secrets come from the environment the worker inherits). The bundled app's launcher
/// (apps/desktop/bundle/retake.sh) unsets the same names (a test compares the two: review A L4).
pub fn child_env_dropped(name: &str) -> bool {
    CHILD_ENV_DROPPED.contains(&name) || name.starts_with(CHILD_ENV_DROPPED_PREFIX)
}

/// The names `child_env_dropped` drops, besides every `DYLD_*` one.
pub const CHILD_ENV_DROPPED: [&str; 6] = ["NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT"];
pub const CHILD_ENV_DROPPED_PREFIX: &str = "DYLD_";

/// Where the app reads its launch.json: `<App>.app/Contents/MacOS/<binary>` → `<App>.app/Contents/Resources/launch.json`,
/// from the binary's real path — `current_exe()` keeps a link's path as given on macOS, and a link to the binary
/// elsewhere would otherwise read a launch.json beside the link (review A L5).
pub fn launch_json_path(exe: &Path) -> PathBuf {
    let exe = fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
    exe.parent().and_then(Path::parent).map(|c| c.join("Resources").join("launch.json")).unwrap_or_else(|| PathBuf::from("launch.json"))
}

/// The CLI's own rule (`workspaceRoot`): a `retake.yaml`, or a `projects/` folder.
pub fn is_workspace(dir: &Path) -> bool {
    dir.join("retake.yaml").exists() || dir.join("projects").is_dir()
}

/// The alert of File › Open Workspace… for a folder that is no workspace.
pub fn not_workspace_text(dir: &Path) -> String {
    let d = dir.display();
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
    /// L5.16c: made by the first run (`retake init`).
    Created,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Arg => "--root",
            Source::Env => "RETAKE_ROOT",
            Source::Remembered => "the last one opened",
            Source::Cwd => "the current folder",
            Source::Picker => "chosen",
            Source::Created => "created at the first run",
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
        assert_eq!(launch_config(None, None, false, &lj), Err(ConfigError::Missing(lj.clone(), false)));
        assert!(launch_config(None, None, false, &lj).unwrap_err().to_string().contains("pnpm desktop:build"));
        fs::write(&lj, format!("{{\"version\":1,\"node\":{},\"cli\":{}}}", json::quote(node.to_str().unwrap()), json::quote(cli.to_str().unwrap()))).unwrap();
        let want = LaunchConfig { node: node.clone(), cli: cli.clone(), bundled: false, preload: None };
        assert_eq!(launch_config(None, None, false, &lj).unwrap(), want);
        // The environment wins in debug builds only.
        let other = d.join("other-node");
        fs::write(&other, "").unwrap();
        let (o, c) = (other.to_str().unwrap(), cli.to_str().unwrap());
        assert_eq!(launch_config(Some(o), Some(c), false, &lj).unwrap(), want);
        assert_eq!(launch_config(Some(o), Some(c), true, &lj).unwrap(), LaunchConfig { node: other.clone(), cli: cli.clone(), bundled: false, preload: None });
        assert_eq!(launch_config(Some(o), None, true, &lj), Err(ConfigError::HalfEnv));
        assert!(matches!(launch_config(Some("node"), Some(c), true, &lj), Err(ConfigError::BadPath { why: "is not an absolute path", .. })));
        assert!(matches!(launch_config(Some(d.to_str().unwrap()), Some(c), true, &lj), Err(ConfigError::BadPath { why: "is not a file", .. })));
        assert!(matches!(launch_config(Some("/nonexistent/node"), Some(c), true, &lj), Err(ConfigError::BadPath { why: "does not exist", .. })));
        for bad in ["{}", "{\"version\":2,\"node\":\"/x\",\"cli\":\"/y\"}", "{\"version\":1,\"node\":\"/x\"}", "not json"] {
            fs::write(&lj, bad).unwrap();
            assert!(matches!(launch_config(None, None, false, &lj), Err(ConfigError::Invalid(..))), "{bad}");
        }
        fs::write(&lj, "{\"version\":1,\"node\":\"relative/node\",\"cli\":\"/y\"}").unwrap();
        assert!(matches!(launch_config(None, None, false, &lj), Err(ConfigError::BadPath { what: "node", bundled: false, .. })));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn launch_json_v2_names_files_inside_the_app_only() {
        // L5.16: the bundled app's launch.json — paths relative to its folder (Contents/Resources), plain names only.
        let d = test_dir("launch-v2");
        let res = d.join("Retake.app").join("Contents").join("Resources");
        fs::create_dir_all(res.join("node").join("bin")).unwrap();
        fs::create_dir_all(res.join("engine").join("dist")).unwrap();
        fs::write(res.join("node").join("bin").join("node"), "").unwrap();
        fs::write(res.join("node").join("guard.cjs"), "").unwrap();
        fs::write(res.join("engine").join("dist").join("bin.js"), "").unwrap();
        fs::write(d.join("outside.js"), "").unwrap();
        let lj = res.join("launch.json");
        // Missing in a bundled app's folder (bundle.json beside it): the disk image, never pnpm (review B L1).
        fs::write(res.join("bundle.json"), "{}").unwrap();
        for e in [launch_config(None, None, false, &lj).unwrap_err(), {
            fs::write(&lj, "not json").unwrap();
            launch_config(None, None, false, &lj).unwrap_err()
        }] {
            assert!(matches!(e, ConfigError::Missing(_, true) | ConfigError::Invalid(_, true)), "{e:?}");
            assert!(e.to_string().contains("install it again from its disk image") && !e.to_string().contains("pnpm"), "{e}");
        }
        let v2 = |node: &str, cli: &str| format!("{{\"version\":2,\"bundled\":true,\"node\":{},\"cli\":{},\"preload\":\"node/guard.cjs\"}}", json::quote(node), json::quote(cli));
        fs::write(&lj, v2("node/bin/node", "engine/dist/bin.js")).unwrap();
        let want = LaunchConfig { node: res.join("node/bin/node"), cli: res.join("engine/dist/bin.js"), bundled: true, preload: Some(res.join("node/guard.cjs")) };
        assert_eq!(launch_config(None, None, false, &lj).unwrap(), want);
        // The environment is read only when allowed (debug builds), whichever the version.
        assert_eq!(launch_config(Some("/nonexistent/node"), Some("/nonexistent/cli"), false, &lj).unwrap(), want);
        // Out of the app, absolute, dotted or empty: refused, with the bundled words.
        let abs_cli = d.join("outside.js");
        for (node, cli) in [
            ("node/bin/node", "../../../outside.js"),
            ("node/bin/node", abs_cli.to_str().unwrap()),
            ("./node/bin/node", "engine/dist/bin.js"),
            ("node/../node/bin/node", "engine/dist/bin.js"),
            ("", "engine/dist/bin.js"),
        ] {
            fs::write(&lj, v2(node, cli)).unwrap();
            let e = launch_config(None, None, false, &lj).unwrap_err();
            assert!(matches!(e, ConfigError::BadPath { why: "is not a relative path inside the app", bundled: true, .. }), "{node} {cli}: {e:?}");
            assert!(e.to_string().contains("install it again from its disk image"), "{e}");
            assert!(!e.to_string().contains("pnpm"), "{e}");
        }
        fs::write(&lj, v2("node/bin/node", "engine/dist/missing.js")).unwrap();
        assert!(matches!(launch_config(None, None, false, &lj), Err(ConfigError::BadPath { what: "cli", why: "does not exist", bundled: true, .. })));
        fs::write(&lj, v2("node", "engine/dist/bin.js")).unwrap();
        assert!(matches!(launch_config(None, None, false, &lj), Err(ConfigError::BadPath { what: "node", why: "is not a file", bundled: true, .. })));
        // A link inside the app to a file outside it: refused (the rule holds without the seal: review B L2b).
        std::os::unix::fs::symlink(d.join("outside.js"), res.join("engine").join("dist").join("linked.js")).unwrap();
        fs::write(&lj, v2("node/bin/node", "engine/dist/linked.js")).unwrap();
        assert!(matches!(launch_config(None, None, false, &lj), Err(ConfigError::BadPath { what: "cli", why: "leads out of the app through a link", bundled: true, .. })));
        // The guard is required, inside the app.
        fs::write(&lj, "{\"version\":2,\"bundled\":true,\"node\":\"node/bin/node\",\"cli\":\"engine/dist/bin.js\"}").unwrap();
        assert!(matches!(launch_config(None, None, false, &lj), Err(ConfigError::Invalid(_, true))));
        fs::write(&lj, v2("node/bin/node", "engine/dist/bin.js").replace("node/guard.cjs", "../guard.cjs")).unwrap();
        assert!(matches!(launch_config(None, None, false, &lj), Err(ConfigError::BadPath { what: "preload", bundled: true, .. })));
        // Version 2 is the bundled app's only; version 1's absolute paths are not read as version 2.
        for bad in ["{\"version\":2,\"node\":\"node/bin/node\",\"cli\":\"engine/dist/bin.js\"}", "{\"version\":2,\"bundled\":false,\"node\":\"node/bin/node\",\"cli\":\"engine/dist/bin.js\"}", "{\"version\":3,\"bundled\":true,\"node\":\"node/bin/node\",\"cli\":\"engine/dist/bin.js\"}"] {
            fs::write(&lj, bad).unwrap();
            assert!(matches!(launch_config(None, None, false, &lj), Err(ConfigError::Invalid(..))), "{bad}");
        }
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
    fn a_folder_that_is_no_workspace_is_told_so() {
        let d = test_dir("no-ws");
        assert_eq!(not_workspace_text(&d), format!("{} has no retake.yaml or projects/ folder. The workspace open now stays open.", d.display()));
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
    fn the_launcher_drops_the_same_variables_as_the_shell() {
        // The bundled app's command (apps/desktop/bundle/retake.sh) and the shell's Studio server drop one list (review A L4).
        let sh = include_str!("../../bundle/retake.sh");
        let line = sh.lines().find(|l| l.starts_with("unset ")).expect("an unset line");
        let mut named: Vec<&str> = line["unset ".len()..].split_whitespace().collect();
        named.sort_unstable();
        let mut want = CHILD_ENV_DROPPED.to_vec();
        want.sort_unstable();
        assert_eq!(named, want, "{line}");
        assert_eq!(sh.lines().filter(|l| l.starts_with("unset ")).count(), 1);
        assert!(sh.contains(&format!("s/^\\({CHILD_ENV_DROPPED_PREFIX}[A-Za-z0-9_]*\\)=.*/\\1/p")), "the launcher unsets every {CHILD_ENV_DROPPED_PREFIX}* variable");
    }

    #[test]
    fn launch_json_is_found_from_the_binarys_real_path() {
        let d = test_dir("launch-path");
        let macos = d.join("Retake.app").join("Contents").join("MacOS");
        fs::create_dir_all(&macos).unwrap();
        fs::write(macos.join("retake-desktop"), "").unwrap();
        let elsewhere = d.join("x").join("y");
        fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(macos.join("retake-desktop"), elsewhere.join("retake-desktop")).unwrap();
        let real = fs::canonicalize(&d).unwrap().join("Retake.app").join("Contents").join("Resources").join("launch.json");
        assert_eq!(launch_json_path(&macos.join("retake-desktop")), real);
        // Through a link placed elsewhere: still the app's own, never <link's grandparent>/Resources/launch.json.
        assert_eq!(launch_json_path(&elsewhere.join("retake-desktop")), real);
        assert_eq!(launch_json_path(Path::new("/nonexistent/MacOS/bin")), PathBuf::from("/nonexistent/Resources/launch.json"));
        fs::remove_dir_all(&d).unwrap();
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
