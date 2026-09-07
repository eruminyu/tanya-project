fn main() {
    println!("cargo:rerun-if-changed=.env.local");
    if let Ok(contents) = std::fs::read_to_string(".env.local") {
        for line in contents.lines() {
            let Some((key, value)) = line.split_once('=') else { continue };
            if key.trim() == "TANYA_GOOGLE_CLIENT_SECRET" {
                println!("cargo:rustc-env=TANYA_GOOGLE_CLIENT_SECRET={}", value.trim());
            }
        }
    }
    tauri_build::build()
}
