import AVFoundation
import Foundation
import UIKit
import UserNotifications

/// One of her lines in a round. `mode` is how it was said ("hold" or "call"); nil when she typed or tapped it.
struct Piece {
  let id: String
  let at: Int
  let text: String
  let mode: String?
}

/**
 * His voice: 24 kHz PCM pieces as they come, on its own engine (output only, so the mic is not on while he speaks).
 * Like the page's player, it starts once a little is buffered and waits again after running dry, so one reply plays as
 * one stretch. Used only on the voice's queue.
 */
final class Speaker: @unchecked Sendable {
  private static let startSec = 0.42
  private static let holdSec = 0.32
  private static let rate = 24_000.0
  private let queue: DispatchQueue
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)
  private var attached = false
  private var carry = Data()
  private var waiting: [AVAudioPCMBuffer] = []
  private var waitingFrames: Double = 0
  private var pending = 0
  private var gen = 0
  /// When what was handed to the player should be over.
  private(set) var endsAt = Date.distantPast
  /// When his voice last stopped.
  private(set) var idleAt = Date.distantPast
  /// Everything handed to the player has played (on the queue).
  var onIdle: (() -> Void)?

  init(queue: DispatchQueue) {
    self.queue = queue
  }

  var playing: Bool { pending > 0 }
  var hasWaiting: Bool { !waiting.isEmpty }

  /// A piece of his voice (base64, 16-bit PCM at 24 kHz; xAI may label it octet-stream). Kept until `flush`.
  /// `replace`: his whole reply again, so what came before is dropped (only once this one is known to be readable).
  func add(_ b64: String, mime: String, replace: Bool = false) {
    let kind = mime.lowercased()
    guard kind.isEmpty || kind.contains("pcm") || kind.contains("octet-stream"), Speaker.rateOf(kind) == Speaker.rate,
          let raw = Data(base64Encoded: b64), !raw.isEmpty, let format else { return }
    if replace { drop() }
    // 16-bit samples can be split across two pieces: an odd byte waits for the next piece.
    var data = carry
    data.append(raw)
    carry = Data()
    if data.count % 2 == 1 {
      carry = Data(data.suffix(1))
      data.removeLast()
    }
    let frames = data.count / 2
    guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
          let out = buffer.floatChannelData?[0] else { return }
    buffer.frameLength = AVAudioFrameCount(frames)
    data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
      let b = bytes.bindMemory(to: UInt8.self)
      for i in 0..<frames {
        out[i] = Float(Int16(bitPattern: UInt16(b[2 * i]) | (UInt16(b[2 * i + 1]) << 8))) / 32768
      }
    }
    waiting.append(buffer)
    waitingFrames += Double(frames)
  }

  /**
   * Hands what is waiting to the player: at once while he is already speaking, otherwise once enough is waiting (or
   * the reply is complete). True when something was handed over. If the speaker cannot play, what waits is dropped.
   */
  @discardableResult
  func flush(started: Bool, complete: Bool) -> Bool {
    guard !waiting.isEmpty else { return false }
    if !playing && !complete {
      let need = (started ? Speaker.holdSec : Speaker.startSec) * Speaker.rate
      if waitingFrames < need { return false }
    }
    guard ready() else {
      waiting.removeAll()
      waitingFrames = 0
      return false
    }
    for buffer in waiting { schedule(buffer) }
    waiting.removeAll()
    waitingFrames = 0
    return true
  }

  /// Everything is dropped (she stopped him, or another answer starts).
  func drop() {
    gen += 1
    if pending > 0 { idleAt = Date() }
    pending = 0
    waiting.removeAll()
    waitingFrames = 0
    carry = Data()
    endsAt = .distantPast
    if attached { player.stop() }
  }

  /// Nothing to play for now: the engine rests until the next reply.
  func rest() {
    guard !playing, waiting.isEmpty, engine.isRunning else { return }
    engine.pause()
  }

  private func schedule(_ buffer: AVAudioPCMBuffer) {
    let g = gen
    endsAt = max(endsAt, Date()).addingTimeInterval(Double(buffer.frameLength) / Speaker.rate)
    pending += 1
    player.scheduleBuffer(buffer, completionHandler: { [weak self] in
      self?.queue.async {
        guard let self, self.gen == g, self.pending > 0 else { return }
        self.pending -= 1
        if self.pending == 0 {
          self.idleAt = Date()
          self.onIdle?()
        }
      }
    })
    if !player.isPlaying { player.play() }
  }

  /// The session active and the engine running. Connected again on every start: after a route or configuration
  /// change the old connection can play into nothing.
  private func ready() -> Bool {
    guard let format else { return false }
    if !attached {
      engine.attach(player)
      attached = true
    }
    if engine.isRunning { return true }
    do {
      Voice.activateSession()
      engine.disconnectNodeOutput(player)
      engine.connect(player, to: engine.mainMixerNode, format: format)
      engine.prepare()
      try engine.start()
      player.play()
      return true
    } catch {
      NSLog("Qingran speaker: \(error.localizedDescription)")
      return false
    }
  }

  private static func rateOf(_ mime: String) -> Double {
    guard let range = mime.range(of: "rate=") else { return rate }
    let digits = mime[range.upperBound...].prefix { $0.isNumber }
    return Double(digits) ?? rate
  }
}

/**
 * What holding to talk feels like without looking (requirements 第 7 节): a firm tap and a short high tone when the press
 * takes, a light tap and a lower tone on letting go, a warning buzz and a falling pair when she slides up to cancel (or
 * something failed). The session lets haptics play while the mic is on (Voice.activateSession).
 */
final class Cues {
  static let shared = Cues()
  enum Kind { case press, release, cancel }
  private let firm = UIImpactFeedbackGenerator(style: .medium)
  private let light = UIImpactFeedbackGenerator(style: .light)
  private let warn = UINotificationFeedbackGenerator()
  private var sounds: [Kind: AVAudioPlayer] = [:]

  private init() {}

  func play(_ kind: Kind) {
    let run = {
      switch kind {
      case .press: self.firm.impactOccurred()
      case .release: self.light.impactOccurred()
      case .cancel: self.warn.notificationOccurred(.warning)
      }
      if let player = self.sound(kind) {
        player.currentTime = 0
        player.play()
      }
      self.firm.prepare()
      self.light.prepare()
    }
    if Thread.isMainThread { run() } else { DispatchQueue.main.async(execute: run) }
  }

  private func sound(_ kind: Kind) -> AVAudioPlayer? {
    if let player = sounds[kind] { return player }
    let parts: [(Double, Double)]
    switch kind {
    case .press: parts = [(1320, 70)]
    case .release: parts = [(880, 55)]
    case .cancel: parts = [(660, 60), (440, 80)]
    }
    guard let player = try? AVAudioPlayer(data: Cues.tone(parts)) else { return nil }
    player.volume = 0.6
    player.prepareToPlay()
    sounds[kind] = player
    return player
  }

  /// Short sine tones (Hz, ms), with a soft start and end so they do not click.
  private static func tone(_ parts: [(Double, Double)]) -> Data {
    let rate = 44_100.0
    var samples: [Int16] = []
    for (hz, ms) in parts {
      let n = Int(rate * ms / 1000)
      for i in 0..<n {
        let attack = min(1, Double(i) / (rate * 0.005))
        let fade = min(1, Double(n - i) / (rate * 0.03))
        let v = sin(2 * Double.pi * hz * Double(i) / rate) * 0.5 * attack * fade
        samples.append(Int16(v * 32767))
      }
      samples.append(contentsOf: [Int16](repeating: 0, count: Int(rate * 0.02)))
    }
    return Net.wav(samples, rate: Int(rate))
  }
}

/**
 * The shell's voice (requirements 第 7 节): holding to talk and calls, done the way the page does them
 * (src/hooks/use-hold.ts, src/lib/lover/voice/web-call.ts), and asking /api/talk and playing his voice itself, so it all
 * goes on with the app in the background. Nothing here guesses from loudness when she speaks: holding, she decides;
 * in a call, xAI's turn model does. Her lines go to the page as `heard`, his words as `reply`.
 * Its state is only touched on `queue`, so it may be used from tasks and callbacks (`@unchecked Sendable`).
 */
final class Voice: @unchecked Sendable {
  static let shared = Voice()

  private let queue: DispatchQueue
  private let mic = Mic()
  private let speaker: Speaker
  private var emit: (([String: Any]) -> Void)?
  var onHangup: (() -> Void)?

  private var callOn = false
  private var holding = false
  private var muted = false
  // Holding to talk
  private var holdEar: Ear?
  private var holdClip: [Int16] = []
  /// Held lines she let go of whose words are not in yet: his voice waits for them too.
  private var finishingHolds = 0
  // A call's ear: open while she may speak; asleep after 30 s without a word (any sound wakes it, with the 1.5 s before)
  private var ear: Ear?
  private var awake = true
  private var ring: [[Int16]] = []
  private var floor: Float = 0.004
  private var heardAt = Date()
  private var lineOpen = false
  private var retryAt = Date.distantPast
  private var retryDelay: TimeInterval = 1
  private var warned = false
  private var suffix = ""
  private var tickets: [String: StreamTicket] = [:]
  private var ticketLoading = Set<String>()
  /// Seconds of her voice xAI heard since the last ask (its cost goes with the ask), and how long after she let go the
  /// last held line's words were in.
  private var sec: Double = 0
  private var lastMs = 0
  // This round: her lines not yet answered aloud, and the one answer they will get. Until his voice starts, a new line
  // drops that answer and he answers all of them again; once he is heard (or read) the round is over.
  private var round: [Piece] = []
  private var roundReply: String?
  private var askedPieces = 0
  private var busy = false
  private var replyStarted = false
  private var replyEnded = false
  /// A turn the page started is running: lines she adds meanwhile wait for it, then go as the next round.
  private var pageTurn = false
  private var pageReply: String?
  /// Replies she stopped after hearing (or reading) them, still finishing so they are saved; the next round waits.
  private var saving = Set<UUID>()
  private var turnGen = 0
  private var talkTask: Task<Void, Never>?
  private var failures = 0
  private var observers: [NSObjectProtocol] = []
  private var watchdog: DispatchSourceTimer?
  private var keepAlive: UIBackgroundTaskIdentifier = .invalid

  private init() {
    let q = DispatchQueue(label: "qingran.voice")
    queue = q
    speaker = Speaker(queue: q)
    speaker.onIdle = { [weak self] in self?.voiceEnded() }
    mic.onFrame = { [weak self] frame, rms in
      self?.queue.async { self?.heard(frame, rms) }
    }
    watchAudio()
    startWatchdog()
  }

  /// Ordinary playback, not a phone line: in voice-chat mode iOS runs both directions through telephone processing
  /// (and Bluetooth drops to call quality), which made him sound behind a veil. She talks with the phone by the pillow,
  /// so his voice comes from the speaker at full quality and the mic is the phone's own. There is no echo cancelling in
  /// this mode, so the mic sends nothing while he speaks. Haptics stay on while the mic records.
  static func activateSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      if session.category != .playAndRecord || session.mode != .default || !session.categoryOptions.contains(.defaultToSpeaker) {
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
      }
      try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
      try session.setActive(true, options: [])
    } catch {
      NSLog("Qingran audio session: \(error.localizedDescription)")
    }
  }

  // MARK: The page

  /// Where events for the page go (WebContainer puts them on the page).
  func attach(_ emit: @escaping ([String: Any]) -> Void) {
    queue.async { self.emit = emit }
  }

  /// The app is in front: a ticket is fetched ahead, so a press connects at once.
  func wake() {
    queue.async { self.prefetch("hold") }
  }

  /// She is holding or her line is being heard, or his answer is being asked or spoken (the page is not reloaded then).
  var busyNow: Bool {
    queue.sync { holding || finishingHolds > 0 || busy || speaker.playing || speaker.hasWaiting }
  }

  /// Something about a call seen elsewhere in the shell (CallKit), for the log.
  func report(_ event: String) {
    note(ok: true, error: "", detail: event)
  }

  // MARK: Holding to talk

  func holdStart(muted: Bool) {
    Cues.shared.play(.press)
    queue.async {
      guard !self.callOn, !self.holding else { return }
      switch AVAudioSession.sharedInstance().recordPermission {
      case .granted:
        break
      case .undetermined:
        AVAudioSession.sharedInstance().requestRecordPermission { _ in }
        self.emit?(["type": "held", "text": "", "error": "允许清然用麦克风，再按住说。"])
        return
      default:
        self.emit?(["type": "held", "text": "", "error": "麦克风没开：设置 → 清然 → 麦克风。"])
        return
      }
      self.muted = muted
      // He was speaking: he stops (what she heard of it is kept). He was thinking about a line she typed: that stops
      // too, as when she taps him (it is not part of her round). He was thinking about her round: his voice waits for
      // her line.
      let speaking = self.replyStarted && (self.speaker.playing || self.speaker.hasWaiting || self.busy)
      if speaking || (self.pageTurn && self.busy) {
        self.retractUnheard()
        self.stopHim()
        if !self.callOn { self.emit?(["type": "phase", "phase": "idle"]) }
      }
      self.holding = true
      self.holdClip.removeAll()
      let ear = Ear(mode: .hold, queue: self.queue)
      ear.onText = { [weak self] text in self?.emit?(["type": "hold", "text": text]) }
      self.holdEar = ear
      ear.open(self.takeTicket("hold"), fetch: { [weak self] in await self?.fetchTicket("hold") })
      Voice.activateSession()
      do {
        try self.mic.start()
      } catch {
        self.holding = false
        ear.close()
        self.holdEar = nil
        self.emit?(["type": "held", "text": "", "error": "麦克风打不开，再按一次。"])
      }
    }
  }

  func holdEnd() {
    Cues.shared.play(.release)
    queue.async {
      guard self.holding else {
        self.emit?(["type": "held", "text": ""])
        return
      }
      self.holding = false
      self.finishingHolds += 1
      // She may lock the phone right after letting go: the app stays up until her words are in and asked.
      self.holdAppAlive()
      if !self.callOn { self.mic.stop() }
      let rest = self.mic.flush()
      self.holdClip.append(contentsOf: rest)
      self.holdEar?.send(rest)
      let clip = self.holdClip
      self.holdClip.removeAll()
      let letGo = Date()
      self.prefetch("hold")
      guard let ear = self.holdEar else {
        self.heldLine("", ms: 0, sec: 0)
        return
      }
      self.holdEar = nil
      ear.finish { text in
        if let text {
          self.heldLine(text, ms: Int(Date().timeIntervalSince(letGo) * 1000), sec: ear.sent)
          return
        }
        // The stream did not finish: the whole hold is read at once.
        let sent = ear.sent
        Task {
          let whole = await self.readWhole(clip)
          self.queue.async {
            self.heldLine(whole.text, ms: Int(Date().timeIntervalSince(letGo) * 1000), sec: sent, error: whole.error)
          }
        }
      }
    }
  }

  func holdCancel() {
    Cues.shared.play(.cancel)
    queue.async {
      guard self.holding else { return }
      self.holding = false
      if !self.callOn { self.mic.stop() }
      _ = self.mic.flush()
      self.holdEar?.close()
      self.holdEar = nil
      self.holdClip.removeAll()
      // A line of hers that came in meanwhile is asked (his waiting answer is dropped); otherwise his voice that waited
      // for her goes on.
      if self.round.count > self.askedPieces { self.kick() }
      self.flushVoice()
      if !self.busy && !self.speaker.playing { self.settled() }
    }
  }

  private func heldLine(_ text: String, ms: Int, sec: Double, error: String? = nil) {
    finishingHolds = max(0, finishingHolds - 1)
    var event: [String: Any] = ["type": "held", "text": text]
    if let error { event["error"] = error }
    emit?(event)
    self.sec += sec
    let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !said.isEmpty else {
      // Nothing was said. An earlier line of hers that came in while she held this one is asked (his waiting answer
      // is dropped); otherwise his voice that waited for her line goes on.
      if round.count > askedPieces { kick() }
      flushVoice()
      if !busy && !speaker.playing { settled() }
      return
    }
    lastMs = ms
    addLine(said, mode: "hold")
  }

  /// A hold whose stream could not be used, read whole (/api/stt), a minute at a time so no request is over the
  /// server's size limit. What could be read is kept even if a piece failed.
  private func readWhole(_ clip: [Int16]) async -> (text: String, error: String?) {
    guard clip.count >= Int(Mic.rate * 0.3) else { return ("", nil) }
    let size = Int(Mic.rate) * 60
    var text = ""
    var error: String?
    var start = 0
    while start < clip.count {
      var end = min(clip.count, start + size)
      // A last bit under a second goes with this piece (too short to read on its own).
      if clip.count - end < Int(Mic.rate) { end = clip.count }
      let got = await readPiece(Array(clip[start..<end]))
      start = end
      if let failed = got.error { error = failed }
      text = Heard.join(text, got.text)
    }
    return (text, error)
  }

  private func readPiece(_ clip: [Int16]) async -> (text: String, error: String?) {
    guard let url = Net.endpoint("api/stt") else { return ("", "这会儿连不上。") }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.timeoutInterval = 40
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(await Net.cookieHeader(), forHTTPHeaderField: "Cookie")
    let wav = Net.wav(clip, rate: Int(Mic.rate))
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["audioBase64": wav.base64EncodedString()])
    guard let sent = try? await Net.send(req),
          let json = try? JSONSerialization.jsonObject(with: sent.0) as? [String: Any] else {
      return ("", "这会儿连不上，再说一遍。")
    }
    if json["ok"] as? Bool == true {
      return ((json["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines), nil)
    }
    return ("", json["error"] as? String ?? "没听清，再说一遍。")
  }

  // MARK: Calls

  /// iOS handed the call its audio (or the call goes on without CallKit).
  func startCall() {
    queue.async {
      if !self.callOn {
        self.callOn = true
        if self.holding {
          self.holding = false
          self.holdEar?.close()
          self.holdEar = nil
          self.holdClip.removeAll()
        }
        self.awake = true
        self.heardAt = Date()
        self.ring.removeAll()
        self.lineOpen = false
        self.suffix = ""
        self.retryAt = .distantPast
        self.retryDelay = 1
        self.warned = false
        self.failures = 0
        self.prefetch("call")
      }
      Voice.activateSession()
      do {
        try self.mic.start()
        self.report("mic on")
      } catch {
        self.note(ok: false, error: "mic \(error.localizedDescription)")
        self.emit?(["type": "error", "text": "麦克风打不开。"])
        self.dropCall()
        return
      }
      self.settled()
    }
  }

  /// She hung up (or iOS ended the call).
  func stopCall() {
    queue.async {
      guard self.callOn else { return }
      self.callOn = false
      self.retractUnheard()
      self.turnGen += 1
      self.stopTalk()
      self.saving.removeAll()
      self.busy = false
      self.endPageTurn()
      self.ear?.close()
      self.ear = nil
      self.lineOpen = false
      self.ring.removeAll()
      self.release()
      self.speaker.drop()
      self.mic.stop()
      _ = self.mic.flush()
      self.settled()
    }
  }

  /// The call could not start (no mic): the page hangs up.
  func callFailed(_ text: String) {
    queue.async { self.emit?(["type": "error", "text": text]) }
    emitEnded()
  }

  private func callFrame(_ frame: [Int16], _ rms: Float) {
    let now = Date()
    // His voice is in the room (playing, or half a second after): nothing is sent, so he is never heard as her.
    if speaker.playing || now.timeIntervalSince(speaker.idleAt) < 0.5 {
      ring.removeAll()
      return
    }
    guard let ear else {
      ring.append(frame)
      if ring.count > 15 { ring.removeFirst() }
      if !awake {
        // Asleep: the room's level is followed (down fast, up slowly) and any sound well above it wakes the stream.
        floor = rms < floor ? floor * 0.7 + rms * 0.3 : floor * 0.995 + rms * 0.005
        if rms <= max(0.004, floor * 2.5) { return }
        awake = true
        heardAt = now
      }
      if now < retryAt { return }
      openCallEar()
      let earlier = ring
      ring.removeAll()
      for piece in earlier { sendCall(piece) }
      return
    }
    sendCall(frame)
    if ear.live { retryDelay = 1 }
    if lineOpen { return }
    if now.timeIntervalSince(max(heardAt, ear.wordsAt)) > 30 {
      awake = false
      closeCallEar()
    } else if now.timeIntervalSince(ear.born) > 240 || (ear.expiresAt.map { $0.timeIntervalSinceNow < 20 } ?? false) {
      // A new stream between lines, before this one's time runs out.
      closeCallEar()
    }
  }

  private func sendCall(_ pcm: [Int16]) {
    guard let ear else { return }
    ear.send(pcm)
    sec += Double(pcm.count) / Mic.rate
  }

  private func openCallEar() {
    let ear = Ear(mode: .call, queue: queue)
    ear.onText = { [weak self, weak ear] text in
      guard let self, let ear, self.ear === ear else { return }
      self.liveText(text)
    }
    // A stream already let go may still bring the end of a line.
    ear.onLine = { [weak self] text in
      guard let self, self.callOn else { return }
      self.heardAt = Date()
      let said = (text + self.suffix).trimmingCharacters(in: .whitespacesAndNewlines)
      self.suffix = ""
      if !said.isEmpty { self.addLine(said, mode: "call") }
    }
    ear.onDead = { [weak self, weak ear] why in
      guard let self, let ear, self.ear === ear, self.callOn else { return }
      self.ear = nil
      self.liveText("")
      self.retryAt = Date().addingTimeInterval(self.retryDelay)
      self.retryDelay = min(30, self.retryDelay * 2)
      self.note(ok: false, error: why)
      if !self.warned {
        self.warned = true
        self.emit?(["type": "error", "text": "听写连不上，正在重连。"])
      }
    }
    self.ear = ear
    ear.open(takeTicket("call"), fetch: { [weak self] in await self?.fetchTicket("call") })
    prefetch("call")
  }

  /// The stream is let go; what it already heard still comes back.
  private func closeCallEar() {
    guard let ear else { return }
    self.ear = nil
    if lineOpen { liveText("") }
    ear.finish { _ in ear.close() }
  }

  /// What she is saying in the call right now changed.
  private func liveText(_ text: String) {
    let was = lineOpen
    lineOpen = !text.isEmpty
    if lineOpen { heardAt = Date() }
    emit?(["type": "partial", "text": text])
    if lineOpen && !was {
      emit?(["type": "phase", "phase": "speaking-you"])
    } else if !lineOpen && was {
      // Her line is over. With words, it was just added and is asked now (his waiting answer is dropped); with none,
      // his waiting answer goes on.
      if round.count > askedPieces { kick() }
      flushVoice()
      if busy && !replyStarted {
        emit?(["type": "phase", "phase": "thinking"])
      } else if !busy && !speaker.playing {
        settled()
      }
    }
  }

  /// A line she typed, or a phrase she tapped beside the hang-up button. Tapped while she is saying a line, it goes on
  /// the end of that line; otherwise it is a line of its own in this round.
  func addFromPage(_ text: String, attach: Bool) {
    queue.async {
      guard self.callOn, !text.isEmpty else { return }
      if attach && self.lineOpen {
        self.suffix += text
        return
      }
      self.addLine(text, mode: nil)
    }
  }

  /// She pressed play on one of his lines in the call: whatever he was saying stops and the clip plays as one reply.
  func playFromPage(_ audio: String, mime: String) {
    queue.async {
      guard self.callOn else { return }
      // An answer he was still thinking for her round is taken back; the round stays open and is asked again after
      // the clip (the clip is not an answer, so it closes nothing).
      self.retractUnheard()
      self.turnGen += 1
      self.stopTalk()
      self.busy = false
      self.endPageTurn()
      self.speaker.drop()
      self.replyStarted = true
      self.replyEnded = true
      self.speaker.add(audio, mime: mime)
      if self.speaker.flush(started: true, complete: true) {
        self.closeCallEar()
        self.emit?(["type": "phase", "phase": "speaking"])
      } else {
        self.settled()
        self.kick()
      }
    }
  }

  // MARK: Turns

  /// She tapped him: his reply stops. Stopped while speaking, what she heard is kept and what she added meanwhile goes
  /// now; stopped while thinking, her lines stay unanswered in the round and go with whatever she says next.
  func interrupt() {
    queue.async {
      let wasSpeaking = self.replyStarted && (self.speaker.playing || self.speaker.hasWaiting || self.busy)
      self.retractUnheard()
      self.turnGen += 1
      self.stopTalk()
      self.busy = false
      self.endPageTurn()
      self.speaker.drop()
      self.settled()
      if wasSpeaking { self.kick() }
    }
  }

  /// A turn the page started (she typed a line, or edited or re-asked one): the shell asks and speaks it, in a call or
  /// not, so it goes on when she leaves the app. Whatever he was saying stops.
  func talkFromPage(_ body: [String: Any]) {
    queue.async {
      guard let replyId = body["replyId"] as? String, let userId = body["userMsgId"] as? String else { return }
      self.retractUnheard()
      self.turnGen += 1
      let gen = self.turnGen
      self.stopTalk()
      self.release()
      self.speaker.drop()
      self.muted = !self.callOn && ((body["profile"] as? [String: Any])?["muted"] as? Bool ?? false)
      self.busy = true
      self.replyStarted = false
      self.replyEnded = false
      self.pageTurn = true
      self.pageReply = replyId
      self.holdAppAlive()
      self.emit?(["type": "phase", "phase": "thinking"])
      self.talkTask = Task {
        await self.talk(body, replyId: replyId, userId: userId, gen: gen)
        self.queue.async {
          guard self.turnGen == gen else { return }
          self.busy = false
          self.endPageTurn()
          self.talkTask = nil
          if !self.speaker.playing && !self.speaker.hasWaiting { self.settled() }
          // What she said, typed or tapped while it ran goes now (or after his voice, if it is still playing).
          self.kick()
        }
      }
    }
  }

  /// She talked over him (pressed to talk while he was speaking): his voice stops; what she heard of it is kept.
  private func stopHim() {
    turnGen += 1
    stopTalk()
    busy = false
    endPageTurn()
    speaker.drop()
  }

  private func addLine(_ text: String, mode: String?) {
    let id = UUID().uuidString.lowercased()
    let at = Int(Date().timeIntervalSince1970 * 1000)
    emit?(["type": "heard", "id": id, "text": text, "at": at])
    round.append(Piece(id: id, at: at, text: text, mode: mode))
    kick()
  }

  /**
   * Answer the round as it is now. Whatever he was thinking for it is dropped and he thinks again with all of her
   * lines in it. While she is saying something, the end of it calls this again; while his voice is playing, its end does.
   */
  private func kick() {
    guard !holding, finishingHolds == 0, !lineOpen, !pageTurn, saving.isEmpty, !round.isEmpty else { return }
    // His voice is playing, or his answer is in (heard, or read: complete with no voice waiting) and still being saved:
    // the next round waits for it. An answer whose voice still waits for her has not been heard: it is dropped below.
    if (replyStarted || (replyEnded && !speaker.hasWaiting)) && (busy || speaker.playing) { return }
    turnGen += 1
    let gen = turnGen
    talkTask?.cancel()
    // A new id for every ask: one taken back is forgotten on the server (the page asks), so it must not come back.
    if let open = roundReply { emit?(["type": "retract", "id": open]) }
    let reply = UUID().uuidString.lowercased()
    roundReply = reply
    let pieces = round
    askedPieces = pieces.count
    busy = true
    replyStarted = false
    replyEnded = false
    speaker.drop()
    holdAppAlive()
    emit?(["type": "phase", "phase": "thinking"])
    let last = pieces[pieces.count - 1]
    var body: [String: Any] = [
      "text": last.text,
      "userMsgId": last.id,
      "userCreatedAt": last.at,
      "replyId": reply,
      // Her earlier lines of the round, kept in order before this one (a round, so a dropped answer is not saved).
      "earlier": pieces.dropLast().map { ["id": $0.id, "text": $0.text, "at": $0.at] as [String: Any] },
    ]
    if let mode = last.mode {
      var voice: [String: Any] = ["mode": mode, "sec": takeSec()]
      if mode == "hold" { voice["ms"] = lastMs }
      body["voice"] = voice
    }
    let ask = body
    talkTask = Task {
      await self.talk(ask, replyId: reply, userId: last.id, gen: gen)
      self.queue.async {
        guard self.turnGen == gen else { return }
        self.busy = false
        self.talkTask = nil
        if !self.speaker.playing && !self.speaker.hasWaiting { self.settled() }
        // Answered (his voice, or words only): lines she added after it was asked go now. Failed: they wait for her.
        if self.askedPieces == 0 { self.kick() }
      }
    }
  }

  private func takeSec() -> Double {
    let s = (sec * 10).rounded() / 10
    sec = 0
    return s
  }

  /// One answer from /api/talk: his words to the page as they come, his voice to the speaker.
  private func talk(_ raw: [String: Any], replyId: String, userId: String, gen: Int) async {
    defer {
      queue.async {
        guard self.turnGen == gen else { return }
        self.replyEnded = true
        self.flushVoice()
      }
    }
    guard let url = Net.endpoint("api/talk") else {
      softFail("talk-url")
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    req.setValue(await Net.cookieHeader(), forHTTPHeaderField: "Cookie")
    var body = raw
    body.removeValue(forKey: "type")
    let now = Int(Date().timeIntervalSince1970 * 1000)
    body["timeZone"] = TimeZone.current.identifier
    body["nowMs"] = now
    if body["userCreatedAt"] == nil { body["userCreatedAt"] = now }
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    do {
      let (bytes, res) = try await Net.stream(req)
      let code = (res as? HTTPURLResponse)?.statusCode ?? 0
      guard code == 200 else {
        if current(gen) { softFail("talk \(code)") }
        return
      }
      // One SSE frame ends at a blank line. Only the last byte is looked at: searching the whole growing frame on
      // every byte made each piece of his voice (tens of KB) take seconds to read, so it arrived late and stuttered.
      var buf = Data()
      buf.reserveCapacity(64 * 1024)
      var speech = ""
      var last: UInt8 = 0
      for try await byte in bytes {
        if Task.isCancelled { return }
        if byte == 10 && last == 10 {
          let frame = buf
          buf.removeAll(keepingCapacity: true)
          last = 0
          guard let event = Net.sse(frame) else { continue }
          let kind = event["t"] as? String ?? ""
          if kind == "text", let delta = event["d"] as? String {
            speech += delta
            showReply(replyId, speech, to: userId, gen: gen)
          } else if kind == "text_end", let full = event["speech"] as? String, !full.isEmpty {
            speech = full
            showReply(replyId, speech, to: userId, gen: gen)
          } else if kind == "audio", let b64 = event["b"] as? String {
            let mime = event["m"] as? String ?? ""
            let replace = event["replace"] as? Bool ?? false
            queue.async {
              guard self.turnGen == gen else { return }
              self.voiceIn(b64, mime: mime, replace: replace)
            }
          } else if kind == "err" {
            // Only his voice failed: his words are fine and keep coming.
            if event["tts"] as? Bool == true { continue }
            // A reply she already stopped (left running so it is saved) fails quietly.
            if current(gen) { softFail((event["m"] as? String) ?? "talk") }
            return
          } else if kind == "done" {
            if speech.isEmpty, let full = event["speech"] as? String {
              speech = full
              showReply(replyId, speech, to: userId, gen: gen)
            }
            // The reply is complete at "done"; the stream stays open a moment longer while the server saves it.
            queue.async {
              guard self.turnGen == gen else { return }
              self.failures = 0
              self.replyEnded = true
              self.flushVoice()
              // Words only (muted, or no voice came): she has read his answer, so the lines it answers are done.
              if !self.replyStarted && !self.speaker.hasWaiting { self.closeRound() }
            }
          }
          continue
        }
        buf.append(byte)
        last = byte
      }
    } catch {
      if Task.isCancelled || !current(gen) { return }
      softFail("talk \(error.localizedDescription)")
    }
  }

  /// His words on the page, unless this answer has been dropped meanwhile.
  private func showReply(_ id: String, _ text: String, to userId: String, gen: Int) {
    queue.async {
      guard self.turnGen == gen else { return }
      self.emit?(["type": "reply", "id": id, "text": text, "replyTo": userId])
    }
  }

  private func voiceIn(_ b64: String, mime: String, replace: Bool) {
    // Muted (outside a call): his words only.
    if muted && !callOn { return }
    speaker.add(b64, mime: mime, replace: replace)
    flushVoice()
  }

  /// His voice goes to the speaker, unless she is saying something before he has started (holding, or mid-line in a
  /// call): then it waits, and goes on if her line turns out to have no words.
  private func flushVoice() {
    guard speaker.hasWaiting else { return }
    if !replyStarted && (holding || finishingHolds > 0 || lineOpen) { return }
    guard speaker.flush(started: replyStarted, complete: replyEnded) else { return }
    if !replyStarted {
      replyStarted = true
      // The lines this reply answers are done; any she added after it was asked stay for the next round.
      closeRound()
      letAppGo()
      // In a call, nothing of hers is sent while he speaks (a new stream opens half a second after his voice).
      closeCallEar()
      emit?(["type": "phase", "phase": "speaking"])
    }
  }

  /// His voice has played out.
  private func voiceEnded() {
    if callOn {
      awake = true
      heardAt = Date().addingTimeInterval(0.5)
    }
    if !busy { settled() }
    if replyStarted { kick() }
  }

  /// Nothing more from him for now: where things are, for the page.
  private func settled() {
    if callOn {
      emit?(["type": "phase", "phase": lineOpen ? "speaking-you" : "listening"])
    } else {
      emit?(["type": "phase", "phase": "idle"])
      letAppGo()
      speaker.rest()
    }
  }

  /// Stop following his current reply. Once his voice has started (or his words are all in) she has heard or read it,
  /// so the request is left to finish and be saved (what it still sends is ignored, by turnGen), and the next round
  /// waits for it; before that it is dropped and not kept.
  private func stopTalk() {
    if let task = talkTask, busy, replyStarted || (replyEnded && !speaker.hasWaiting) {
      let id = UUID()
      saving.insert(id)
      Task {
        await task.value
        self.queue.async {
          self.saving.remove(id)
          self.kick()
        }
      }
    } else {
      talkTask?.cancel()
    }
    talkTask = nil
  }

  /// Takes back a reply he was still thinking (she has neither heard nor read any of it).
  private func retractUnheard() {
    guard !replyStarted else { return }
    if pageTurn {
      if busy && !replyEnded, let open = pageReply { emit?(["type": "retract", "id": open]) }
      return
    }
    if let open = roundReply, busy || speaker.hasWaiting { emit?(["type": "retract", "id": open]) }
  }

  private func endPageTurn() {
    pageTurn = false
    pageReply = nil
  }

  /// His answer to the round has started (or came as words only): the lines it answers are done; any she added after
  /// it was asked stay for the next round.
  private func closeRound() {
    guard askedPieces > 0 else { return }
    round.removeFirst(min(askedPieces, round.count))
    askedPieces = 0
    roundReply = nil
  }

  /// The round is over (a page turn or the end of the call took over): what she says next is a new round.
  private func release() {
    round.removeAll()
    roundReply = nil
    askedPieces = 0
  }

  private func current(_ gen: Int) -> Bool {
    queue.sync { self.turnGen == gen }
  }

  // MARK: Hearing

  private func heard(_ frame: [Int16], _ rms: Float) {
    if holding {
      holdClip.append(contentsOf: frame)
      holdEar?.send(frame)
    } else if callOn {
      callFrame(frame, rms)
    }
  }

  private func takeTicket(_ mode: String) -> StreamTicket? {
    guard let ticket = tickets[mode] else { return nil }
    tickets[mode] = nil
    return ticket.fresh ? ticket : nil
  }

  private func prefetch(_ mode: String) {
    guard !ticketLoading.contains(mode), tickets[mode]?.fresh != true else { return }
    ticketLoading.insert(mode)
    Task {
      let got = await self.fetchTicket(mode)
      self.queue.async {
        self.ticketLoading.remove(mode)
        if let got { self.tickets[mode] = got }
      }
    }
  }

  private func fetchTicket(_ mode: String) async -> StreamTicket? {
    guard let url = Net.endpoint("api/stt-stream", query: "mode=\(mode)") else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.timeoutInterval = 10
    req.setValue(await Net.cookieHeader(), forHTTPHeaderField: "Cookie")
    guard let sent = try? await Net.send(req),
          (sent.1 as? HTTPURLResponse)?.statusCode == 200,
          let json = try? JSONSerialization.jsonObject(with: sent.0) as? [String: Any] else { return nil }
    return StreamTicket(json)
  }

  // MARK: Staying alive

  /**
   * A call must outlive the page. When the app goes to the background, WebKit pauses its own media and the audio
   * session can be interrupted or reconfigured; a mic that stops then is never started again, iOS suspends the app,
   * and the call goes silent. So while a call is on (or she is holding), any of these puts the mic back.
   */
  private func watchAudio() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] _ in
      self?.queue.async { self?.revive("config change") }
    })
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
      let began = AVAudioSession.InterruptionType(rawValue: raw) == .began
      self?.queue.async {
        if began {
          self?.report("interrupted")
        } else {
          self?.revive("interruption ended")
        }
      }
    })
    observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
      self?.queue.async { self?.revive("media services reset") }
    })
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
      self?.queue.async {
        guard let self else { return }
        // Holding to talk ends with the app in front; the call goes on.
        if self.holding {
          self.holding = false
          if !self.callOn { self.mic.stop() }
          self.holdEar?.close()
          self.holdEar = nil
          self.holdClip.removeAll()
          if self.round.count > self.askedPieces { self.kick() }
          self.flushVoice()
          if !self.busy && !self.speaker.playing { self.settled() }
        }
        self.revive("background")
      }
    })
  }

  /// While a call is on: the session active and the mic running; started again if it is not.
  private func revive(_ why: String) {
    guard callOn || holding else { return }
    if mic.engineRunning {
      return
    }
    Voice.activateSession()
    do {
      try mic.start()
      report("\(why): mic restarted")
    } catch {
      report("\(why): mic failed \(error.localizedDescription)")
    }
  }

  private func startWatchdog() {
    // Some of these changes come without any notification (WebKit letting go of the audio in the background).
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 2, repeating: 2)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      if self.callOn && !self.mic.engineRunning { self.revive("mic stopped") }
      // Audio that should long be over but never reported done would leave him "speaking" (and in a call, her unheard).
      if self.speaker.playing && Date().timeIntervalSince(self.speaker.endsAt) > 1.5 {
        self.report("playback never finished")
        self.speaker.drop()
        self.voiceEnded()
      }
    }
    timer.resume()
    watchdog = timer
  }

  /// The few seconds before his voice starts outside a call (no audio yet to keep the app awake in the background).
  private func holdAppAlive() {
    guard !callOn else { return }
    DispatchQueue.main.async {
      guard self.keepAlive == .invalid else { return }
      // When the time is up iOS needs the task ended before this returns.
      self.keepAlive = UIApplication.shared.beginBackgroundTask(withName: "qingran-reply") { [weak self] in
        guard let self, self.keepAlive != .invalid else { return }
        UIApplication.shared.endBackgroundTask(self.keepAlive)
        self.keepAlive = .invalid
      }
    }
  }

  private func letAppGo() {
    DispatchQueue.main.async {
      guard self.keepAlive != .invalid else { return }
      UIApplication.shared.endBackgroundTask(self.keepAlive)
      self.keepAlive = .invalid
    }
  }

  // MARK: Failing

  private func softFail(_ why: String) {
    queue.async {
      self.note(ok: false, error: why)
      self.failures += 1
      if self.callOn {
        Cues.shared.play(.cancel)
        if self.failures >= 3 { self.dropCall() }
      } else {
        self.emit?(["type": "speakFail", "text": "这会儿没连上，再说一次。"])
        self.settled()
      }
    }
  }

  private func dropCall() {
    let content = UNMutableNotificationContent()
    content.title = "清然"
    content.body = "通话断了"
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    DispatchQueue.main.async {
      CallEngine.shared.endCallFromWeb()
      self.emitEnded()
    }
  }

  private func emitEnded() {
    queue.async { self.emit?(["type": "ended"]) }
    let hangup = onHangup
    DispatchQueue.main.async { hangup?() }
  }

  /// What happened (mic on, background, restarted), so a silent call can be traced afterwards (/api/native-log).
  private func note(ok: Bool, error: String, detail: String = "") {
    Task {
      guard let url = Net.endpoint("api/native-log") else { return }
      var req = URLRequest(url: url)
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.setValue(await Net.cookieHeader(), forHTTPHeaderField: "Cookie")
      let state = await MainActor.run { UIApplication.shared.applicationState == .background ? "bg" : "fg" }
      let body: [String: Any] = [
        "ok": ok,
        "error": String(error.prefix(500)),
        "note": "voice \(state) \(detail)".trimmingCharacters(in: .whitespaces),
      ]
      req.httpBody = try? JSONSerialization.data(withJSONObject: body)
      _ = try? await URLSession.shared.data(for: req)
    }
  }
}
