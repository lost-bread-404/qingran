import AVFoundation
import CallKit
import Combine

/// The system call around the shell's call (Voice.swift does the talking). With it, iOS keeps the app running with the
/// screen locked or in another app and shows the green call bar; inside the app, the page stays on screen.
final class CallEngine: NSObject, ObservableObject {
  static let shared = CallEngine()

  @Published private(set) var inCall = false

  var onSystemHangup: (() -> Void)?

  private let provider: CXProvider
  private let controller = CXCallController()
  private var callUUID: UUID?
  private var endingFromWeb = false
  private var callGeneration = 0
  /// iOS handed this call its audio (CallKit didActivate).
  private var audioActivated = false

  override init() {
    let config = CXProviderConfiguration()
    config.supportsVideo = false
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    config.includesCallsInRecents = false
    provider = CXProvider(configuration: config)
    super.init()
    provider.setDelegate(self, queue: .main)
  }

  func prepareAudioSession() {
    Voice.activateSession()
  }

  /// The page started a call.
  func beginNativeCall() {
    callGeneration += 1
    audioActivated = false
    let generation = callGeneration
    requestMic { [weak self] allowed in
      guard let self, self.callGeneration == generation else { return }
      self.prepareAudioSession()
      guard allowed else {
        Voice.shared.callFailed("麦克风没开：设置 → 清然 → 麦克风。")
        return
      }
      if self.callUUID != nil {
        self.inCall = true
        Voice.shared.startCall()
        return
      }
      let uuid = UUID()
      self.callUUID = uuid
      let handle = CXHandle(type: .generic, value: QingranConfig.displayName)
      let action = CXStartCallAction(call: uuid, handle: handle)
      action.isVideo = false
      self.controller.request(CXTransaction(action: action)) { [weak self] error in
        guard let error else { return }
        NSLog("Qingran CallKit start: \(error.localizedDescription)")
        Voice.shared.report("callkit start failed: \(error.localizedDescription)")
        DispatchQueue.main.async { self?.startWithoutCallKit(generation) }
      }
      self.provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
      self.provider.reportOutgoingCall(with: uuid, connectedAt: Date())
      self.inCall = true
      // The mic starts when iOS hands the call its audio. If that never comes, the call would sit there deaf.
      // iOS can take a few seconds to hand it over (seen: just over 2 s), so this waits longer than that.
      DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
        guard let self, self.callGeneration == generation, self.inCall, !self.audioActivated else { return }
        Voice.shared.report("callkit audio never came")
        self.startWithoutCallKit(generation)
      }
    }
  }

  /// The call goes on without the system call (no green bar): the mic and speaker still work while the app is open.
  private func startWithoutCallKit(_ generation: Int) {
    guard callGeneration == generation, inCall else { return }
    prepareAudioSession()
    Voice.shared.startCall()
  }

  func endCallFromWeb() {
    callGeneration += 1
    Voice.shared.stopCall()
    guard callUUID != nil else {
      endingFromWeb = false
      inCall = false
      return
    }
    endingFromWeb = true
    finishCall()
  }

  private func finishCall() {
    inCall = false
    guard let uuid = callUUID else { return }
    callUUID = nil
    controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { _ in }
  }

  private func requestMic(_ done: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission { allowed in
        DispatchQueue.main.async { done(allowed) }
      }
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission { allowed in
        DispatchQueue.main.async { done(allowed) }
      }
    }
  }
}

extension CallEngine: CXProviderDelegate {
  func providerDidReset(_ provider: CXProvider) {
    callGeneration += 1
    Voice.shared.stopCall()
    callUUID = nil
    inCall = false
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    prepareAudioSession()
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    if !endingFromWeb { callGeneration += 1 }
    let notifyWeb = !endingFromWeb
    endingFromWeb = false
    Voice.shared.stopCall()
    callUUID = nil
    inCall = false
    if notifyWeb {
      onSystemHangup?()
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    audioActivated = true
    prepareAudioSession()
    if inCall { Voice.shared.startCall() }
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    if inCall {
      prepareAudioSession()
    }
  }
}
