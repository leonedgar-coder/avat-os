// Descarga los binarios oficiales de OBS (libobs + plugins) a la carpeta target.
fn main() {
    cargo_obs_build::install().expect("No se pudieron instalar los binarios de OBS");
}
