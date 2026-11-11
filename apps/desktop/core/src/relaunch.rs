//! BL-168: the updated app starts again under the Dock icon the old one had.
//!
//! The updater swaps the new bundle in at the path of the running one. Tauri's `AppHandle::restart` then runs
//! `open -n <bundle>` while this process is still alive, so LaunchServices starts a second instance and the Dock gives it
//! a tile of its own beside the pinned one, which stays on the dying process (and looks closed once it is gone).
//! [`Relaunch`] hands the start to a detached shell instead: it waits until this process is gone, from the kernel and
//! from LaunchServices, then runs a plain `open` on the bundle, as a click on the pinned icon would.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// `$1` the pid to outlive, `$2` how many tenths of a second to wait for it at most, `$3` the opener, `$4` the bundle,
/// the rest the app's arguments.
///
/// The pid must be gone from LaunchServices too (`lsappinfo` lists the apps it knows; absent, it reads as gone): until
/// then the Dock still holds the pinned tile for the old process. A plain `open` then starts the app like a click on
/// that tile. If the old process outlives the wait, `open -n` starts the update anyway rather than only bringing the old
/// app forward: two icons beat no app.
const SCRIPT: &str = r#"pid=$1 tenths=$2 opener=$3 bundle=$4
shift 4
while [ "$tenths" -gt 0 ]; do
  if ! kill -0 "$pid" 2>/dev/null && [ -z "$(/usr/bin/lsappinfo find pid="$pid" 2>/dev/null)" ]; then
    exec "$opener" "$bundle" --args "$@"
  fi
  /bin/sleep 0.1
  tenths=$((tenths - 1))
done
exec "$opener" -n "$bundle" --args "$@"
"#;

/// Starting the app at `bundle` again once the process `pid` has exited.
#[derive(Debug, Clone)]
pub struct Relaunch {
    pub pid: u32,
    pub bundle: PathBuf,
    pub args: Vec<OsString>,
    pub opener: PathBuf,
    pub max_wait: Duration,
}

impl Relaunch {
    /// This process, started again from `bundle` with `args` by LaunchServices. Thirty seconds covers a slow end of the
    /// quit (the owned server is stopped before the swap) with room to spare.
    pub fn after_this_process(bundle: PathBuf, args: Vec<OsString>) -> Self {
        Relaunch { pid: std::process::id(), bundle, args, opener: PathBuf::from("/usr/bin/open"), max_wait: Duration::from_secs(30) }
    }

    /// The detached shell that waits, then opens: its own process group and no stdio, so nothing of this process (a
    /// signal to its group, a closed pipe) stops it once this process has exited.
    pub fn command(&self) -> Command {
        use std::os::unix::process::CommandExt;
        let tenths = (self.max_wait.as_millis() / 100).max(1);
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(SCRIPT)
            .arg("retake-relaunch")
            .arg(self.pid.to_string())
            .arg(tenths.to_string())
            .arg(&self.opener)
            .arg(&self.bundle)
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        cmd
    }

    /// Starts the shell. The caller exits right after: the child is never waited for (launchd adopts it).
    pub fn spawn(&self) -> std::io::Result<Child> {
        self.command().spawn()
    }
}

/// The arguments to start the app with again: this process's, without the `-psn_…` LaunchServices adds (it names the
/// old process).
pub fn relaunch_args(args: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    args.into_iter().filter(|a| !a.to_string_lossy().starts_with("-psn_")).collect()
}

/// Whether `bundle` is an app bundle `open` can start (`<name>.app`).
pub fn is_bundle(bundle: &Path) -> bool {
    bundle.extension().is_some_and(|e| e == "app")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Instant;

    /// An opener that writes its arguments, one per line (`printf`: `echo` would take a `-n` for an option).
    fn fake_opener(dir: &Path) -> (PathBuf, PathBuf) {
        let log = dir.join("opened");
        let opener = dir.join("open");
        let l = log.display();
        std::fs::write(&opener, format!("#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > '{l}.tmp'\nmv '{l}.tmp' '{l}'\n")).unwrap();
        std::fs::set_permissions(&opener, std::fs::Permissions::from_mode(0o755)).unwrap();
        (opener, log)
    }

    fn wait_for(path: &Path, limit: Duration) -> Option<String> {
        let start = Instant::now();
        while start.elapsed() < limit {
            if let Ok(s) = std::fs::read_to_string(path) {
                return Some(s);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }

    #[test]
    fn the_app_is_opened_once_the_old_process_is_gone_without_a_new_instance() {
        let dir = crate::test_dir("relaunch-gone");
        let (opener, log) = fake_opener(&dir);
        // The "old app": a process that lives a while, reaped by a thread as launchd reaps the real one.
        let mut old = Command::new("/bin/sleep").arg("0.6").spawn().unwrap();
        let pid = old.id();
        let reaper = std::thread::spawn(move || {
            old.wait().unwrap();
            Instant::now()
        });
        let r = Relaunch { pid, bundle: PathBuf::from("/Applications/Retake.app"), args: vec!["--flag".into(), "two words".into()], opener, max_wait: Duration::from_secs(20) };
        let mut shell = r.spawn().unwrap();
        let opened = wait_for(&log, Duration::from_secs(10)).expect("the opener ran");
        let seen_at = Instant::now();
        let gone_at = reaper.join().unwrap();
        assert!(seen_at >= gone_at, "opened only after the old process exited");
        assert_eq!(opened.lines().collect::<Vec<_>>(), ["/Applications/Retake.app", "--args", "--flag", "two words"], "a plain open: the Dock's pinned icon");
        assert!(shell.wait().unwrap().success());
    }

    #[test]
    fn the_app_is_not_opened_while_the_old_process_runs() {
        let dir = crate::test_dir("relaunch-running");
        let (opener, log) = fake_opener(&dir);
        let mut old = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let r = Relaunch { pid: old.id(), bundle: PathBuf::from("/Applications/Retake.app"), args: vec![], opener, max_wait: Duration::from_secs(20) };
        let mut shell = r.spawn().unwrap();
        assert_eq!(wait_for(&log, Duration::from_millis(800)), None);
        old.kill().unwrap();
        old.wait().unwrap();
        assert!(wait_for(&log, Duration::from_secs(10)).is_some());
        assert!(shell.wait().unwrap().success());
    }

    #[test]
    fn an_old_process_that_outlives_the_wait_still_gets_the_update_started() {
        let dir = crate::test_dir("relaunch-outlives");
        let (opener, log) = fake_opener(&dir);
        let mut old = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let r = Relaunch { pid: old.id(), bundle: PathBuf::from("/Applications/Retake.app"), args: vec![], opener, max_wait: Duration::from_millis(300) };
        let mut shell = r.spawn().unwrap();
        let opened = wait_for(&log, Duration::from_secs(10)).expect("the opener ran");
        assert_eq!(opened.lines().collect::<Vec<_>>(), ["-n", "/Applications/Retake.app", "--args"]);
        assert!(shell.wait().unwrap().success());
        old.kill().unwrap();
        old.wait().unwrap();
    }

    #[test]
    fn this_process_through_launch_services_with_its_own_arguments() {
        let r = Relaunch::after_this_process(PathBuf::from("/Applications/Retake.app"), vec![]);
        assert_eq!(r.pid, std::process::id());
        assert_eq!(r.opener, Path::new("/usr/bin/open"));
        assert!(r.max_wait >= Duration::from_secs(10));
        assert_eq!(relaunch_args(["-psn_0_12345".into(), "--x".into()]), vec![OsString::from("--x")]);
        assert!(is_bundle(Path::new("/Applications/Retake.app")));
        assert!(!is_bundle(Path::new("/x/target/debug/retake-desktop")));
    }
}
