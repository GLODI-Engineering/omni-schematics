//! Reading a sample file the viewer cannot open.
//!
//! ## The problem this exists for
//!
//! `gsim_samples::Reader` asks its `Bytes` source for ranges synchronously,
//! which is right natively and impossible in a webview: the only way for
//! WebAssembly in a webview to reach a file on disk is to ask the extension
//! host, and that round trip is asynchronous. The host cannot do the reading
//! itself either -- it has no engine, because `vsce package --no-dependencies`
//! ships no `node_modules` (#175).
//!
//! So the read is split in two passes over the same question:
//!
//! 1. [`RecordingBytes`] answers every read with zeros and writes down what
//!    was asked for. The caller fetches exactly those ranges, asynchronously,
//!    from wherever the bytes live.
//! 2. [`PrefetchedBytes`] serves them back, and the identical call runs again
//!    for real.
//!
//! ## Why the two passes ask for the same thing
//!
//! Not by luck, and worth stating because the whole scheme rests on it. Which
//! ranges a read touches is decided by the stripe geometry, the directory and
//! the chosen pyramid rung -- the index arithmetic in `gsim_samples::format`
//! and the sweep extremes in the stripe directory. All of that is prefetched
//! before either pass. **No sample value takes part in the decision.** Window
//! trimming does look at sweep values, but it happens after the reads and
//! changes nothing about which were made.
//!
//! The first pass therefore cannot be misled by its own zeros. A test holds
//! this: the same query, answered from a whole-file source and from a
//! two-pass one, returns identical points.

use std::cell::RefCell;

use gsim_samples::{Bytes, Error as SamplesError, Result as SamplesResult};

/// One contiguous read: where, and how many bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Span {
    pub offset: u64,
    pub len: usize,
}

impl Span {
    fn end(&self) -> u64 {
        self.offset + self.len as u64
    }
}

/// Records what a read asks for, answering with zeros.
///
/// `size` has to be the real file length: the reader locates the footer from
/// the tail, so a wrong length sends the first pass to the wrong offsets and
/// the recording is of a file that does not exist.
#[derive(Debug)]
pub struct RecordingBytes {
    size: u64,
    /// The prologue, served for real rather than recorded.
    ///
    /// Opening a file reads its trailing magic, its footer, the stripe
    /// directory and the summary, and all four have to be the true bytes: a
    /// zeroed tail fails the magic check, so a purely zero-answering recorder
    /// could never get far enough to record anything. The caller fetches that
    /// prologue first -- it is small and its location is arithmetic -- and
    /// seeds it here, after which every further read is a sample read and is
    /// what this type is for.
    known: PrefetchedBytes,
    spans: RefCell<Vec<Span>>,
}

impl RecordingBytes {
    pub fn new(size: u64) -> Self {
        Self::seeded(size, PrefetchedBytes::new(size))
    }

    /// A recorder that answers the prologue truthfully.
    pub fn seeded(size: u64, known: PrefetchedBytes) -> Self {
        Self {
            size,
            known,
            spans: RefCell::new(Vec::new()),
        }
    }

    /// What was asked for, coalesced: sorted, and adjacent or overlapping
    /// spans merged.
    ///
    /// Merged because a signal's level and the sweep's level in the same
    /// stripe are usually neighbours, and a host serving twenty ranges of a
    /// few hundred bytes each pays twenty round trips for one region. The
    /// reader asks in whatever order its loops run; the fetcher wants the
    /// fewest reads.
    pub fn spans(&self) -> Vec<Span> {
        let mut spans = self.spans.borrow().clone();
        spans.sort_unstable();
        let mut merged: Vec<Span> = Vec::with_capacity(spans.len());
        for span in spans {
            match merged.last_mut() {
                // `>=` and not `>`: a span starting exactly where the last
                // ended is adjacent, and joining the two is the point.
                Some(last) if span.offset <= last.end() => {
                    let end = last.end().max(span.end());
                    last.len = (end - last.offset) as usize;
                }
                _ => merged.push(span),
            }
        }
        merged
    }
}

impl Bytes for &RecordingBytes {
    fn read_at(&self, offset: u64, len: usize) -> SamplesResult<Vec<u8>> {
        if offset.saturating_add(len as u64) > self.size {
            return Err(SamplesError::Truncated(offset, len));
        }
        // Not recorded when it is already in hand: the caller has these and
        // asking for them again would be a round trip for bytes it is holding.
        if let Ok(bytes) = (&self.known).read_at(offset, len) {
            return Ok(bytes);
        }
        self.spans.borrow_mut().push(Span { offset, len });
        Ok(vec![0u8; len])
    }

    fn size(&self) -> u64 {
        self.size
    }
}

/// Serves ranges that were fetched after a recording pass.
#[derive(Debug, Default)]
pub struct PrefetchedBytes {
    size: u64,
    /// Sorted by offset, so a read can binary-search for its region.
    chunks: Vec<(u64, Vec<u8>)>,
}

impl PrefetchedBytes {
    pub fn new(size: u64) -> Self {
        Self {
            size,
            chunks: Vec::new(),
        }
    }

    /// Adds a fetched region. Later additions may overlap earlier ones.
    pub fn add(&mut self, offset: u64, bytes: Vec<u8>) {
        self.chunks.push((offset, bytes));
        self.chunks.sort_by_key(|(at, _)| *at);
    }

    pub fn with(mut self, offset: u64, bytes: Vec<u8>) -> Self {
        self.add(offset, bytes);
        self
    }

    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }
}

impl Bytes for &PrefetchedBytes {
    fn read_at(&self, offset: u64, len: usize) -> SamplesResult<Vec<u8>> {
        let end = offset.saturating_add(len as u64);
        for (at, bytes) in &self.chunks {
            if *at > offset {
                break;
            }
            let chunk_end = at + bytes.len() as u64;
            if end <= chunk_end {
                let from = (offset - at) as usize;
                return Ok(bytes[from..from + len].to_vec());
            }
        }
        // Distinct from `Truncated`, which means the file is short. This means
        // the fetch did not bring back what the recording asked for -- a bug
        // in the caller's plumbing, not in the file, and it would otherwise
        // surface as a plot of zeros.
        Err(SamplesError::Missing(format!(
            "{len} bytes at {offset} were never fetched"
        )))
    }

    fn size(&self) -> u64 {
        self.size
    }
}

/// Where the file's trailing pointer is: the last sixteen bytes.
///
/// The first thing a reader of a `.gsim_samples` file needs, and the only
/// range whose location is known without reading anything.
pub fn tail_span(size: u64) -> Span {
    Span {
        offset: size.saturating_sub(16),
        len: 16,
    }
}

/// Where the footer is, given the sixteen trailing bytes.
///
/// The tail is a little-endian `u64` offset followed by the magic. The magic
/// is checked here rather than left to the reader so that a truncated file is
/// named as such before a footer offset is read out of whatever bytes happened
/// to land last.
pub fn footer_span(size: u64, tail: &[u8]) -> SamplesResult<Span> {
    if tail.len() != 16 {
        return Err(SamplesError::Format(format!(
            "a tail is 16 bytes, not {}",
            tail.len()
        )));
    }
    if &tail[8..16] != b"GSIMSAMP" {
        return Err(SamplesError::Format(
            "this file is truncated: its trailing magic is missing, so the run never \
             finished writing"
                .into(),
        ));
    }
    let offset = u64::from_le_bytes(tail[0..8].try_into().expect("eight bytes"));
    let end = size.saturating_sub(16);
    if offset >= end {
        return Err(SamplesError::Format(format!(
            "the footer offset {offset} does not point inside a {size}-byte file"
        )));
    }
    Ok(Span {
        offset,
        len: (end - offset) as usize,
    })
}

/// The rest of the prologue, given the footer's JSON: the header, the stripe
/// directory and the summary.
///
/// All three are located by arithmetic over the footer's own numbers, and that
/// arithmetic stays here rather than being redone by whichever caller is
/// fetching -- one implementation, as with everything else in this crate.
pub fn prologue_spans(footer_json: &str) -> SamplesResult<Vec<Span>> {
    let index: gsim_samples::Index =
        serde_json::from_str(footer_json).map_err(|e| SamplesError::Format(e.to_string()))?;
    let stripes = index.stripes as usize;
    Ok(vec![
        Span { offset: 0, len: 16 },
        Span {
            offset: index.directory_offset,
            len: stripes * 16,
        },
        Span {
            offset: index.summary_offset,
            len: stripes * index.signals.len() * 8,
        },
    ])
}

#[cfg(test)]
mod tests {
    use gsim_samples::{VectorMeta, Writer};

    use super::*;
    use crate::samples::SamplesSource;
    use crate::source::WaveformSource;

    /// A run with enough stripes that a full-extent view cannot be level 0.
    fn run(rows: usize, signals: usize) -> Vec<u8> {
        let names: Vec<VectorMeta> = (0..signals)
            .map(|k| VectorMeta::new(format!("V(n{k})")).with_unit("V"))
            .collect();
        let mut buffer = Vec::new();
        let mut writer = match Writer::new(&mut buffer, VectorMeta::new("t").with_unit("s"), names)
        {
            Ok(w) => w,
            Err(e) => panic!("a writer: {e}"),
        };
        for row in 0..rows {
            let values: Vec<f64> = (0..signals)
                .map(|k| k as f64 + (row as f64 / 37.0).sin())
                .collect();
            writer.push(row as f64 * 5e-9, &values).expect("push");
        }
        writer.finish().expect("finish");
        buffer
    }

    /// The prologue, fetched the way a caller without the file would: tail,
    /// then footer, then the three ranges the footer locates.
    fn prologue(bytes: &[u8]) -> PrefetchedBytes {
        let size = bytes.len() as u64;
        let read =
            |span: Span| bytes[span.offset as usize..span.offset as usize + span.len].to_vec();

        let tail = tail_span(size);
        let tail_bytes = read(tail);
        let footer = footer_span(size, &tail_bytes).expect("a footer span");
        let footer_bytes = read(footer);
        let footer_json = std::str::from_utf8(&footer_bytes).expect("utf-8");

        let mut known = PrefetchedBytes::new(size)
            .with(tail.offset, tail_bytes)
            .with(footer.offset, footer_bytes.clone());
        for span in prologue_spans(footer_json).expect("prologue spans") {
            known.add(span.offset, read(span));
        }
        known
    }

    #[test]
    fn two_passes_over_fetched_ranges_equal_reading_the_whole_file() {
        // The property the whole scheme rests on. If the recording pass could
        // be misled by its own zeros, this is where it would show.
        let bytes = run(gsim_samples::STRIPE_ROWS as usize * 6, 5);
        let size = bytes.len() as u64;
        let names = vec!["V(n1)".to_string(), "V(n3)".to_string()];

        let whole = SamplesSource::open(bytes.clone()).expect("opens");
        let want = whole.slice(&names, None, 2_000).expect("a slice");

        // Pass 1: record, over nothing but the prologue.
        let recorder = RecordingBytes::seeded(size, prologue(&bytes));
        let recording = SamplesSource::open(&recorder).expect("opens from the prologue");
        let _ = recording
            .slice(&names, None, 2_000)
            .expect("a recorded slice");
        let spans = recorder.spans();
        assert!(!spans.is_empty(), "nothing was recorded");

        // Pass 2: fetch exactly those, and ask again.
        let mut fetched = prologue(&bytes);
        let mut bytes_fetched = 0usize;
        for span in &spans {
            let from = span.offset as usize;
            fetched.add(span.offset, bytes[from..from + span.len].to_vec());
            bytes_fetched += span.len;
        }
        let served = SamplesSource::open(&fetched).expect("opens from the fetch");
        let got = served.slice(&names, None, 2_000).expect("a served slice");

        assert_eq!(got.sweep, want.sweep, "the sweep differs");
        assert_eq!(got.values, want.values, "the values differ");

        // And it is a reduction, which is the reason for the exercise.
        assert!(
            (bytes_fetched as u64) * 8 < size,
            "fetched {bytes_fetched} of {size} bytes, which is not worth two passes"
        );
    }

    #[test]
    fn a_window_fetches_less_than_the_whole_extent() {
        let bytes = run(gsim_samples::STRIPE_ROWS as usize * 20, 4);
        let size = bytes.len() as u64;
        let names = vec!["V(n2)".to_string()];

        let cost = |window: Option<(f64, f64)>| {
            let recorder = RecordingBytes::seeded(size, prologue(&bytes));
            let source = SamplesSource::open(&recorder).expect("opens");
            source.slice(&names, window, 2_000).expect("a slice");
            recorder.spans().iter().map(|s| s.len).sum::<usize>()
        };

        let extent = SamplesSource::open(bytes.clone())
            .expect("opens")
            .extent()
            .expect("an extent");
        let narrow = (extent.0, extent.0 + (extent.1 - extent.0) / 20.0);
        assert!(cost(Some(narrow)) < cost(None), "a 5% window cost no less");
    }

    #[test]
    fn spans_are_coalesced_so_a_fetcher_makes_fewer_reads() {
        // The reader asks in whatever order its loops run; adjacent regions
        // should arrive as one request.
        let recorder = RecordingBytes::new(1_000);
        {
            let bytes: &RecordingBytes = &recorder;
            bytes.read_at(200, 50).expect("a read");
            bytes.read_at(100, 50).expect("a read");
            bytes.read_at(150, 50).expect("a read");
            bytes.read_at(500, 10).expect("a read");
        }
        assert_eq!(
            recorder.spans(),
            vec![
                Span {
                    offset: 100,
                    len: 150
                },
                Span {
                    offset: 500,
                    len: 10
                },
            ]
        );
    }

    #[test]
    fn a_range_that_was_never_fetched_says_so_instead_of_serving_zeros() {
        // Otherwise a plumbing bug in the caller draws a flat line and looks
        // like a simulation result.
        let served = PrefetchedBytes::new(1_000).with(0, vec![1u8; 100]);
        let error = (&served).read_at(500, 10).expect_err("not fetched");
        assert!(error.to_string().contains("never fetched"), "{error}");
    }

    #[test]
    fn a_truncated_tail_is_named_before_an_offset_is_read_out_of_it() {
        let bytes = run(1_000, 2);
        let size = bytes.len() as u64;
        let mut tail = bytes[(size - 16) as usize..].to_vec();
        tail[15] = b'X';
        let error = footer_span(size, &tail).expect_err("a broken magic");
        assert!(error.to_string().contains("truncated"), "{error}");
    }
}
