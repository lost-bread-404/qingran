import AVFoundation
import CallKit
import Combine

final class CallEngine: NSObject, ObservableObject {
  static let shared = CallEngine()

  @Published private(set) var inCall = false

  var onSystemHangup: (() -> Void)?
  var nativeSession = false

  private let provider: CXProvider
  private let controller = CXCallController()
  private var callUUID: UUID?
  private var holdPlayer: AVAudioPlayer?
  private var endingFromWeb = false
  private var callGeneration = 0

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
    prepareHoldPlayer()
  }

  func prepareAudioSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.allowBluetoothHFP, .defaultToSpeaker]
      )
      try session.setActive(true, options: [])
    } catch {
      NSLog("Qingran audio session: \(error.localizedDescription)")
    }
  }

  func startCall() {
    callGeneration += 1
    let generation = callGeneration
    requestMic { [weak self] allowed in
      guard let self, self.callGeneration == generation else { return }
      self.prepareAudioSession()
      guard allowed else {
        self.nativeSession = false
        NativePipeline.shared.permissionDenied()
        return
      }
      if self.callUUID != nil {
        self.inCall = true
        if !self.nativeSession { self.startHoldLoop() }
        return
      }
      let uuid = UUID()
      self.callUUID = uuid
      let handle = CXHandle(type: .generic, value: QingranConfig.displayName)
      let action = CXStartCallAction(call: uuid, handle: handle)
      action.isVideo = false
      self.controller.request(CXTransaction(action: action)) { error in
        if let error {
          NSLog("Qingran CallKit start: \(error.localizedDescription)")
        }
      }
      self.provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
      self.provider.reportOutgoingCall(with: uuid, connectedAt: Date())
      self.inCall = true
      if self.nativeSession {
        self.startHoldLoop(false)
      } else {
        self.startHoldLoop()
      }
    }
  }

  func beginNativeCall() {
    nativeSession = true
    startCall()
  }

  func endCallFromWeb() {
    callGeneration += 1
    NativePipeline.shared.stop()
    nativeSession = false
    guard callUUID != nil else {
      endingFromWeb = false
      inCall = false
      startHoldLoop(false)
      return
    }
    endingFromWeb = true
    finishCall()
  }

  private func finishCall() {
    startHoldLoop(false)
    inCall = false
    guard let uuid = callUUID else { return }
    callUUID = nil
    let action = CXEndCallAction(call: uuid)
    controller.request(CXTransaction(action: action)) { _ in }
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

  private func prepareHoldPlayer() {
    guard let url = Bundle.main.url(forResource: "silence", withExtension: "wav") else { return }
    do {
      let player = try AVAudioPlayer(contentsOf: url)
      player.numberOfLoops = -1
      player.volume = 0.02
      player.prepareToPlay()
      holdPlayer = player
    } catch {
      NSLog("Qingran hold audio: \(error.localizedDescription)")
    }
  }

  private func startHoldLoop(_ on: Bool = true) {
    if on {
      if holdPlayer?.isPlaying != true {
        holdPlayer?.play()
      }
    } else {
      holdPlayer?.pause()
    }
  }
}

extension CallEngine: CXProviderDelegate {
  func providerDidReset(_ provider: CXProvider) {
    callGeneration += 1
    NativePipeline.shared.stop()
    nativeSession = false
    callUUID = nil
    inCall = false
    startHoldLoop(false)
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    prepareAudioSession()
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    if !endingFromWeb { callGeneration += 1 }
    let notifyWeb = !endingFromWeb
    endingFromWeb = false
    NativePipeline.shared.stop()
    nativeSession = false
    callUUID = nil
    inCall = false
    startHoldLoop(false)
    if notifyWeb {
      onSystemHangup?()
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    prepareAudioSession()
    if nativeSession {
      startHoldLoop(false)
      NativePipeline.shared.startEngine()
    } else {
      startHoldLoop()
    }
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    if inCall {
      prepareAudioSession()
    }
  }
}
