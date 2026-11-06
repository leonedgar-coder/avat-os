use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Paquete oficial de OBS del que salen las DLL que necesita obs-browser.
/// Debe coincidir con la versión que instala cargo-obs-build (carpeta `obs-build/<versión>`).
const OBS_VERSION: &str = "32.1.2";
const OBS_ZIP_URL: &str = "https://github.com/obsproject/obs-studio/releases/download/32.1.2/OBS-Studio-32.1.2-Windows-x64.zip";
const OBS_ZIP_SHA256: &str = "8d97e4563bd8d22d03e63042aa7dccede1d555c9bd35ce8a9e5019b0d0201bf6";

/// obs-browser depende de estas DLL, pero cargo-obs-build las borra al limpiar
/// (las considera parte de la interfaz de OBS). Las reponemos del paquete oficial.
const BROWSER_DEPS: [&str; 4] = [
    "obs-frontend-api.dll",
    "Qt6Core.dll",
    "Qt6Gui.dll",
    "Qt6Widgets.dll",
];

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let target_dir = out_dir.ancestors().nth(3).expect("carpeta target").to_path_buf();

    // Descarga los binarios oficiales de OBS (libobs + plugins) junto al ejecutable,
    // incluyendo la fuente de navegador (obs-browser), que usa la página del avatar.
    cargo_obs_build::build_obs_binaries(cargo_obs_build::ObsBuildConfig {
        out_dir: target_dir.clone(),
        browser: true,
        ..Default::default()
    })
    .expect("No se pudieron instalar los binarios de OBS");

    let cache_dir = manifest_dir.join("../obs-build");
    if !cache_dir.join(OBS_VERSION).exists() {
        println!(
            "cargo:warning=cargo-obs-build instaló una versión distinta de OBS {OBS_VERSION}; \
             actualiza OBS_VERSION/OBS_ZIP_URL/OBS_ZIP_SHA256 en build.rs"
        );
    }
    install_browser_deps(&cache_dir.join("extra"), &target_dir)
        .expect("No se pudieron instalar las dependencias de obs-browser");

    tauri_build::build()
}

fn install_browser_deps(cache_dir: &Path, target_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if BROWSER_DEPS.iter().all(|f| target_dir.join(f).is_file()) {
        return Ok(());
    }

    fs::create_dir_all(cache_dir)?;
    let zip_path = cache_dir.join(format!("obs-{OBS_VERSION}.zip"));
    if !zip_path.is_file() || sha256_file(&zip_path)? != OBS_ZIP_SHA256 {
        println!("cargo:warning=Descargando OBS {OBS_VERSION} oficial para obs-browser...");
        let partial = zip_path.with_extension("zip.part");
        let mut reader = ureq::get(OBS_ZIP_URL).call()?.into_reader();
        io::copy(&mut reader, &mut File::create(&partial)?)?;
        let hash = sha256_file(&partial)?;
        if hash != OBS_ZIP_SHA256 {
            fs::remove_file(&partial)?;
            return Err(format!("SHA-256 incorrecto del paquete de OBS: {hash}").into());
        }
        fs::rename(&partial, &zip_path)?;
    }

    let mut archive = zip::ZipArchive::new(File::open(&zip_path)?)?;
    for name in BROWSER_DEPS {
        let mut entry = archive.by_name(&format!("bin/64bit/{name}"))?;
        io::copy(&mut entry, &mut File::create(target_dir.join(name))?)?;
    }
    Ok(())
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
