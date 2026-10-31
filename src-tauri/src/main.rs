#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::LazyLock;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

const AUDIO: [&str; 6] = ["wav", "aif", "aiff", "flac", "mp3", "ogg"];
const DEFAULT_ROOT: &str = r"C:\Users\Alexander\Music\FL Studio\Packs";
const DRAG_ICON: &[u8] = include_bytes!("../icons/drag.png");

// ---------- settings ----------
fn data_dir(app: &AppHandle) -> PathBuf {
    let d = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&d);
    d
}
fn load_settings(app: &AppHandle) -> Value {
    fs::read_to_string(data_dir(app).join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}
fn save_settings(app: &AppHandle, s: &Value) {
    let _ = fs::write(data_dir(app).join("settings.json"), s.to_string());
}
fn get_root_path(app: &AppHandle) -> PathBuf {
    if let Some(r) = load_settings(app)["root"].as_str() {
        if Path::new(r).exists() {
            return PathBuf::from(r);
        }
    }
    if Path::new(DEFAULT_ROOT).exists() {
        return PathBuf::from(DEFAULT_ROOT);
    }
    app.path().audio_dir().unwrap_or_default().join("FL Studio").join("Packs")
}
fn save_position(win: &WebviewWindow) {
    if win.is_minimized().unwrap_or(false) {
        return;
    }
    if let Ok(p) = win.outer_position() {
        let app = win.app_handle();
        let mut s = load_settings(app);
        s["bounds"] = json!({ "x": p.x, "y": p.y });
        save_settings(app, &s);
    }
}

// ---------- metadata parsing ----------
fn rx(p: &str) -> Regex {
    Regex::new(p).unwrap()
}
fn word(alts: &str) -> Regex {
    rx(&format!("(^|[^a-z])({})([^a-z]|$)", alts))
}
static TYPE_RULES: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    vec![
        ("FX", word("fx|sfx|riser|risers|uplifter|downlifter|lifter|impact|impacts|sweep|sweeps|swell|transition|whoosh")),
        ("Kick", word("kicks?|bd|bassdrum")),
        ("Snare", word("snares?|snr|rimshots?")),
        ("Clap", word("claps?|clp|snaps?")),
        ("Hi-Hat", word("(open|closed|hi)-?hats?|hats?|hh|ohh|chh")),
        ("Cymbal", word("cymbals?|crash|crashes|ride|rides")),
        ("Tom", word("toms?")),
        ("Shaker", word("shakers?|tambourines?|tambs?")),
        ("Perc", word("perc|percs|percussions?|congas?|bongos?|rims?|woodblocks?|cowbells?|clave")),
        ("Drum Loop", rx("break[ -]?chops?")),
        ("Vocal", word("vocals?|vocoded|vocoder|vox|voice|chops?|acapella|adlibs?")),
        ("Drum Loop", word("breakbeats?|breaks?|amen|drum ?loops?|fills?|top ?loops?")),
        ("808 / Bass", word("808s?|bass|sub|bassline|reese")),
        ("Synth", word("synths?|leads?|plucks?|arps?|chords?|pads?|melody|melodies|keys|piano|stabs?|guitar")),
        ("FX", word("noise|atmos?|atmospheres?|ambience|textures?|glitch")),
    ]
});
static ONESHOT_DIR: LazyLock<Regex> = LazyLock::new(|| word("one[ -]?shots?"));
static LOOP_DIR: LazyLock<Regex> = LazyLock::new(|| word("loops?|breakbeats?|fills?|stems?|rolls?"));
static BPM_A: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)(\d{2,3}(?:\.\d+)?)\s?bpm"));
static BPM_B: LazyLock<Regex> = LazyLock::new(|| rx(r"[_\- ](\d{2,3})([_\s]|$)"));
static BPM_HINT: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)(loop|amen|break|_\d{2,3}_)"));
static LOOP_HINT: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)(loop|amen|break|groove)"));
static KEY_A: LazyLock<Regex> =
    LazyLock::new(|| rx(r"(?:^|[\s_\-])([A-G])([#b]?)(maj(?:or)?|min(?:or)?|m)([\s_\-.]|$)"));
static KEY_B: LazyLock<Regex> = LazyLock::new(|| rx(r"\s-\s([A-G])([#b]?)$"));

// The pack's own folder structure is the primary signal (deepest folder first); the file name is the fallback.
fn classify(name: &str, folders: &[String]) -> &'static str {
    for f in folders.iter().rev() {
        let f = f.to_lowercase().replace("no kick", "");
        for (t, re) in TYPE_RULES.iter() {
            if re.is_match(&f) {
                return t;
            }
        }
    }
    let n = name.to_lowercase().replace("no kick", "");
    for (t, re) in TYPE_RULES.iter() {
        if re.is_match(&n) {
            return t;
        }
    }
    "Other"
}

// Loop / one-shot as declared by the nearest folder that says so.
fn folder_loop(folders: &[String]) -> Option<bool> {
    for f in folders.iter().rev() {
        let f = f.to_lowercase();
        if ONESHOT_DIR.is_match(&f) {
            return Some(false);
        }
        if LOOP_DIR.is_match(&f) {
            return Some(true);
        }
    }
    None
}

fn parse_bpm(name: &str) -> Option<u32> {
    if let Some(m) = BPM_A.captures(name) {
        let v = m[1].parse::<f64>().ok()?.round() as u32;
        if (50..=220).contains(&v) {
            return Some(v);
        }
    }
    if let Some(m) = BPM_B.captures(name) {
        if BPM_HINT.is_match(&format!("{}_", name)) {
            let v: u32 = m[1].parse().ok()?;
            if (60..=200).contains(&v) {
                return Some(v);
            }
        }
    }
    None
}

fn flat_to_sharp(n: &str) -> String {
    match n {
        "Db" => "C#",
        "Eb" => "D#",
        "Gb" => "F#",
        "Ab" => "G#",
        "Bb" => "A#",
        o => o,
    }
    .to_string()
}

fn parse_key(name: &str) -> Option<String> {
    if let Some(m) = KEY_A.captures(name) {
        let note = flat_to_sharp(&format!("{}{}", &m[1], &m[2]));
        let minor = !m[3].to_lowercase().starts_with("maj");
        return Some(format!("{}{}", note, if minor { "m" } else { "" }));
    }
    KEY_B.captures(name).map(|m| flat_to_sharp(&format!("{}{}", &m[1], &m[2])))
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Info {
    dur: Option<f64>,
    sr: Option<u32>,
    ch: Option<u32>,
    bits: Option<u32>,
}

fn wav_info(p: &Path, size: u64) -> Info {
    let read = || -> Option<Info> {
        let mut f = fs::File::open(p).ok()?;
        let mut b = vec![0u8; 65536];
        let n = f.read(&mut b).ok()?;
        if n < 44 || &b[0..4] != b"RIFF" {
            return None;
        }
        let u16le = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]) as u32;
        let u32le = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let mut o = 12usize;
        let mut fmt: Option<(u32, u32, u32, u32)> = None;
        while o + 8 <= n {
            let id = &b[o..o + 4];
            let sz = u32le(o + 4) as usize;
            if id == b"fmt " && o + 24 <= n {
                fmt = Some((u16le(o + 10), u32le(o + 12), u32le(o + 16), u16le(o + 22)));
            } else if id == b"data" {
                let (ch, sr, br, bits) = fmt?;
                if br == 0 {
                    return None;
                }
                let bytes = (sz as u64).min(size.saturating_sub(o as u64 + 8));
                return Some(Info { dur: Some(bytes as f64 / br as f64), sr: Some(sr), ch: Some(ch), bits: Some(bits) });
            }
            o += 8 + sz + (sz & 1);
        }
        None
    };
    read().unwrap_or_default()
}

#[derive(Serialize, Deserialize, Clone)]
struct CacheEntry {
    m: u64,
    s: u64,
    i: Info,
}

#[derive(Serialize)]
struct Item {
    path: String,
    name: String,
    ext: String,
    pack: String,
    folder: String,
    rel: String,
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "loop")]
    is_loop: bool,
    bpm: Option<u32>,
    key: Option<String>,
    dur: Option<f64>,
    sr: Option<u32>,
    ch: Option<u32>,
    bits: Option<u32>,
    size: u64,
}

fn scan_root(app: &AppHandle, root: &Path, force: bool) -> Vec<Item> {
    let cache_path = data_dir(app).join("index-cache.json");
    let cache: HashMap<String, CacheEntry> = if force {
        HashMap::new()
    } else {
        fs::read_to_string(&cache_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    };

    let files: Vec<PathBuf> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| AUDIO.contains(&x.to_lowercase().as_str()))
                .unwrap_or(false)
        })
        .map(|e| e.into_path())
        .collect();

    let total = files.len();
    let done = AtomicUsize::new(0);
    let results: Vec<Option<(Item, String, CacheEntry)>> = files
        .par_iter()
        .map(|p| {
            let md = fs::metadata(p).ok()?;
            let size = md.len();
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let key = p.to_string_lossy().to_string();
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
            let info = match cache.get(&key) {
                Some(c) if c.m == mtime && c.s == size => c.i.clone(),
                _ if ext == "wav" => wav_info(p, size),
                _ => Info::default(),
            };

            let rel: Vec<String> = p
                .strip_prefix(root)
                .unwrap_or(p)
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect();
            let pack = rel.first().cloned().unwrap_or_default();
            let folders: Vec<String> = if rel.len() > 2 { rel[1..rel.len() - 1].to_vec() } else { vec![] };
            let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let kind = classify(&name, &folders);
            let bpm = parse_bpm(&name);
            let is_loop = folder_loop(&folders)
                .unwrap_or_else(|| (bpm.is_some() || LOOP_HINT.is_match(&name)) && info.dur.map_or(true, |d| d >= 1.0));
            let last2 = &folders[folders.len().saturating_sub(2)..];

            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            if d % 64 == 0 || d == total {
                let _ = app.emit("scan-progress", json!({ "done": d, "total": total }));
            }

            let item = Item {
                path: key.clone(),
                name: name.clone(),
                ext,
                pack,
                folder: last2.join(" / "),
                rel: rel.join(" / "),
                kind,
                is_loop,
                bpm,
                key: parse_key(&name),
                dur: info.dur,
                sr: info.sr,
                ch: info.ch,
                bits: info.bits,
                size,
            };
            Some((item, key, CacheEntry { m: mtime, s: size, i: info }))
        })
        .collect();

    let mut items = Vec::with_capacity(results.len());
    let mut new_cache = HashMap::with_capacity(results.len());
    for (item, k, c) in results.into_iter().flatten() {
        new_cache.insert(k, c);
        items.push(item);
    }
    if let Ok(s) = serde_json::to_string(&new_cache) {
        let _ = fs::write(cache_path, s);
    }
    items
}

// ---------- shapes (volume-over-time outline per WAV, for "search by shape") ----------
const SHAPE_N: usize = 48;

struct Wav {
    b: Vec<u8>,
    start: usize,
    tag: usize,
    bits: usize,
    ch: usize,
    align: usize,
    frames: usize,
    sr: f32,
}

impl Wav {
    fn sample(&self, fr: usize, c: usize) -> f32 {
        let b = &self.b;
        let q = self.start + fr * self.align + c * (self.bits / 8);
        match (self.tag, self.bits) {
            (1, 8) => (b[q] as f32 - 128.0) / 128.0,
            (1, 16) => i16::from_le_bytes([b[q], b[q + 1]]) as f32 / 32768.0,
            (1, 24) => (((b[q] as i32) << 8 | (b[q + 1] as i32) << 16 | (b[q + 2] as i32) << 24) >> 8) as f32 / 8388608.0,
            (1, _) => i32::from_le_bytes([b[q], b[q + 1], b[q + 2], b[q + 3]]) as f32 / 2147483648.0,
            _ => f32::from_le_bytes([b[q], b[q + 1], b[q + 2], b[q + 3]]),
        }
    }
}

fn read_wav(p: &Path) -> Option<Wav> {
    let md = fs::metadata(p).ok()?;
    if md.len() > 96_000_000 {
        return None;
    }
    let b = fs::read(p).ok()?;
    if b.len() < 44 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return None;
    }
    let u16le = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]) as usize;
    let u32le = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize;
    let (mut tag, mut ch, mut bits, mut align, mut sr) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut data: Option<(usize, usize)> = None;
    let mut o = 12usize;
    while o + 8 <= b.len() {
        let id = &b[o..o + 4];
        let sz = u32le(o + 4);
        let body = o + 8;
        if id == b"fmt " && body + 16 <= b.len() {
            tag = u16le(body);
            ch = u16le(body + 2);
            sr = u32le(body + 4);
            align = u16le(body + 12);
            bits = u16le(body + 14);
            if tag == 0xFFFE && body + 26 <= b.len() {
                tag = u16le(body + 24);
            }
        } else if id == b"data" {
            let len = if sz == 0 || body + sz > b.len() { b.len() - body } else { sz };
            data = Some((body, len));
            break;
        }
        o = body + sz + (sz & 1);
    }
    let (start, len) = data?;
    if ch == 0 || align == 0 || bits == 0 || sr == 0 || !(tag == 1 || tag == 3) {
        return None;
    }
    let bps = bits / 8;
    if bps * ch > align || !(matches!((tag, bits), (1, 8) | (1, 16) | (1, 24) | (1, 32) | (3, 32))) {
        return None;
    }
    let frames = len / align;
    if frames == 0 {
        return None;
    }
    Some(Wav { b, start, tag, bits, ch, align, frames, sr: sr as f32 })
}

fn wav_shape(p: &Path) -> Option<Vec<u8>> {
    let w = read_wav(p)?;
    let (frames, ch) = (w.frames, w.ch);
    let mut env = [0f32; SHAPE_N];
    for (i, e) in env.iter_mut().enumerate() {
        let a = i * frames / SHAPE_N;
        let z = ((i + 1) * frames / SHAPE_N).max(a + 1).min(frames);
        let step = ((z - a) / 1024).max(1);
        let mut m = 0f32;
        let mut fr = a;
        while fr < z {
            for c in 0..ch {
                let v = w.sample(fr, c).abs();
                if v > m {
                    m = v;
                }
            }
            fr += step;
        }
        *e = m;
    }
    let top = env.iter().cloned().fold(0f32, f32::max);
    if !(top > 1e-5) {
        return None;
    }
    Some(env.iter().map(|v| ((v / top).min(1.0) * 255.0).round() as u8).collect())
}

// ---------- sound (average spectrum in log-spaced bands, for "find similar") ----------
const FFT_N: usize = 2048;
const BANDS: usize = 16;
const SOUND_FRAMES: usize = 24;

fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for s in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1f32, 0f32);
            for k in 0..len / 2 {
                let (a, b) = (s + k, s + k + len / 2);
                let (tr, ti) = (re[b] * cr - im[b] * ci, re[b] * ci + im[b] * cr);
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
        len <<= 1;
    }
}

fn wav_sound(p: &Path) -> Option<Vec<u8>> {
    let w = read_wav(p)?;
    let nyq = w.sr / 2.0;
    let hi = (18000f32).min(nyq * 0.95);
    let lo = 60f32;
    if hi <= lo * 2.0 {
        return None;
    }
    let bin_hz = w.sr / FFT_N as f32;
    let edge = |i: usize| lo * (hi / lo).powf(i as f32 / BANDS as f32);
    let win: Vec<f32> = (0..FFT_N).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_N - 1) as f32).cos()).collect();
    let mut acc = [0f64; BANDS];
    let (mut re, mut im) = (vec![0f32; FFT_N], vec![0f32; FFT_N]);
    for k in 0..SOUND_FRAMES {
        let start = if w.frames > FFT_N { k * (w.frames - FFT_N) / (SOUND_FRAMES - 1) } else { 0 };
        for i in 0..FFT_N {
            let fr = start + i;
            re[i] = if fr < w.frames { (0..w.ch).map(|c| w.sample(fr, c)).sum::<f32>() / w.ch as f32 * win[i] } else { 0.0 };
            im[i] = 0.0;
        }
        fft(&mut re, &mut im);
        for band in 0..BANDS {
            let (a, z) = ((edge(band) / bin_hz).round() as usize, (edge(band + 1) / bin_hz).round() as usize);
            let (a, z) = (a.max(1).min(FFT_N / 2 - 1), z.max(a + 1).min(FFT_N / 2));
            let mut sum = 0f64;
            for bin in a..z {
                sum += (re[bin] * re[bin] + im[bin] * im[bin]) as f64;
            }
            acc[band] += sum / (z - a) as f64;
        }
    }
    let db: Vec<f64> = acc.iter().map(|v| 10.0 * (v / SOUND_FRAMES as f64 + 1e-12).log10()).collect();
    let top = db.iter().cloned().fold(f64::MIN, f64::max);
    if top < -90.0 {
        return None;
    }
    Some(db.iter().map(|d| (((d - top + 70.0) / 70.0).clamp(0.0, 1.0) * 255.0).round() as u8).collect())
}

#[derive(Serialize, Deserialize, Clone)]
struct ShapeEntry {
    m: u64,
    s: u64,
    v: Vec<u8>,
}

#[tauri::command]
async fn shapes(app: AppHandle) -> Result<HashMap<String, Vec<u8>>, String> {
    let root = get_root_path(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let cache_path = data_dir(&app).join("shape-cache.json");
        let cache: HashMap<String, ShapeEntry> =
            fs::read_to_string(&cache_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let files: Vec<PathBuf> = walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && e.path().extension().and_then(|x| x.to_str()).map_or(false, |x| x.eq_ignore_ascii_case("wav")))
            .map(|e| e.into_path())
            .collect();
        let total = files.len();
        let done = AtomicUsize::new(0);
        let out: Vec<(String, ShapeEntry)> = files
            .par_iter()
            .filter_map(|p| {
                let md = fs::metadata(p).ok()?;
                let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                let key = p.to_string_lossy().to_string();
                let entry = match cache.get(&key) {
                    Some(c) if c.m == mtime && c.s == md.len() => c.clone(),
                    _ => ShapeEntry { m: mtime, s: md.len(), v: wav_shape(p).unwrap_or_default() },
                };
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                if d % 32 == 0 || d == total {
                    let _ = app.emit("shape-progress", json!({ "done": d, "total": total }));
                }
                Some((key, entry))
            })
            .collect();
        let new_cache: HashMap<String, ShapeEntry> = out.into_iter().collect();
        if let Ok(s) = serde_json::to_string(&new_cache) {
            let _ = fs::write(cache_path, s);
        }
        new_cache.into_iter().filter(|(_, e)| !e.v.is_empty()).map(|(k, e)| (k, e.v)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

fn cached_index(app: &AppHandle, file: &str, make: fn(&Path) -> Option<Vec<u8>>, progress: &str) -> HashMap<String, Vec<u8>> {
    let root = get_root_path(app);
    let cache_path = data_dir(app).join(file);
    let cache: HashMap<String, ShapeEntry> = fs::read_to_string(&cache_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let files: Vec<PathBuf> = walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.path().extension().and_then(|x| x.to_str()).map_or(false, |x| x.eq_ignore_ascii_case("wav")))
        .map(|e| e.into_path())
        .collect();
    let total = files.len();
    let done = AtomicUsize::new(0);
    let out: Vec<(String, ShapeEntry)> = files
        .par_iter()
        .filter_map(|p| {
            let md = fs::metadata(p).ok()?;
            let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            let key = p.to_string_lossy().to_string();
            let entry = match cache.get(&key) {
                Some(c) if c.m == mtime && c.s == md.len() => c.clone(),
                _ => ShapeEntry { m: mtime, s: md.len(), v: make(p).unwrap_or_default() },
            };
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            if d % 32 == 0 || d == total {
                let _ = app.emit(progress, json!({ "done": d, "total": total }));
            }
            Some((key, entry))
        })
        .collect();
    let new_cache: HashMap<String, ShapeEntry> = out.into_iter().collect();
    if let Ok(s) = serde_json::to_string(&new_cache) {
        let _ = fs::write(cache_path, s);
    }
    new_cache.into_iter().filter(|(_, e)| !e.v.is_empty()).map(|(k, e)| (k, e.v)).collect()
}

#[tauri::command]
async fn sounds(app: AppHandle) -> Result<HashMap<String, Vec<u8>>, String> {
    tauri::async_runtime::spawn_blocking(move || cached_index(&app, "sound-cache.json", wav_sound, "sound-progress"))
        .await
        .map_err(|e| e.to_string())
}

// ---------- commands ----------
#[tauri::command]
fn get_root(app: AppHandle) -> String {
    get_root_path(&app).to_string_lossy().to_string()
}

#[tauri::command]
async fn scan(app: AppHandle, force: bool) -> Result<Vec<Item>, String> {
    let root = get_root_path(&app);
    tauri::async_runtime::spawn_blocking(move || scan_root(&app, &root, force)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder(app: AppHandle, window: WebviewWindow) -> Option<String> {
    let start = get_root_path(&app);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new().set_parent(&window).set_directory(start).pick_folder()
    })
    .await
    .ok()??;
    let mut s = load_settings(&app);
    s["root"] = json!(picked.to_string_lossy());
    save_settings(&app, &s);
    Some(picked.to_string_lossy().to_string())
}

#[tauri::command]
async fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    let mut f = fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = f.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(len as usize);
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(buf))
}

#[tauri::command]
fn drag_start(window: WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    drag::start_drag(
        &window,
        drag::DragItem::Files(paths.into_iter().map(PathBuf::from).collect()),
        drag::Image::Raw(DRAG_ICON.to_vec()),
        |_result, _pos| {},
        drag::Options::default(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// Downloads the release installer with the curl that ships with Windows and runs it (it closes and relaunches the app).
#[tauri::command]
async fn install_update(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/kalakaritzu/packs-viewer/releases/download/") {
        return Err("unexpected update url".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::os::windows::process::CommandExt;
        let out = std::env::temp_dir().join("Packs-Viewer-Setup.exe");
        let _ = fs::remove_file(&out);
        let ok = std::process::Command::new("curl.exe")
            .args(["-L", "-f", "-s", "-o"])
            .arg(&out)
            .arg(&url)
            .creation_flags(0x0800_0000)
            .status()
            .map_err(|e| e.to_string())?
            .success();
        if !ok || fs::metadata(&out).map(|m| m.len()).unwrap_or(0) < 100_000 {
            return Err("download failed".to_string());
        }
        std::process::Command::new(&out).spawn().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn win_close(window: WebviewWindow) {
    save_position(&window);
    window.app_handle().exit(0);
}

#[tauri::command]
fn win_min(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_pin(window: WebviewWindow, on: bool) {
    let _ = window.set_always_on_top(on);
}

#[tauri::command]
fn win_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
fn reveal(path: String) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", path)).spawn();
}

#[tauri::command]
fn copy_path(path: String) {
    if let Ok(mut c) = arboard::Clipboard::new() {
        let _ = c.set_text(path);
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_root, scan, shapes, sounds, app_version, install_update, pick_folder, read_file, drag_start, win_close, win_min, win_pin, win_drag, reveal, copy_path
        ])
        .setup(|app| {
            let win = app.get_webview_window("main").unwrap();
            if let Some(b) = load_settings(app.handle()).get("bounds") {
                if let (Some(x), Some(y)) = (b["x"].as_i64(), b["y"].as_i64()) {
                    let on_screen = win
                        .available_monitors()
                        .unwrap_or_default()
                        .iter()
                        .any(|m| {
                            let (p, s) = (m.position(), m.size());
                            x >= p.x as i64 - 50 && y >= p.y as i64 - 50 && x < p.x as i64 + s.width as i64 - 100 && y < p.y as i64 + s.height as i64 - 100
                        });
                    if on_screen {
                        let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
                    }
                }
            }
            let _ = win.show();
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                    save_position(&w);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Packs Viewer");
}
