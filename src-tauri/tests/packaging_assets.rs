use std::{collections::BTreeSet, fs, path::Path};

use serde_json::Value;

const REQUIRED_WINDOWS_ICON_SIZES: [u16; 6] = [16, 24, 32, 48, 64, 256];

fn little_endian_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}

fn little_endian_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn ico_dimension(encoded: u8) -> u16 {
    if encoded == 0 {
        256
    } else {
        u16::from(encoded)
    }
}

#[test]
fn configured_bundle_icons_exist_and_windows_ico_is_valid_multiresolution() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let config_bytes = fs::read(manifest_dir.join("tauri.conf.json")).unwrap();
    let config: Value = serde_json::from_slice(&config_bytes).unwrap();
    let configured_icons = config["bundle"]["icon"]
        .as_array()
        .expect("bundle.icon must explicitly list package icons")
        .iter()
        .map(|value| value.as_str().expect("bundle.icon entries must be paths"))
        .collect::<Vec<_>>();

    assert_eq!(configured_icons, ["icons/icon.png", "icons/icon.ico"]);
    for icon in &configured_icons {
        assert!(
            manifest_dir.join(icon).is_file(),
            "configured bundle icon is missing: {icon}"
        );
    }

    let ico = fs::read(manifest_dir.join("icons/icon.ico")).unwrap();
    assert!(ico.len() >= 6, "ICO header is truncated");
    assert_eq!(little_endian_u16(&ico, 0), 0, "ICO reserved field");
    assert_eq!(little_endian_u16(&ico, 2), 1, "ICO image type");
    let image_count = usize::from(little_endian_u16(&ico, 4));
    assert!(image_count > 0, "ICO must contain at least one image");
    assert!(
        ico.len() >= 6 + image_count * 16,
        "ICO directory is truncated"
    );

    let mut dimensions = BTreeSet::new();
    for index in 0..image_count {
        let entry_offset = 6 + index * 16;
        let width = ico_dimension(ico[entry_offset]);
        let height = ico_dimension(ico[entry_offset + 1]);
        assert_eq!(width, height, "ICO frame must be square");
        assert!(little_endian_u16(&ico, entry_offset + 4) <= 1);
        assert_eq!(little_endian_u16(&ico, entry_offset + 6), 32);

        let byte_len = little_endian_u32(&ico, entry_offset + 8) as usize;
        let image_offset = little_endian_u32(&ico, entry_offset + 12) as usize;
        let image_end = image_offset
            .checked_add(byte_len)
            .expect("ICO frame bounds overflowed");
        assert!(byte_len > 0, "ICO frame must not be empty");
        assert!(
            image_offset >= 6 + image_count * 16 && image_end <= ico.len(),
            "ICO frame points outside the file"
        );
        dimensions.insert(width);
    }

    for required_size in REQUIRED_WINDOWS_ICON_SIZES {
        assert!(
            dimensions.contains(&required_size),
            "ICO is missing the {required_size}x{required_size} frame"
        );
    }
}
