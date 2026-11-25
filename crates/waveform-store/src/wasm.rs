//! The WebAssembly surface.
//!
//! The viewer holds one of these per open result and asks it for a window
//! whenever the view changes. The same crate, compiled natively, answers the
//! same question on a server — which is the point: the picture cannot differ
//! between the two, because the reduction is literally the same code.
//!
//! ## The shape of a slice crossing the boundary
//!
//! A slice comes back as one flat `Float64Array` laid out as
//! `[sweep…, signal0…, signal1…, …]`, not as an array of arrays. Each
//! JavaScript object created at the boundary costs a conversion, and a
//! 12-signal query would otherwise build 13 of them plus their contents on
//! every zoom. The caller knows how many signals it asked for, so it can
//! subarray the one buffer at no cost at all.

use js_sys::Float64Array;
use wasm_bindgen::prelude::*;

use crate::source::{InlineSource, WaveformSource};

#[wasm_bindgen]
pub struct WaveformStore {
    source: InlineSource,
}

#[wasm_bindgen]
impl WaveformStore {
    /// Read a `.gsim_sim_result` whose samples are inline.
    #[wasm_bindgen(constructor)]
    pub fn new(manifest_json: &str) -> Result<WaveformStore, JsError> {
        InlineSource::parse(manifest_json)
            .map(|source| WaveformStore { source })
            .map_err(|error| JsError::new(&error.to_string()))
    }

    /// The signals this result holds, as JSON: `[{name, unit, quantity, analysis}]`.
    ///
    /// JSON rather than a typed array of objects because it is read once per
    /// opened file, where a typed boundary would cost more in generated glue
    /// than it saves.
    #[wasm_bindgen(js_name = signalsJson)]
    pub fn signals_json(&self) -> String {
        let entries: Vec<String> = self
            .source
            .signals()
            .iter()
            .map(|signal| {
                format!(
                    r#"{{"name":{},"unit":{},"quantity":{},"analysis":{}}}"#,
                    json_string(&signal.name),
                    json_string(&signal.unit),
                    json_string(&signal.quantity),
                    json_string(&signal.analysis),
                )
            })
            .collect();
        format!("[{}]", entries.join(","))
    }

    #[wasm_bindgen(js_name = sweepDomain)]
    pub fn sweep_domain(&self) -> String {
        self.source.sweep_domain().to_string()
    }

    /// `[sweep…, signal0…, …]` for `names` over `[from, to]`, at most
    /// `max_points` samples each.
    ///
    /// Pass `from`/`to` as `undefined` for the whole extent.
    pub fn slice(
        &self,
        names: Vec<String>,
        from: Option<f64>,
        to: Option<f64>,
        max_points: usize,
    ) -> Result<Float64Array, JsError> {
        let window = match (from, to) {
            (Some(from), Some(to)) => Some((from, to)),
            _ => None,
        };
        let slice = self
            .source
            .slice(&names, window, max_points)
            .map_err(|error| JsError::new(&error.to_string()))?;

        let points = slice.sweep.len();
        let mut flat = Vec::with_capacity(points * (1 + slice.values.len()));
        flat.extend_from_slice(&slice.sweep);
        for column in &slice.values {
            flat.extend_from_slice(column);
        }
        Ok(Float64Array::from(&flat[..]))
    }
}

/// Minimal JSON string escaping, enough for signal names and units.
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

use crate::ranges::{footer_span, prologue_spans, tail_span, PrefetchedBytes, RecordingBytes};
use crate::samples::SamplesSource;

/// Bytes the host fetched, on their way back in.
///
/// A handle rather than one big argument because the ranges arrive one reply
/// at a time: the viewer plans, the host answers each range, and each answer
/// is put here as it lands. Passing them as a single concatenated buffer would
/// mean the caller rebuilding the offsets this already knows.
#[wasm_bindgen]
pub struct FetchedRanges {
    inner: PrefetchedBytes,
}

#[wasm_bindgen]
impl FetchedRanges {
    #[wasm_bindgen(constructor)]
    pub fn new(size: f64) -> FetchedRanges {
        FetchedRanges {
            inner: PrefetchedBytes::new(size as u64),
        }
    }

    /// One fetched range. `offset` is a file offset; a `f64` carries any
    /// integer below 2^53, which is nine petabytes.
    pub fn put(&mut self, offset: f64, bytes: &[u8]) {
        self.inner.add(offset as u64, bytes.to_vec());
    }

    /// Bytes held — what the last read actually cost to fetch.
    #[wasm_bindgen(js_name = bytesHeld)]
    pub fn bytes_held(&self) -> usize {
        self.inner.bytes_held()
    }
}

fn spans_to_array(spans: &[crate::ranges::Span]) -> Float64Array {
    // `[offset, len, offset, len, …]`, for the same reason a slice is one flat
    // array: a pair of numbers per range is not worth an object each.
    let mut flat = Vec::with_capacity(spans.len() * 2);
    for span in spans {
        flat.push(span.offset as f64);
        flat.push(span.len as f64);
    }
    Float64Array::from(&flat[..])
}

/// A `.gsim_samples` file, read through ranges somebody else fetches.
///
/// The viewer cannot read a file and the host cannot decimate (#175), so this
/// is the half that knows *which bytes are needed*. The sequence is:
///
/// 1. [`SamplesFile::tailSpan`], then [`SamplesFile::footerSpan`], then
///    [`SamplesFile::prologueSpans`] — three small reads whose locations are
///    arithmetic, fetched by the host.
/// 2. `new SamplesFile(size, prologue)`, which opens the file and fails here
///    if it is truncated or not one.
/// 3. [`SamplesFile::plan`] for a window, then the host fetches those ranges,
///    then [`SamplesFile::slice`] returns the points.
///
/// Every offset in that sequence is computed here. The caller fetches and
/// does no arithmetic, which is the point: there is one implementation of the
/// layout and it is the one the writer agrees with.
#[wasm_bindgen]
pub struct SamplesFile {
    size: u64,
    prologue: PrefetchedBytes,
}

#[wasm_bindgen]
impl SamplesFile {
    /// The last sixteen bytes: a footer offset and the trailing magic.
    #[wasm_bindgen(js_name = tailSpan)]
    pub fn tail_span_for(size: f64) -> Float64Array {
        spans_to_array(&[tail_span(size as u64)])
    }

    /// Where the footer is, from those sixteen bytes. Errors on a missing
    /// trailing magic, which means the run never finished writing.
    #[wasm_bindgen(js_name = footerSpan)]
    pub fn footer_span_for(size: f64, tail: &[u8]) -> Result<Float64Array, JsError> {
        footer_span(size as u64, tail)
            .map(|span| spans_to_array(&[span]))
            .map_err(|error| JsError::new(&error.to_string()))
    }

    /// The header, stripe directory and summary, from the footer's JSON.
    #[wasm_bindgen(js_name = prologueSpans)]
    pub fn prologue_spans_for(footer_json: &str) -> Result<Float64Array, JsError> {
        prologue_spans(footer_json)
            .map(|spans| spans_to_array(&spans))
            .map_err(|error| JsError::new(&error.to_string()))
    }

    #[wasm_bindgen(constructor)]
    pub fn new(size: f64, prologue: &FetchedRanges) -> Result<SamplesFile, JsError> {
        let file = SamplesFile {
            size: size as u64,
            prologue: prologue.inner.clone(),
        };
        // Opened once here so that a file which is truncated, or not one at
        // all, says so before a viewer starts asking it for windows.
        file.source(&PrefetchedBytes::new(size as u64))
            .map(|_| ())
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(file)
    }

    fn source(&self, fetched: &PrefetchedBytes) -> crate::Result<SamplesSource<PrefetchedBytes>> {
        SamplesSource::open(self.prologue.merged(fetched))
    }

    /// The signals this file holds, as JSON: `[{name, unit, quantity, analysis}]`.
    #[wasm_bindgen(js_name = signalsJson)]
    pub fn signals_json(&self) -> Result<String, JsError> {
        let source = self
            .source(&PrefetchedBytes::new(self.size))
            .map_err(|error| JsError::new(&error.to_string()))?;
        let mut out = String::from("[");
        for (i, signal) in source.signals().iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "{{\"name\":{},\"unit\":{},\"quantity\":{},\"analysis\":{}}}",
                json_string(&signal.name),
                json_string(&signal.unit),
                json_string(&signal.quantity),
                json_string(&signal.analysis)
            ));
        }
        out.push(']');
        Ok(out)
    }

    /// Samples per signal in the run — not the number of points a read returns.
    pub fn rows(&self) -> Result<f64, JsError> {
        self.source(&PrefetchedBytes::new(self.size))
            .map(|source| source.rows() as f64)
            .map_err(|error| JsError::new(&error.to_string()))
    }

    /// `[from, to]`, taken from the stripe directory rather than any sample.
    /// Empty when the file holds no stripes.
    pub fn extent(&self) -> Result<Float64Array, JsError> {
        let source = self
            .source(&PrefetchedBytes::new(self.size))
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(match source.extent() {
            Some((from, to)) => Float64Array::from(&[from, to][..]),
            None => Float64Array::new_with_length(0),
        })
    }

    /// The ranges a window would read, as `[offset, len, …]`, coalesced.
    ///
    /// A recording pass: the answer depends on the stripe geometry, the
    /// directory and the rung, all of which are in the prologue already — no
    /// sample value takes part, which is why the second pass asks for exactly
    /// these.
    pub fn plan(
        &self,
        names: Vec<String>,
        from: Option<f64>,
        to: Option<f64>,
        max_points: usize,
    ) -> Result<Float64Array, JsError> {
        let recorder = RecordingBytes::seeded(self.size, self.prologue.clone());
        let source =
            SamplesSource::open(&recorder).map_err(|error| JsError::new(&error.to_string()))?;
        source
            .slice(&names, window_of(from, to), max_points)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(spans_to_array(&recorder.spans()))
    }

    /// The window, from ranges a [`SamplesFile::plan`] asked for.
    ///
    /// Flat: `[sweep…, signal0…, …]`, for the reason the inline store's slice
    /// is flat — the caller knows how many signals it asked for and can
    /// subarray one buffer at no cost.
    pub fn slice(
        &self,
        names: Vec<String>,
        from: Option<f64>,
        to: Option<f64>,
        max_points: usize,
        fetched: &FetchedRanges,
    ) -> Result<Float64Array, JsError> {
        let source = self
            .source(&fetched.inner)
            .map_err(|error| JsError::new(&error.to_string()))?;
        let slice = source
            .slice(&names, window_of(from, to), max_points)
            .map_err(|error| JsError::new(&error.to_string()))?;

        let points = slice.sweep.len();
        let mut flat = Vec::with_capacity(points * (1 + slice.values.len()));
        flat.extend_from_slice(&slice.sweep);
        for column in &slice.values {
            flat.extend_from_slice(column);
        }
        Ok(Float64Array::from(&flat[..]))
    }
}

/// `undefined` for either end means the whole extent, matching the inline
/// store's own `slice`.
fn window_of(from: Option<f64>, to: Option<f64>) -> Option<(f64, f64)> {
    match (from, to) {
        (Some(from), Some(to)) => Some((from, to)),
        _ => None,
    }
}

/// Reduce samples already in the page to a point budget, peak-preserving.
///
/// ## Why this is here as well as [`SamplesFile::slice`]
///
/// A container is not the only way samples reach the viewer. A
/// `kind: "inline"` result carries them in the document, a capture replayed
/// from a file is read by the editor, and a previous run kept for an overlay
/// is already in memory. All of those still have to be reduced to what a plot
/// can show, and before this they were reduced by a hand-maintained
/// TypeScript copy of [`crate::decimate::minmax_envelope`] whose own comment
/// said so (#157). One algorithm means one of them, and the one that survives
/// is the one the writer and the server already agree with.
///
/// Flat in and flat out, for the reason a slice is flat: `columns` is
/// `column_count` runs of `time.len()` values laid end to end, and the result
/// is `[time…, column0…, column1…, …]` over however many points the budget
/// left. The caller knows both counts, so it can subarray one buffer at no
/// cost instead of paying for an object per column at the boundary.
#[wasm_bindgen(js_name = minmaxEnvelope)]
pub fn minmax_envelope_flat(
    time: &[f64],
    columns: &[f64],
    column_count: usize,
    max_points: usize,
) -> Result<Float64Array, JsError> {
    let rows = time.len();
    if columns.len() != rows * column_count {
        // Caught here rather than read past the end of a column: the two
        // lengths are the whole contract of a flat boundary, and a caller
        // that got them wrong would otherwise be handed a plausible-looking
        // reduction of somebody else's samples.
        return Err(JsError::new(&format!(
            "{column_count} columns of {rows} samples is {} values, but {} were given",
            rows * column_count,
            columns.len()
        )));
    }

    let borrowed: Vec<&[f64]> = (0..column_count)
        .map(|index| &columns[index * rows..(index + 1) * rows])
        .collect();
    let (out_time, out_columns) = crate::decimate::minmax_envelope(time, &borrowed, max_points);

    let mut flat = Vec::with_capacity(out_time.len() * (1 + column_count));
    flat.extend_from_slice(&out_time);
    for column in &out_columns {
        flat.extend_from_slice(column);
    }
    Ok(Float64Array::from(&flat[..]))
}
