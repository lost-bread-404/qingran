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
  private var foregroundObserver: NSObjectProtocol?
  private var tokenObserver: NSObjectProtocol?
  private var pushObserver: NSObjectProtocol?

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

    foregroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.reloadIfIdle()
    }
    tokenObserver = NotificationCenter.default.addObserver(
      forName: .qingranPushToken,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.deliverPushToken()
    }
    pushObserver = NotificationCenter.default.addObserver(
      forName: .qingranPush,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.deliverPushRefresh()
    }
  }

  deinit {
    if let foregroundObserver {
      NotificationCenter.default.removeObserver(foregroundObserver)
    }
    if let tokenObserver {
      NotificationCenter.default.removeObserver(tokenObserver)
    }
    if let pushObserver {
      NotificationCenter.default.removeObserver(pushObserver)
    }
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
    case "prepareAudio":
      CallEngine.shared.prepareAudioSession()
    case "keepAwake":
      var on = false
      if let body = message.body as? [String: Any], let flag = body["on"] as? Bool {
        on = flag
      }
      DispatchQueue.main.async {
        UIApplication.shared.isIdleTimerDisabled = on
      }
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

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    failed = false
    deliverPushToken()
  }

  private func deliverPushToken() {
    guard let token = UserDefaults.standard.string(forKey: "qingran.pushToken"), !token.isEmpty else { return }
    let env = UserDefaults.standard.string(forKey: "qingran.pushEnv") ?? "sandbox"
    let js = "window.dispatchEvent(new CustomEvent('qingran-push-token', {detail:{token:'\(token)', env:'\(env)'}}))"
    webView?.evaluateJavaScript(js, completionHandler: nil)
  }

  private func deliverPushRefresh() {
    webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('qingran-push'))", completionHandler: nil)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    showFail(error.localizedDescription)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    showFail(error.localizedDescription)
  }

  private func reloadIfIdle() {
    // Never tear down a live call just to pick up a web deploy.
    guard !CallEngine.shared.inCall else { return }
    failed = false
    webView.reloadFromOrigin()
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
    function post(type, extra) {
      try {
        var body = extra || {};
        body.type = type;
        window.webkit.messageHandlers.qingran.postMessage(body);
      } catch (e) {}
    }
    window.QingranNative = {
      present: true,
      startCall: function () { post('startCall'); },
      endCall: function () { post('endCall'); },
      prepareAudio: function () { post('prepareAudio'); },
      keepAwake: function (on) { post('keepAwake', { on: !!on }); }
    };
  })();
  """
}
