// Self-updater for `auto` LTO binary: verifies SHA-256 + Ed25519 signed `UpdateManifest` before replacing binary.
use std::path::Path;

use auto_client::{ReleaseArtifact, UpdateManifest};

use crate::{SdkError, SdkResult};

pub fn verify_and_select_artifact<'a>(
    manifest: &'a UpdateManifest,
    public_key_hex: &str,
    platform_key: &str,
) -> SdkResult<&'a ReleaseArtifact> {
    manifest.verify_manifest_signature(public_key_hex)?;
    manifest
        .artifact_for(platform_key)
        .ok_or_else(|| SdkError::Config(format!("no artifact for platform '{platform_key}' in manifest")))
}

pub fn verify_downloaded_artifact(artifact: &ReleaseArtifact, public_key_hex: &str, bytes: &[u8]) -> SdkResult<()> {
    artifact.verify_bytes(bytes, public_key_hex)?;
    Ok(())
}

pub fn stage_binary_replacement(target_exe: &Path, new_bytes: &[u8]) -> SdkResult<()> {
    let staged = target_exe.with_extension("new");
    let backup = target_exe.with_extension("bak");
    std::fs::write(&staged, new_bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&staged)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&staged, perms)?;
    }
    if backup.exists() {
        let _ = std::fs::remove_file(&backup);
    }
    if target_exe.exists() {
        std::fs::rename(target_exe, &backup)?;
    }
    std::fs::rename(&staged, target_exe)?;
    Ok(())
}
