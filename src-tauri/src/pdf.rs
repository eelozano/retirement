//! Dialog-free PDF export of a window's contents.
//!
//! There is no cross-platform Tauri/wry API for this — `Webview::print()`
//! only opens the interactive print dialog. WKWebView itself has a native
//! `createPDFWithConfiguration:completionHandler:` that renders straight to
//! PDF bytes with no dialog at all, so this reaches through
//! `WebviewWindow::with_webview` to the raw platform handle to call it
//! directly, the same escape hatch Tauri documents for exactly this kind of
//! platform-specific need.

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSData, NSError};
use objc2_web_kit::{WKPDFConfiguration, WKWebView};

/// Renders the `(width, height)` rect (in web page coordinates, i.e. CSS
/// pixels from the page's top-left) of `window`'s current page to PDF
/// bytes. `createPDF` is itself asynchronous and only resolves once
/// WebKit's own completion handler fires on a later turn of the run loop —
/// the `tauri::async_runtime` channel bridges that callback into an
/// awaitable value the same way `export_plans`'s dialog callback already
/// does.
pub async fn render(
    window: tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<Vec<u8>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<Vec<u8>, String>>(1);
    window
        .with_webview(move |platform_webview| {
            // Safety: `with_webview` runs this on the main thread with a
            // live webview; casting the raw handle to `WKWebView` is
            // Tauri's own documented pattern for reaching macOS-specific
            // WKWebView APIs it doesn't wrap itself.
            let view: &WKWebView = unsafe { &*platform_webview.inner().cast() };

            // Safety: this closure only ever runs on the main thread (it's
            // the body of the `with_webview` callback, which Tauri
            // documents as always dispatched there), matching
            // `WKPDFConfiguration`'s `MainThreadOnly` requirement.
            let mtm = unsafe { MainThreadMarker::new_unchecked() };
            let config = unsafe { WKPDFConfiguration::new(mtm) };
            // An explicit rect, rather than the nil-configuration default,
            // because the default only captures whatever is currently
            // scrolled into the window's on-screen viewport — the frontend
            // has already switched into an unclipped layout and measured
            // its true extent for exactly this reason.
            unsafe {
                config.setRect(CGRect::new(
                    CGPoint::new(0.0, 0.0),
                    CGSize::new(width, height),
                ))
            };

            let block = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                // Safety: both pointers are only valid for the duration of
                // this call, per the Cocoa completion-handler convention —
                // `to_vec`/`to_string` copy out what's needed before either
                // one goes away.
                let result = unsafe {
                    if let Some(error) = error.as_ref() {
                        Err(error.to_string())
                    } else if let Some(data) = data.as_ref() {
                        Ok(data.to_vec())
                    } else {
                        Err("WebKit returned neither PDF data nor an error.".to_string())
                    }
                };
                let tx = tx.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = tx.send(result).await;
                });
            });
            unsafe { view.createPDFWithConfiguration_completionHandler(Some(&config), &block) };
        })
        .map_err(|e| e.to_string())?;

    rx.recv()
        .await
        .ok_or_else(|| "The print engine closed without responding.".to_string())?
}
