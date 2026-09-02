//! Dialog-free, paginated PDF export of a window's contents.
//!
//! There is no cross-platform Tauri/wry API for this — `Webview::print()`
//! only opens the interactive print dialog, and there's no cross-platform
//! "print to PDF file" either. This reaches through `WebviewWindow::with_webview`
//! to the raw platform handle, the same escape hatch Tauri documents for
//! exactly this kind of platform-specific need, and drives WKWebView's real
//! print pipeline (`NSPrintOperation`, which applies `@media print` and
//! paginates into standard page sizes) with both the print panel and the
//! progress panel suppressed and the job disposition set to save straight to
//! a file — the same mechanism the interactive "Print…" command used before
//! it was replaced by this, just headless and pointed at a path instead of
//! the sheet.
//!
//! An earlier version used WKWebView's native `createPDFWithConfiguration:`
//! instead, which is simpler but has no pagination concept at all: it always
//! produces a single page sized to exactly the rect it's given, so exporting
//! a multi-year report meant one continuous, non-standard-sized page rather
//! than a normal, printable document.

use std::path::{Path, PathBuf};
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSPrintHeaderAndFooter, NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob,
    NSPrintingPaginationMode,
};
use objc2_core_foundation::CGSize;
use objc2_foundation::{NSNumber, NSString, NSURL};
use objc2_web_kit::WKWebView;

/// US Letter, in PDF points (72/inch) — forced explicitly rather than left to
/// whatever paper size the system's default printer happens to be configured
/// for, since this has no printer involved at all.
const PAGE_SIZE: CGSize = CGSize::new(612.0, 792.0);
const MARGIN: f64 = 36.0;

/// Renders `window`'s current page to a paginated PDF at `path`, applying
/// `@media print` and standard page breaks exactly as the interactive print
/// sheet does.
///
/// Driven through `runOperationModalForWindow:delegate:didRunSelector:contextInfo:`,
/// not the plain synchronous `runOperation` its name suggests would be
/// enough — `runOperation` is documented (by other WKWebView-and-print
/// integrators hitting the same thing) as not actually working correctly
/// with WKWebView: called from `with_webview`'s closure, on the main
/// thread, it blocks the very run loop WebKit's internal async rendering
/// needs in order to finish laying out the page. What came back wasn't a
/// clean failure but a runaway: the page's real height was never resolved,
/// so the print pipeline kept emitting pages — hundreds of thousands of
/// them — without ever reaching the end of the content. The "modal" method
/// is the one actually wired up for this even with nothing shown
/// (`showsPrintPanel`/`showsProgressPanel` both false): it kicks the job
/// off and returns immediately, so this polls the destination file for the
/// write to finish rather than getting a callback — there's no delegate
/// object on the Rust side to receive `didRunSelector`.
pub async fn render(window: tauri::WebviewWindow, path: PathBuf) -> Result<(), String> {
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<(), String>>(1);
    let path_for_closure = path.clone();
    window
        .with_webview(move |platform_webview| {
            // Safety: `with_webview` runs this on the main thread with a
            // live webview; casting the raw handle to `WKWebView` is
            // Tauri's own documented pattern for reaching macOS-specific
            // WKWebView APIs it doesn't wrap itself.
            let view: &WKWebView = unsafe { &*platform_webview.inner().cast() };
            // Safety: this closure only ever runs on the main thread (it's
            // the body of the `with_webview` callback, which Tauri
            // documents as always dispatched there).
            let _mtm = unsafe { MainThreadMarker::new_unchecked() };

            let result = (|| -> Result<(), String> {
                let print_info = NSPrintInfo::sharedPrintInfo();
                print_info.setPaperSize(PAGE_SIZE);
                print_info.setTopMargin(MARGIN);
                print_info.setBottomMargin(MARGIN);
                print_info.setLeftMargin(MARGIN);
                print_info.setRightMargin(MARGIN);
                print_info.setHorizontalPagination(NSPrintingPaginationMode::Automatic);
                print_info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
                unsafe { print_info.setJobDisposition(NSPrintSaveJob) };

                let url = ns_file_url(&path_for_closure)?;
                // Safety: `dictionary()` returns the print info's live,
                // mutable settings bag — `NSPrintJobSavingURL` and
                // `NSPrintHeaderAndFooter` are both documented Apple keys for
                // it, and the values stored under them (`NSURL`, `NSNumber`)
                // are the documented types for those keys.
                unsafe {
                    let dict = print_info.dictionary();
                    dict.setObject_forKey(&url, ProtocolObject::from_ref(NSPrintJobSavingURL));
                    // Otherwise WebKit's print pipeline adds its own page
                    // title/URL header and date/page-number footer — sensible
                    // for printing a website, but not for a report that
                    // already carries its own title and generated timestamp.
                    dict.setObject_forKey(
                        &NSNumber::new_bool(false),
                        ProtocolObject::from_ref(NSPrintHeaderAndFooter),
                    );
                }

                // Safety: `view` is a live WKWebView on the main thread, and
                // `print_info` is a fully-configured NSPrintInfo — exactly
                // what this Apple API expects.
                let operation = unsafe { view.printOperationWithPrintInfo(&print_info) };
                operation.setShowsPrintPanel(false);
                operation.setShowsProgressPanel(false);

                let window = view.window().ok_or_else(|| {
                    "The report window isn't available to print from.".to_string()
                })?;
                // Safety: `window` is the live window backing this webview,
                // and we pass no delegate/selector — completion is observed
                // by polling the output file below instead.
                unsafe {
                    operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                        &window,
                        None,
                        None,
                        std::ptr::null_mut(),
                    );
                }
                Ok(())
            })();

            let tx = tx.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tx.send(result).await;
            });
        })
        .map_err(|e| e.to_string())?;

    rx.recv()
        .await
        .ok_or_else(|| "The print engine closed without responding.".to_string())??;

    wait_for_stable_file(&path).await
}

fn ns_file_url(path: &Path) -> Result<Retained<NSURL>, String> {
    let path_str = path
        .to_str()
        .ok_or_else(|| "The save path is not valid UTF-8.".to_string())?;
    Ok(NSURL::fileURLWithPath(&NSString::from_str(path_str)))
}

/// The print job runs asynchronously against the app's own run loop with no
/// completion callback wired up on this side, so this polls the file it's
/// writing to until its size stops changing — two consecutive checks, a
/// beat apart, agreeing it's done — rather than declaring success the
/// instant the job was merely *started*.
async fn wait_for_stable_file(path: &Path) -> Result<(), String> {
    const POLL: Duration = Duration::from_millis(150);
    const TIMEOUT: Duration = Duration::from_secs(30);

    let mut last_size: Option<u64> = None;
    let mut elapsed = Duration::ZERO;
    loop {
        tokio::time::sleep(POLL).await;
        elapsed += POLL;

        if let Ok(meta) = std::fs::metadata(path) {
            let size = meta.len();
            if size > 0 && Some(size) == last_size {
                return Ok(());
            }
            last_size = Some(size);
        }

        if elapsed >= TIMEOUT {
            return Err("Saving the PDF took too long.".to_string());
        }
    }
}
