//! A source backed by a `.gsim_samples` file.
//!
//! ## Why the format is not defined here
//!
//! The container is `gsim-samples`, a crate in general-simulator, and this is
//! only its reader-side adapter. The solver writes the samples, so it owns
//! the format they are written in; the alternative would have the solver
//! depend on the editor to serialize its own output. The crate is pure Rust
//! with `serde` and nothing else, specifically so that it compiles to
//! WebAssembly along with this one.
//!
//! ## What this adapter is for
//!
//! Two things [`gsim_samples::Reader`] deliberately does not do.
//!
//! It does not reduce to an exact point budget: it returns a whole rung of
//! the pyramid, between the budget and 64 times it. The last step down is
//! here because it belongs wherever the chart's own bucket edges are
//! decided, and those are in [`crate::decimate`], ported from the Python
//! that came before and matched to it down to half-to-even rounding on a
//! bucket boundary. Two implementations of that step is the bug this whole
//! crate exists to end, so there is one, and the file format does not get
//! its own.
//!
//! It also does not know what a signal *is* — the solver's column headers
//! carry no units, because a netlist does not have any. Units, quantities
//! and the sweep's domain come from the `.gsim_sim_result` manifest beside
//! the file, via [`SamplesSource::with_manifest`]. Inventing them here would
//! make this a second, disagreeing source for them.

use crate::decimate::minmax_envelope;
use crate::manifest::{DataKind, Document};
use crate::source::{SignalMeta, Slice, WaveformSource};
use crate::{Error, Result};

pub use gsim_samples::Bytes;

/// Reading samples from a `.gsim_samples` file.
pub struct SamplesSource<B: Bytes> {
    reader: gsim_samples::Reader<B>,
    meta: Vec<SignalMeta>,
    sweep_domain: String,
}

fn adapt(error: gsim_samples::Error) -> Error {
    match error {
        gsim_samples::Error::Missing(what) => Error::Missing(what),
        // A truncated file and an unreadable one are both "these bytes are
        // not a result", which is what `Parse` means here. The message
        // carries the distinction, since that is what a user acts on.
        other => Error::Parse(other.to_string()),
    }
}

/// The solver writes column names and no units, so an absent unit is absent
/// rather than wrong. `quantity` and `analysis` default the way
/// `InlineSource` defaults them, so a chart sees one shape whichever source
/// it got.
fn meta_from_container(signal: &gsim_samples::VectorMeta) -> SignalMeta {
    SignalMeta {
        name: signal.name.clone(),
        unit: signal.unit.clone(),
        quantity: if signal.quantity.is_empty() {
            "dimensionless".into()
        } else {
            signal.quantity.clone()
        },
        analysis: if signal.analysis.is_empty() {
            "tran".into()
        } else {
            signal.analysis.clone()
        },
    }
}

impl<B: Bytes> SamplesSource<B> {
    /// Opens a sample file on its own, naming each signal as the container
    /// does.
    pub fn open(bytes: B) -> Result<Self> {
        let reader = gsim_samples::Reader::open(bytes).map_err(adapt)?;
        let meta = reader.signals().iter().map(meta_from_container).collect();
        Ok(Self {
            reader,
            meta,
            sweep_domain: "time".into(),
        })
    }

    /// Opens a sample file that a `.gsim_sim_result` document points at,
    /// taking each signal's unit, quantity and analysis from the document.
    ///
    /// The document is the authority on what a signal means and the
    /// container is the authority on its samples, so a name in the document
    /// that the container does not carry is an error rather than something
    /// to paper over: it means the two were written apart.
    pub fn with_manifest(bytes: B, document: &Document) -> Result<Self> {
        if document.kind() != DataKind::Samples {
            return Err(Error::External(format!(
                "this result's samples are stored as {:?}, not in a .gsim_samples file",
                document.kind()
            )));
        }
        let reader = gsim_samples::Reader::open(bytes).map_err(adapt)?;

        let mut meta = Vec::with_capacity(document.signals.len());
        for vector in &document.signals {
            if !reader.signals().iter().any(|s| s.name == vector.name) {
                return Err(Error::Missing(format!(
                    "the manifest names \"{}\", which its sample file does not carry",
                    vector.name
                )));
            }
            meta.push(SignalMeta {
                name: vector.name.clone(),
                unit: vector.unit.clone(),
                quantity: vector
                    .quantity
                    .clone()
                    .unwrap_or_else(|| "dimensionless".into()),
                analysis: vector.analysis.clone().unwrap_or_else(|| "tran".into()),
            });
        }

        Ok(Self {
            reader,
            meta,
            sweep_domain: document
                .sweep
                .domain
                .clone()
                .unwrap_or_else(|| "time".into()),
        })
    }

    /// Samples per signal in the run, which is not the number of points any
    /// read returns.
    pub fn rows(&self) -> u64 {
        self.reader.rows()
    }

    /// The sweep extent, taken from the container's stripe directory rather
    /// than from any sample.
    pub fn extent(&self) -> Option<(f64, f64)> {
        self.reader.extent()
    }

    /// Which rung a given question would be answered from. Exposed because
    /// it is the one number that explains a read's cost.
    pub fn detail_for(
        &self,
        window: Option<(f64, f64)>,
        max_points: usize,
    ) -> gsim_samples::Detail {
        self.reader.detail_for(window, max_points)
    }
}

impl<B: Bytes> WaveformSource for SamplesSource<B> {
    fn signals(&self) -> &[SignalMeta] {
        &self.meta
    }

    fn sweep_domain(&self) -> &str {
        &self.sweep_domain
    }

    fn slice(
        &self,
        names: &[String],
        window: Option<(f64, f64)>,
        max_points: usize,
    ) -> Result<Slice> {
        // Names are resolved against this adapter's own metadata first, so
        // that a manifest that lists a signal the container lacks fails the
        // same way whichever source is in use -- `Error::Missing`, naming it.
        for name in names {
            if !self.meta.iter().any(|m| &m.name == name) {
                return Err(Error::Missing(format!(
                    "no signal named \"{name}\" in this result"
                )));
            }
        }

        let rung = self
            .reader
            .slice(names, window, max_points)
            .map_err(adapt)?;

        if rung.sweep.is_empty() {
            return Ok(Slice {
                sweep: Vec::new(),
                values: vec![Vec::new(); names.len()],
            });
        }

        // The envelope again, over a rung that is already min/max pairs.
        // That composes correctly rather than by luck: each bucket takes the
        // extremes of what it sees, and the extremes of a set of per-block
        // extremes are the extremes of the blocks. A peak that reached the
        // rung reaches the screen.
        let columns: Vec<&[f64]> = rung.values.iter().map(Vec::as_slice).collect();
        let (sweep, values) = minmax_envelope(&rung.sweep, &columns, max_points);
        Ok(Slice { sweep, values })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::InlineSource;
    use gsim_samples::{Detail, VectorMeta, Writer};

    const SPIKE: f64 = 500.0;

    /// A run both sources can be built from: the same samples, one written
    /// into a container and one into an inline document.
    fn run(rows: usize) -> (Vec<u8>, String, usize) {
        let spike_at = rows / 3;
        let value = |row: usize| {
            if row == spike_at {
                SPIKE
            } else {
                (row as f64 / 11.0).sin()
            }
        };

        let mut bytes = Vec::new();
        let mut writer = match Writer::new(
            &mut bytes,
            VectorMeta::new("t"),
            vec![VectorMeta::new("V(out)"), VectorMeta::new("I(L1)")],
        ) {
            Ok(w) => w,
            Err(e) => panic!("a writer: {e}"),
        };
        for row in 0..rows {
            writer
                .push(row as f64 * 1e-9, &[value(row), -value(row)])
                .expect("push");
        }
        writer.finish().expect("finish");

        let time: Vec<String> = (0..rows).map(|r| (r as f64 * 1e-9).to_string()).collect();
        let out: Vec<String> = (0..rows).map(|r| (value(r) as f32).to_string()).collect();
        let il: Vec<String> = (0..rows).map(|r| (-value(r) as f32).to_string()).collect();
        let document = format!(
            r#"{{
              "schema_version": 2,
              "run": {{ "id": "r", "analysis": "TRAN" }},
              "data": {{ "kind": "inline" }},
              "sweep": {{ "name": "t", "unit": "s", "domain": "time",
                         "encoding": "json", "data": [{}] }},
              "signals": [
                {{ "name": "V(out)", "unit": "V", "quantity": "voltage",
                   "encoding": "json", "data": [{}] }},
                {{ "name": "I(L1)", "unit": "A", "quantity": "current",
                   "encoding": "json", "data": [{}] }}
              ]
            }}"#,
            time.join(","),
            out.join(","),
            il.join(",")
        );
        (bytes, document, spike_at)
    }

    fn manifest(rows: usize) -> String {
        let _ = rows;
        r#"{
          "schema_version": 2,
          "run": { "id": "r", "analysis": "TRAN" },
          "data": { "kind": "samples", "path": "run.gsim_samples", "pyramid": true },
          "sweep": { "name": "t", "unit": "s", "domain": "time" },
          "signals": [
            { "name": "V(out)", "unit": "V", "quantity": "voltage", "analysis": "tran" },
            { "name": "I(L1)", "unit": "A", "quantity": "current", "analysis": "tran" }
          ]
        }"#
        .to_string()
    }

    #[test]
    fn it_reads_back_what_was_written() {
        let (bytes, _, _) = run(500);
        let source = SamplesSource::open(bytes).expect("opens");
        assert_eq!(source.rows(), 500);
        assert_eq!(source.signals().len(), 2);
        assert_eq!(source.signals()[0].name, "V(out)");
        // No units in a netlist's column headers, so none invented here.
        assert_eq!(source.signals()[0].unit, "");
        assert_eq!(source.signals()[0].quantity, "dimensionless");

        let slice = source
            .slice(&["V(out)".to_string()], None, 10_000)
            .expect("slice");
        assert_eq!(slice.sweep.len(), 500);
        assert_eq!(slice.values[0].len(), 500);
    }

    #[test]
    fn it_draws_the_same_trace_an_inline_document_would() {
        // The premise of this crate: a trace must not change shape with
        // where its samples were. Both sources hold identical data and both
        // reduce it with `minmax_envelope`, so for a run small enough to be
        // read at level 0 the two answers have to match exactly.
        let (bytes, document, _) = run(4_000);
        let from_container = SamplesSource::open(bytes).expect("opens");
        let from_document = InlineSource::parse(&document).expect("parses");

        assert_eq!(
            from_container.detail_for(None, 600),
            Detail::Level(0),
            "this run should be small enough to read whole"
        );

        let names = vec!["V(out)".to_string(), "I(L1)".to_string()];
        let a = from_container.slice(&names, None, 600).expect("slice");
        let b = from_document.slice(&names, None, 600).expect("slice");

        assert_eq!(a.sweep.len(), b.sweep.len());
        for (i, (left, right)) in a.sweep.iter().zip(&b.sweep).enumerate() {
            assert!((left - right).abs() < 1e-18, "sweep {i}: {left} vs {right}");
        }
        for (column, (left, right)) in a.values.iter().zip(&b.values).enumerate() {
            assert_eq!(left.len(), right.len(), "column {column} length");
            for (i, (l, r)) in left.iter().zip(right).enumerate() {
                assert!(
                    (l - r).abs() < 1e-6,
                    "column {column} point {i}: {l} vs {r}"
                );
            }
        }
    }

    #[test]
    fn a_spike_survives_a_reduction_that_reads_a_coarse_rung() {
        // 300,000 rows against a 400-point budget: the read cannot be at
        // level 0, so the peak has to come back through the pyramid and then
        // through the envelope. Either one losing it would show here.
        let (bytes, _, _) = run(300_000);
        let source = SamplesSource::open(bytes).expect("opens");
        assert_ne!(source.detail_for(None, 400), Detail::Level(0));

        let slice = source
            .slice(&["V(out)".to_string()], None, 400)
            .expect("slice");
        let peak = slice.values[0]
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(
            (peak - SPIKE).abs() < 1.0,
            "the reduction lost the spike: peak {peak}"
        );
        assert!(
            slice.sweep.len() <= 400,
            "{} points for a 400 budget",
            slice.sweep.len()
        );
    }

    #[test]
    fn a_window_narrows_what_is_read() {
        let (bytes, _, _) = run(200_000);
        let source = SamplesSource::open(bytes).expect("opens");
        let (from, to) = source.extent().expect("an extent");
        assert!(to > from);

        let slice = source
            .slice(
                &["V(out)".to_string()],
                Some((from, from + (to - from) / 50.0)),
                500,
            )
            .expect("slice");
        assert!(!slice.sweep.is_empty());
        let last = *slice.sweep.last().expect("a last point");
        // A stripe is the unit a read cannot subdivide, so the window may
        // overshoot by up to one stripe -- but not by the whole run.
        assert!(
            last < from + (to - from) / 2.0,
            "a 2% window came back spanning to {last} of {to}"
        );
    }

    #[test]
    fn the_manifest_supplies_the_units_the_container_has_none_of() {
        let (bytes, _, _) = run(100);
        let document = Document::parse(&manifest(100)).expect("parses");
        let source = SamplesSource::with_manifest(bytes, &document).expect("opens");
        assert_eq!(source.sweep_domain(), "time");
        assert_eq!(source.signals()[0].unit, "V");
        assert_eq!(source.signals()[0].quantity, "voltage");
        assert_eq!(source.signals()[1].unit, "A");
        assert_eq!(source.signals()[1].quantity, "current");
    }

    #[test]
    fn a_manifest_naming_a_signal_the_file_lacks_says_which() {
        let (bytes, _, _) = run(100);
        let document =
            Document::parse(&manifest(100).replace("\"I(L1)\"", "\"I(nowhere)\"")).expect("parses");
        let error = SamplesSource::with_manifest(bytes, &document)
            .map(|_| ())
            .expect_err("a mismatch must not open");
        assert!(error.to_string().contains("I(nowhere)"), "{error}");
    }

    #[test]
    fn an_inline_manifest_is_refused_rather_than_read_as_a_file() {
        let (bytes, document, _) = run(100);
        let document = Document::parse(&document).expect("parses");
        let error = SamplesSource::with_manifest(bytes, &document)
            .map(|_| ())
            .expect_err("an inline document is not this source's");
        assert!(
            error.to_string().contains("not in a .gsim_samples file"),
            "{error}"
        );
    }

    #[test]
    fn asking_for_a_signal_that_is_not_there_names_it() {
        let (bytes, _, _) = run(100);
        let source = SamplesSource::open(bytes).expect("opens");
        let error = source
            .slice(&["V(nowhere)".to_string()], None, 100)
            .map(|_| ())
            .expect_err("an unknown signal");
        assert!(error.to_string().contains("V(nowhere)"), "{error}");
    }

    #[test]
    fn bytes_that_are_not_a_sample_file_are_refused() {
        let error = SamplesSource::open(vec![0u8; 64])
            .map(|_| ())
            .expect_err("random bytes");
        assert!(
            error.to_string().contains("not a .gsim_samples file"),
            "{error}"
        );
    }
}
