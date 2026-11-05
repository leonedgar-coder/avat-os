// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Spike 1: arranca libobs, crea una escena con la captura del monitor
// y graba 5 segundos a `grabacion-spike.mp4`.

use std::{thread, time::Duration};

use anyhow::Context;

use libobs_simple::output::simple::ObsContextSimpleExt;
use libobs_simple::sources::windows::{MonitorCaptureSourceBuilder, ObsDisplayCaptureMethod};
use libobs_wrapper::data::output::ObsOutputTrait;
use libobs_wrapper::scenes::SceneItemTrait;
use libobs_wrapper::sources::ObsSourceBuilder;
use libobs_wrapper::utils::{ObsPath, StartupInfo};
use libobs_wrapper::context::ObsContext;

fn main() -> anyhow::Result<()> {
    env_logger::init();

    println!("[1/4] Iniciando libobs...");
    let mut context = ObsContext::new(StartupInfo::default())?;

    println!("[2/4] Creando escena con captura de monitor...");
    let mut scene = context.scene("principal", Some(0))?;
    let monitors = MonitorCaptureSourceBuilder::get_monitors()?;
    println!("      Monitores encontrados: {}", monitors.len());

    let item = context
        .source_builder::<MonitorCaptureSourceBuilder, _>("Pantalla")?
        .set_monitor(monitors.first().context("No se encontró ningún monitor")?)
        .set_capture_method(ObsDisplayCaptureMethod::MethodDXGI)
        .add_to_scene(&mut scene)?;
    item.fit_source_to_screen()?;

    println!("[3/4] Grabando 5 segundos...");
    let output = context
        .simple_output_builder("grabacion", ObsPath::new("grabacion-spike.mp4"))
        .build()?;
    output.start()?;
    thread::sleep(Duration::from_secs(5));
    output.stop()?;

    println!("[4/4] Listo: grabacion-spike.mp4");
    Ok(())
}
