import SwiftUI
import WebKit

struct WebContainer: UIViewControllerRepresentable {
  let url: URL
  var onChangeURL: () -> Void

  func makeUIViewController(context: Context) -> QingranWebController {
    let controller = QingranWebController(url: url, onChangeURL: onChangeURL)
    return controller
  }

  func updateUIViewController(_ controller: QingranWebController, context: Context) {}
}

final class QingranWebController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  private let startURL: URL
  private let onChangeURL: () -> Void
  private var webView: WKWebView!
  private var failed = false

  init(url: URL, onChangeURL: @escaping () -> Void) {
    self.startURL = url
    self.onChangeURL = onChangeURL
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true
    config.allowsAirPlayForMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    config.defaultWebpagePreferences.allowsContentJavaScript = true
    config.websiteDataStore = .default()
    config.applicationNameForUserAgent = "QingranNative/1.0"
    config.userContentController.add(self, name: "qingran")
    config.userContentController.addUserScript(
      WKUserScript(source: Self.bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    )

    let wv = WKWebView(frame: view.bounds, configuration: config)
    wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    wv.navigationDelegate = self
    wv.uiDelegate = self
    wv.scrollView.bounces = false
    wv.scrollView.contentInsetAdjustmentBehavior = .never
    wv.backgroundColor = .black
    wv.isOpaque = false
    wv.allowsBackForwardNavigationGestures = false
    if #available(iOS 16.4, *) {
      wv.isInspectable = true
    }
    view.addSubview(wv)
    webView = wv

    CallEngine.shared.onSystemHangup = { [weak self] in
      self?.webView?.evaluateJavaScript(
        "window.dispatchEvent(new CustomEvent('qingran-native-hangup'))",
        completionHandler: nil
      )
    }

    wv.load(URLRequest(url: startURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 45))
  }

  deinit {
    webView?.configuration.userContentController.removeScriptMessageHandler(forName: "qingran")
    CallEngine.shared.onSystemHangup = nil
  }

  override var prefersHomeIndicatorAutoHidden: Bool { true }
  override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "qingran" else { return }
    let type: String
    if let body = message.body as? [String: Any], let value = body["type"] as? String {
      type = value
    } else if let body = message.body as? String {
      type = body
    } else {
      return
    }
    switch type {
    case "startCall":
      CallEngine.shared.startCall()
    case "endCall":
      CallEngine.shared.endCallFromWeb()
    case "changeURL":
      DispatchQueue.main.async { self.onChangeURL() }
    default:
      break
    }
  }

  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    decisionHandler(.grant)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if navigationAction.targetFrame == nil {
      if let url = navigationAction.request.url {
        webView.load(URLRequest(url: url))
      }
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    showFail(error.localizedDescription)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    showFail(error.localizedDescription)
  }

  private func showFail(_ detail: String) {
    guard !failed else { return }
    failed = true
    let alert = UIAlertController(
      title: "打不开这个地址",
      message: "\(detail)\n\n请确认已发布清然网页，并且地址复制完整。",
      preferredStyle: .alert
    )
    alert.addAction(UIAlertAction(title: "更换地址", style: .default) { [weak self] _ in
      self?.onChangeURL()
    })
    alert.addAction(UIAlertAction(title: "再试一次", style: .cancel) { [weak self] _ in
      self?.failed = false
      self?.webView.reload()
    })
    present(alert, animated: true)
  }

  private static let bridgeJS = """
  (function () {
    if (window.QingranNative && window.QingranNative.present) return;
    function post(type) {
      try {
        window.webkit.messageHandlers.qingran.postMessage({ type: type });
      } catch (e) {}
    }
    window.QingranNative = {
      present: true,
      startCall: function () { post('startCall'); },
      endCall: function () { post('endCall'); }
    };
    try {
      var devices = navigator.mediaDevices;
      if (devices && devices.getUserMedia) {
        var orig = devices.getUserMedia.bind(devices);
        devices.getUserMedia = function (constraints) {
          try {
            if (constraints && constraints.audio) post('startCall');
          } catch (e) {}
          return orig(constraints);
        };
      }
    } catch (e) {}
  })();
  """
}
