import AVFoundation
import Foundation
import UIKit
import UserNotifications
import WebKit

/// Owns every call inside the shell, like WeChat: mic (lifted to the browser's level), the same VAD as the web
/// (src/lib/lover/vad.ts), each line heard while she says it (streamed to xAI, and Apple's recognizer on the phone;
/// NativeHearing.swift), finished through /api/stt (the web's hearing pipeline on the server), /api/talk, and
/// playback. Keeps going with the app in the background.
final class NativePipeline {
  static let shared = NativePipeline()

  private let queue = DispatchQueue(label: "qingran.native-call")
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var converter: AVAudioConverter?
  private var playerFormat: AVAudioFormat?
  private var playerAttached = false
  private var running = false
  private var stopping = false
  private var params = NativeVadParams()

  // VAD
  private var level: Float = 0
  private var floor: Float = NativeVad.floorStart
  private var riseMs: Float = 0
  private var preroll: [Int16] = []
  private var inSpeech = false
  private var speech: [Int16] = []
  private var speechMs: Float = 0
  private var quietMs: Float = 0
  private var speechStartAt = 0
  private var triggerFloor: Float = 0
  /// How much her voice is lifted, and how loud (before the lift) her voiced moments in this line were.
  private var gain: Float = NativeVad.gainStart
  private var voicedRaw: [Float] = []
  private var peaksRaw: [Float] = []

  // Hearing the line while she says it
  private var line: LineHearing?
  /// xAI accepted this line's stream, so its turn model may end the line.
  private var lineLive = false
  /// xAI's turn model said the sentence is finished.
  private var lineSaysDone = false
  /// When Apple last heard new words in this line (Apple on) or nil (Apple off for this line).
  private var lineWordsAt: Date?
  private var ticket: StreamTicket?
  private var ticketLoading = false
  /// The stream failed twice in a row: lines go to the server whole for a while, then it is tried again.
  private var streamPausedUntil = Date.distantPast
  private var streamTroubles = 0
  private var streamPauses = 0
  private var streamOff: Bool { Date() < streamPausedUntil }
  private var backstopMs = NativeVad.backstopMs

  // Turn and playback
  /// This round: her short messages (lines she said, lines she typed or tapped) not yet answered aloud, each its own
  /// bubble, and the one reply they will get. Until his voice starts, each new one stops his thinking and he thinks
  /// again with all of them; once he speaks the round is closed and what comes next starts the next round.
  private var round: [Piece] = []
  private var roundReply: String?
  /// Tapped while she is saying a line: goes on the end of that line.
  private var suffix = ""
  private var busy = false
  /// How many of the round's first pieces the reply being written answers (the rest came in after it was asked).
  private var askedPieces = 0
  /// A turn the page started is running: lines she adds meanwhile wait for it, then go as the next round.
  private var pageTurn = false
  private var turnGen = 0
  private var talkTask: Task<Void, Never>?
  private var pendingBuffers = 0
  /// His voice arrives in pieces; like the web player, it starts once a little is buffered and waits again after
  /// running dry, so one reply plays as one stretch instead of stopping between pieces.
  private var waiting: [AVAudioPCMBuffer] = []
  private var waitingFrames: Double = 0
  private var replyEnded = false
  private var replyStarted = false
  private static let startSec = 0.42
  private static let holdSec = 0.32
  /// When the audio handed to the player should have finished; past this (plus a margin) it is treated as done.
  private var playEndsAt = Date.distantPast
  /// Bumped whenever scheduled audio is thrown away, so late completion callbacks are ignored.
  private var playGen = 0
  private var playing: Bool { pendingBuffers > 0 }
  private var playIdleAt = Date.distantPast
  /// One converter for his voice across the pieces of a reply, so the resampler keeps its state and no piece loses its tail.
  private var playConverter: AVAudioConverter?
  /// An odd byte left at the end of a piece of his voice, joined to the next piece.
  private var pcmCarry = Data()
  private var failures = 0
  private var emit: (([String: Any]) -> Void)?
  private var observers: [NSObjectProtocol] = []
  private var watchdog: DispatchSourceTimer?

  private init() {}

  var onHangup: (() -> Void)?

  func prepare(params raw: [String: Any]?, emit: @escaping ([String: Any]) -> Void) {
    let next = NativeVadParams(raw)
    let saved = UserDefaults.standard.float(forKey: NativeVad.gainKey)
    queue.sync {
      self.params = next
      self.gain = saved > 0 ? min(NativeVad.gainMax, max(NativeVad.gainMin, saved)) : NativeVad.gainStart
      self.streamPausedUntil = .distantPast
      self.streamTroubles = 0
      self.streamPauses = 0
    }
    LineHearing.askApple()
    self.emit = emit
    failures = 0
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  func permissionDenied() {
    emit?(["type": "error", "text": "麦克风没开。"])
    emitHangup()
  }

  func startEngine() {
    queue.async { [weak self] in
      self?.startEngineOnQueue()
    }
  }

  func stop() {
    queue.sync {
      haltLocked()
    }
  }

  /**
   * A turn the page starts during the call (she edited or re-asked a line, or typed one): the shell runs it, like a
   * turn it heard itself. Whatever he was saying stops, and the mic stays deaf while the new reply plays, so the
   * reply is never spoken by the page and heard back as her.
   */
  func talkFromPage(text: String, userId: String, userAt: Int, replyId: String, replyAt: Int) {
    queue.async { [weak self] in
      guard let self, self.running else { return }
      self.turnGen += 1
      let gen = self.turnGen
      self.talkTask?.cancel()
      self.inSpeech = false
      self.dropLine()
      self.speech.removeAll()
      self.preroll.removeAll()
      if let open = self.roundReply, !self.replyStarted { self.emit?(["type": "retract", "id": open]) }
      self.release()
      self.dropPlayback()
      if self.engine.isRunning { self.player.play() }
      self.busy = true
      self.pageTurn = true
      self.emit?(["type": "phase", "phase": "thinking"])
      self.talkTask = Task {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        await self.talk(text: text, userId: userId, replyId: replyId, now: now, gen: gen, userAt: userAt, replyAt: replyAt)
        self.queue.async {
          guard self.turnGen == gen else { return }
          self.busy = false
          self.pageTurn = false
          self.talkTask = nil
          if self.running && !self.playing { self.emit?(["type": "phase", "phase": "listening"]) }
          // What she typed or tapped while it ran goes now (or after his voice, if it is still playing).
          self.kick()
        }
      }
    }
  }

  /**
   * She pressed play on one of his lines during the call. The shell owns the speaker, so the shell speaks it: whatever
   * he was saying or about to say stops (as when she taps him), the clip plays as one reply, and the mic is deaf while
   * it plays and listens again after.
   */
  func playFromPage(_ audio: String, mime: String) {
    queue.async { [weak self] in
      guard let self, self.running else { return }
      // An answer he was still thinking for her round is taken back; the round is asked again after the clip.
      if self.busy && !self.replyStarted, let open = self.roundReply { self.emit?(["type": "retract", "id": open]) }
      self.turnGen += 1
      self.talkTask?.cancel()
      self.talkTask = nil
      self.busy = false
      self.pageTurn = false
      self.askedPieces = 0
      self.dropPlayback()
      if self.engine.isRunning { self.player.play() }
      self.replyStarted = false
      self.replyEnded = true
      self.playPCM(audio, mime: mime, replace: false)
      self.drainPlayConverter()
      self.flushPlayback()
    }
  }

  /// She tapped him (the orb on the page), as in the web call: his reply stops and the call listens again.
  func interrupt() {
    queue.async { [weak self] in
      guard let self, self.running else { return }
      let wasSpeaking = self.replyStarted
      if !wasSpeaking, self.busy, let open = self.roundReply { self.emit?(["type": "retract", "id": open]) }
      self.turnGen += 1
      self.talkTask?.cancel()
      self.talkTask = nil
      self.busy = false
      self.pageTurn = false
      // Stopped while thinking: her lines stay unanswered in the round and go with whatever she says next.
      self.dropPlayback()
      if self.engine.isRunning { self.player.play() }
      self.emit?(["type": "phase", "phase": "listening"])
      // Stopped while speaking: what she typed or tapped meanwhile goes now.
      if wasSpeaking { self.kick() }
    }
  }

  /**
   * She typed a line, or tapped one of the two phrases beside the hang-up button. Tapped while she is saying a line,
   * it goes on the end of that line; otherwise it is a message of its own in this round, like a line she said.
   */
  func addFromPage(_ text: String, attach: Bool) {
    queue.async { [weak self] in
      guard let self, self.running, !text.isEmpty else { return }
      if attach && self.inSpeech {
        self.suffix += text
        return
      }
      let id = UUID().uuidString.lowercased()
      let at = Int(Date().timeIntervalSince1970 * 1000)
      self.emit?(["type": "heard", "id": id, "text": text, "at": at])
      self.round.append(Piece(id: id, at: at, text: Task { text }))
      self.kick()
    }
  }

  private func startEngineOnQueue() {
    if running { return }
    watchAudio()
    let input = engine.inputNode
    let inFormat = input.inputFormat(forBus: 0)
    guard inFormat.sampleRate > 0,
          let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(NativeVad.sampleRate), channels: 1, interleaved: false),
          let conv = AVAudioConverter(from: inFormat, to: outFormat) else {
      note(ok: false, error: "audio-format")
      dropAfter(failures: 3)
      return
    }
    converter = conv
    if !playerAttached {
      engine.attach(player)
      playerAttached = true
    }
    // Connected again on every start: after a route or configuration change the old connection can play into nothing.
    engine.disconnectNodeOutput(player)
    engine.connect(player, to: engine.mainMixerNode, format: nil)
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
      self?.take(buffer)
    }
    do {
      engine.prepare()
      try engine.start()
      playerFormat = player.outputFormat(forBus: 0)
      player.play()
      level = 0
      floor = NativeVad.floorStart
      riseMs = 0
      preroll.removeAll()
      playIdleAt = Date()
      running = true
      mark("engine on")
      prefetchTicket()
      emit?(["type": "phase", "phase": busy ? "thinking" : "listening"])
    } catch {
      note(ok: false, error: "engine \(error.localizedDescription)")
      dropAfter(failures: 3)
    }
  }

  /**
   * The call must outlive the page. When the app goes to the background, WebKit pauses its own media and the
   * audio session can be interrupted or reconfigured; an engine that stops then is never started again, iOS
   * suspends the app, and the call goes silent. So while a call is on, any of these puts the engine back.
   */
  private func watchAudio() {
    if watchdog == nil {
      // Some of these changes come without any notification (WebKit letting go of the audio in the background).
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + 2, repeating: 2)
      timer.setEventHandler { [weak self] in
        guard let self, self.running else { return }
        if !self.engine.isRunning {
          self.revive("engine stopped")
          return
        }
        // Audio that should long be over but never reported done would leave him "speaking" and her unheard.
        if self.playing && Date().timeIntervalSince(self.playEndsAt) > 1.5 {
          self.mark("playback never finished")
          self.dropPlayback()
          self.player.play()
          if !self.busy { self.emit?(["type": "phase", "phase": "listening"]) }
        }
      }
      timer.resume()
      watchdog = timer
    }
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
      self?.queue.async { self?.revive("config change") }
    })
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
      let began = AVAudioSession.InterruptionType(rawValue: raw) == .began
      self?.queue.async {
        if began {
          self?.mark("interrupted")
        } else {
          self?.revive("interruption ended")
        }
      }
    })
    observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
      self?.queue.async { self?.revive("media services reset") }
    })
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
      self?.queue.async { self?.revive("background") }
    })
    observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { [weak self] _ in
      self?.queue.async { self?.revive("foreground") }
    })
  }

  /// During a call: make sure the session is active and the engine is running; restart it if it is not.
  private func revive(_ why: String) {
    guard running, !stopping else { return }
    if engine.isRunning {
      mark("\(why): engine on")
      return
    }
    do {
      try AVAudioSession.sharedInstance().setActive(true, options: [])
    } catch {
      mark("\(why): session \(error.localizedDescription)")
    }
    running = false
    // Whatever was scheduled went with the stopped engine; the rest of his reply still plays after the restart.
    dropPlayback()
    replyStarted = false
    engine.inputNode.removeTap(onBus: 0)
    startEngineOnQueue()
    mark("\(why): engine restarted \(running ? "ok" : "failed")")
  }

  private func haltLocked() {
    if stopping { return }
    stopping = true
    defer { stopping = false }
    running = false
    watchdog?.cancel()
    watchdog = nil
    turnGen += 1
    talkTask?.cancel()
    talkTask = nil
    busy = false
    pageTurn = false
    inSpeech = false
    dropLine()
    riseMs = 0
    for piece in round { piece.text.cancel() }
    if let open = roundReply, !replyStarted { emit?(["type": "retract", "id": open]) }
    release()
    dropPlayback()
    preroll.removeAll()
    speech.removeAll()
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
  }

  private func take(_ buffer: AVAudioPCMBuffer) {
    guard running, let conv = converter,
          let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(NativeVad.sampleRate), channels: 1, interleaved: false) else { return }
    let ratio = outFormat.sampleRate / buffer.format.sampleRate
    let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: max(cap, 32)),
          let samples = out.int16ChannelData else { return }
    var consumed = false
    var error: NSError?
    conv.convert(to: out, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    if error != nil || out.frameLength == 0 { return }
    let n = Int(out.frameLength)
    var copy = [Int16](repeating: 0, count: n)
    for i in 0..<n { copy[i] = samples[0][i] }
    queue.async { [weak self] in
      self?.feed(copy)
    }
  }

  /// Same steps as the tick in src/hooks/use-call.ts, on her voice lifted to the browser's level.
  private func feed(_ heard: [Int16]) {
    guard running, !heard.isEmpty else { return }
    var samples = heard
    var peak: Float = 0
    for i in samples.indices {
      let x = Float(samples[i]) / 32768
      peak = max(peak, abs(x))
      samples[i] = Int16((Self.limit(x * gain) * 32767).rounded())
    }
    var sum: Float = 0
    for s in samples {
      let x = Float(s) / 32768
      sum += x * x
    }
    let rms = sqrt(sum / Float(samples.count))
    let chunkMs = Float(samples.count) * 1000 / Float(NativeVad.sampleRate)

    level += (rms - level) * (1 - exp(-chunkMs / NativeVad.levelMs))
    let afterPlayback = !playing && Float(Date().timeIntervalSince(playIdleAt) * 1000) >= NativeVad.postPlaybackMs
    if afterPlayback {
      floor = nextFloor(floor, level, chunkMs, inTurn: inSpeech)
    }

    // While his voice is in the room (playing, or a moment after) the mic is not listening, and nothing from then is
    // kept for the next turn's pre-roll — without echo cancelling, his voice from the speaker would be sent as hers.
    // While he is only thinking about her last words, it still listens: if she goes on, those words were not the end.
    let canGoOn = busy && !replyStarted && roundReply != nil
    if !afterPlayback || (busy && !canGoOn) {
      riseMs = 0
      preroll.removeAll(keepingCapacity: true)
      return
    }

    let keep = NativeVad.sampleRate * NativeVad.preRollMs / 1000
    preroll.append(contentsOf: samples)
    if preroll.count > keep { preroll.removeFirst(preroll.count - keep) }

    if !inSpeech {
      if level >= max(params.startMin, floor * params.startMult) {
        riseMs += chunkMs
        // Going on with a line already sent takes a little more than a click or a rustle.
        if riseMs < (canGoOn ? max(params.startHoldMs, NativeVad.goOnHoldMs) : params.startHoldMs) { return }
        inSpeech = true
        riseMs = 0
        quietMs = 0
        if canGoOn {
          // She went on: the answer being prepared is dropped; this line joins the round as a new message.
          turnGen += 1
          talkTask?.cancel()
          talkTask = nil
          busy = false
          waiting.removeAll()
          waitingFrames = 0
          playConverter = nil
          pcmCarry = Data()
          // The start of his answer may already be on the page; it goes.
          if let open = roundReply { emit?(["type": "retract", "id": open]) }
          mark("she went on")
        }
        speech = preroll
        speechMs = 0
        triggerFloor = floor
        speechStartAt = Int(Date().timeIntervalSince1970 * 1000)
        suffix = ""
        startLine()
        line?.push(preroll)
        voicedRaw.removeAll(keepingCapacity: true)
        peaksRaw.removeAll(keepingCapacity: true)
        emit?(["type": "phase", "phase": "speaking-you"])
      } else {
        riseMs = 0
      }
      return
    }

    speech.append(contentsOf: samples)
    line?.push(samples)
    speechMs += chunkMs
    if level >= max(params.holdMin, floor * params.holdMult) {
      quietMs = 0
      if voicedRaw.count < 30_000 {
        voicedRaw.append(level / gain)
        peaksRaw.append(peak)
      }
    } else {
      quietMs += chunkMs
    }
    // How the line ends. The phone's ear only measures loudness, so outdoors (traffic, wind) the room never sounds
    // quiet; the ears that hear words decide instead: xAI's turn model saying the sentence is finished, or no new
    // words from Apple for a while. Without either, her own pause setting on loudness.
    let streaming = lineLive
    let smart = streaming && lineSaysDone
    let wordless = lineWordsAt.map { Float(Date().timeIntervalSince($0) * 1000) >= NativeVad.wordlessMs } ?? false
    let wait = streaming ? max(params.endWaitMs, backstopMs) : params.endWaitMs
    let capped = speechMs >= params.maxUtteranceMs
    let ended = speechMs >= NativeVad.minSpeechMs && (smart || wordless || quietMs >= wait)
    if capped || ended {
      let said = speech
      let silenceWait = Int(quietMs)
      let endedBy = capped ? "cap" : smart ? "smart" : wordless ? "wordless" : "quiet"
      let hearing = line
      line = nil
      lineLive = false
      lineSaysDone = false
      lineWordsAt = nil
      let voice = voiceOf(voicedRaw, peaks: peaksRaw)
      inSpeech = false
      speech.removeAll(keepingCapacity: true)
      preroll.removeAll(keepingCapacity: true)
      speechMs = 0
      quietMs = 0
      let start = speechStartAt
      let vadFloor = triggerFloor
      let tail = suffix
      suffix = ""
      let id = UUID().uuidString.lowercased()
      // Heard on its own, whatever else happens to the round: it becomes her bubble as soon as it has words.
      let text = Task { () -> String in
        await self.hear(said, id: id, at: start, tail: tail, hearing: hearing, silenceWaitMs: silenceWait,
                        vadFloor: vadFloor, endedBy: endedBy, voice: voice)
      }
      prefetchTicket()
      round.append(Piece(id: id, at: start, text: text))
      kick()
    }
  }

  /**
   * Answer the round as it is now. Whatever he was thinking for it is dropped and he thinks again with all of her
   * messages in it. While his voice is playing, she waits for him to finish; while she is saying a line, the end of
   * that line calls this again.
   */
  private func kick() {
    guard running, !inSpeech, !pageTurn, !round.isEmpty else { return }
    if replyStarted && (busy || playing) { return }
    turnGen += 1
    let gen = turnGen
    talkTask?.cancel()
    if let open = roundReply { emit?(["type": "retract", "id": open]) }
    let reply = roundReply ?? UUID().uuidString.lowercased()
    roundReply = reply
    let pieces = round
    askedPieces = pieces.count
    busy = true
    replyStarted = false
    waiting.removeAll()
    waitingFrames = 0
    playConverter = nil
    pcmCarry = Data()
    emit?(["type": "phase", "phase": "transcribing"])
    talkTask = Task {
      var said: [[String: Any]] = []
      for piece in pieces {
        let text = await piece.text.value
        if !text.isEmpty { said.append(["id": piece.id, "text": text, "at": piece.at]) }
      }
      // In the order she said them (a typed line can come in while she is still saying one), as the server keeps them.
      said.sort { ($0["at"] as? Int ?? 0) < ($1["at"] as? Int ?? 0) }
      if let last = said.last, self.current(gen) {
        self.queue.async {
          guard self.turnGen == gen else { return }
          self.emit?(["type": "phase", "phase": "thinking"])
        }
        let now = Int(Date().timeIntervalSince1970 * 1000)
        await self.talk(text: last["text"] as? String ?? "", userId: last["id"] as? String ?? "", replyId: reply, now: now,
                        gen: gen, userAt: last["at"] as? Int, earlier: Array(said.dropLast()))
      }
      self.queue.async {
        guard self.turnGen == gen else { return }
        self.busy = false
        self.talkTask = nil
        if self.running && !self.playing { self.emit?(["type": "phase", "phase": "listening"]) }
        // He answered: anything she typed or tapped while he spoke is the next round.
        if self.replyStarted { self.kick() }
      }
    }
  }

  private func nextFloor(_ floor: Float, _ level: Float, _ dtMs: Float, inTurn: Bool) -> Float {
    let f = floor > 0 ? floor : NativeVad.floorStart
    let rise = inTurn ? NativeVad.floorRiseMs : NativeVad.floorRiseIdleMs
    let next: Float
    if level <= f {
      next = f + (level - f) * (1 - exp(-dtMs / NativeVad.floorFallMs))
    } else {
      next = min(level, f * exp(dtMs / rise))
    }
    return min(NativeVad.floorMax, max(NativeVad.floorMin, next))
  }

  /// The round is closed (his voice started, or the call or a page turn took over): what she says next is a new round.
  private func release() {
    round.removeAll()
    roundReply = nil
    askedPieces = 0
  }

  /// Soft ceiling for the lifted voice: untouched up to 0.7, then bent toward 1, never clipped.
  private static func limit(_ x: Float) -> Float {
    let a = abs(x)
    if a <= 0.7 { return x }
    return (x < 0 ? -1 : 1) * (0.7 + 0.3 * tanh((a - 0.7) / 0.3))
  }

  /// How loud her voiced moments in a line were (median) and how loud her loud moments peaked (one click or tap
  /// does not count), both before the lift.
  private func voiceOf(_ voiced: [Float], peaks: [Float]) -> (median: Float, peak: Float)? {
    guard voiced.count >= 10 else { return nil }
    let sorted = voiced.sorted()
    let loud = peaks.sorted()
    return (sorted[sorted.count / 2], loud[min(loud.count - 1, loud.count * 95 / 100)])
  }

  /// After a line the server took as her speech (not a rustle), the lift moves toward what brings her voice to the
  /// browser's level, without lifting her loudest moment past the ceiling.
  private func learnGain(_ voice: (median: Float, peak: Float)) {
    guard voice.median > 0 else { return }
    var want = NativeVad.voiceTarget / voice.median
    if voice.peak > 0 { want = min(want, 0.9 / voice.peak) }
    want = min(NativeVad.gainMax, max(NativeVad.gainMin, want))
    gain = gain * 0.6 + want * 0.4
    UserDefaults.standard.set(gain, forKey: NativeVad.gainKey)
  }

  /// A new line starts: both ears open on it. The ticket fetched after the last line is used; without one, the line
  /// fetches its own (her first words are kept until it connects).
  private func startLine() {
    line?.cancel()
    let fresh = ticket?.fresh == true ? ticket : nil
    ticket = nil
    var fetch: (() async -> StreamTicket?)?
    if !streamOff && fresh == nil { fetch = { [weak self] in await self?.fetchTicket() } }
    weak var made: LineHearing?
    let hooks = LineHooks(
      onLive: { [weak self] in
        guard let this = made else { return }
        self?.queue.async {
          guard let self, self.line === this else { return }
          self.lineLive = true
        }
      },
      onFinished: { [weak self] in
        guard let this = made else { return }
        self?.queue.async {
          guard let self, self.line === this, self.inSpeech else { return }
          self.lineSaysDone = true
        }
      },
      onWords: { [weak self] in
        guard let this = made else { return }
        self?.queue.async {
          guard let self, self.line === this else { return }
          self.lineWordsAt = Date()
        }
      },
      onDead: { [weak self] why in
        let this = made
        self?.queue.async {
          guard let self else { return }
          if let this, self.line === this {
            self.lineLive = false
            self.lineSaysDone = false
          }
          self.note(ok: false, error: why)
          self.streamTroubles += 1
          if self.streamTroubles >= 2 && !self.streamOff {
            // 2 minutes, then twice as long each time it fails again in this call (at most 32).
            let minutes = min(32, 2 << min(self.streamPauses, 4))
            self.streamPauses += 1
            self.streamPausedUntil = Date().addingTimeInterval(Double(minutes) * 60)
            self.streamTroubles = 0
            self.mark("stream paused \(minutes) min")
          }
        }
      }
    )
    let next = LineHearing(ticket: streamOff ? nil : fresh, fetch: fetch, hooks: hooks)
    made = next
    line = next
    lineLive = false
    lineSaysDone = false
    lineWordsAt = next.appleOn ? Date() : nil
  }

  private func dropLine() {
    line?.cancel()
    line = nil
    lineLive = false
    lineSaysDone = false
    lineWordsAt = nil
  }

  private func prefetchTicket() {
    guard running, !streamOff, !ticketLoading, ticket?.fresh != true else { return }
    ticketLoading = true
    Task {
      let got = await self.fetchTicket()
      self.queue.async {
        self.ticketLoading = false
        guard self.running else { return }
        // No ticket now: the next line asks for its own.
        guard let got else { return }
        self.ticket = got
        self.backstopMs = got.backstopMs
      }
    }
  }

  private func fetchTicket() async -> StreamTicket? {
    guard let url = endpoint("api/stt-stream") else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.timeoutInterval = 10
    req.setValue(await cookieHeader(), forHTTPHeaderField: "Cookie")
    guard let sent = try? await Self.send(req),
          (sent.1 as? HTTPURLResponse)?.statusCode == 200,
          let json = try? JSONSerialization.jsonObject(with: sent.0) as? [String: Any] else { return nil }
    return StreamTicket(json)
  }

  private func dropPlayback() {
    playGen += 1
    pendingBuffers = 0
    playEndsAt = Date.distantPast
    waiting.removeAll()
    waitingFrames = 0
    playConverter = nil
    pcmCarry = Data()
    playIdleAt = Date()
    player.stop()
  }

  private func current(_ gen: Int) -> Bool {
    queue.sync { self.running && self.turnGen == gen }
  }

  /// One line she said, heard on its own (both ears, then the server's hearing). Its words, with anything she tapped
  /// while saying it, become her bubble; empty when nothing was heard.
  private func hear(_ samples: [Int16], id: String, at: Int, tail: String, hearing: LineHearing?, silenceWaitMs: Int,
                    vadFloor: Float, endedBy: String, voice: (median: Float, peak: Float)?) async -> String {
    let wav = wavData(samples)
    let endpointFired = Int(Date().timeIntervalSince1970 * 1000)
    let both = await hearing?.finish() ?? LineHeard.empty
    if both.stream != nil { queue.async { self.streamTroubles = 0 } }
    let heard = await transcribe(wav, speechStart: at, endpointFired: endpointFired, silenceWaitMs: silenceWaitMs,
                                 vadFloor: vadFloor, heard: both, endedBy: endedBy)
    if Task.isCancelled { return "" }
    // Counted only while the line is still in the round (not one thrown away by a hang-up or a page turn).
    if heard == nil, queue.sync(execute: { self.round.contains { $0.id == id } }) { softFail("stt") }
    // A line the server took as her speech teaches the lift how loud she is; a rustle does not.
    if let heard, !heard.isEmpty, let voice { queue.async { self.learnGain(voice) } }
    let text = (heard ?? "") + tail
    if !text.isEmpty { emit?(["type": "heard", "id": id, "text": text, "at": at]) }
    return text
  }

  private func transcribe(_ wav: Data, speechStart: Int, endpointFired: Int, silenceWaitMs: Int, vadFloor: Float,
                          heard: LineHeard, endedBy: String) async -> String? {
    guard let url = endpoint("api/stt") else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(await cookieHeader(), forHTTPHeaderField: "Cookie")
    var body: [String: Any] = [
      "audioBase64": wav.base64EncodedString(),
      "mimeType": "audio/wav",
      "speechStart": speechStart,
      "endpointFired": endpointFired,
      "silenceWaitMs": silenceWaitMs,
      "vadFloor": vadFloor,
      "endedBy": endedBy,
    ]
    if let stream = heard.stream {
      body["streamText"] = stream.text
      body["streamWords"] = stream.words
    }
    if let apple = heard.apple { body["liveText"] = apple }
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    do {
      let (data, res) = try await Self.send(req)
      let code = (res as? HTTPURLResponse)?.statusCode ?? 0
      guard code == 200,
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            json["ok"] as? Bool == true,
            let text = json["text"] as? String else {
        note(ok: false, error: "stt \(code)")
        return nil
      }
      return text.trimmingCharacters(in: .whitespacesAndNewlines)
    } catch {
      if Task.isCancelled { return nil }
      note(ok: false, error: "stt \(error.localizedDescription)")
      return nil
    }
  }

  /// A connection iOS dropped while the app changed state fails once with "connection lost"; the same request again goes through.
  private static func send(_ req: URLRequest) async throws -> (Data, URLResponse) {
    do {
      return try await URLSession.shared.data(for: req)
    } catch let error as URLError where error.code == .networkConnectionLost || error.code == .notConnectedToInternet {
      try await Task.sleep(nanoseconds: 400_000_000)
      return try await URLSession.shared.data(for: req)
    }
  }

  private static func stream(_ req: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
    do {
      return try await URLSession.shared.bytes(for: req)
    } catch let error as URLError where error.code == .networkConnectionLost || error.code == .notConnectedToInternet {
      try await Task.sleep(nanoseconds: 400_000_000)
      return try await URLSession.shared.bytes(for: req)
    }
  }

  private func talk(text: String, userId: String, replyId: String, now: Int, gen: Int, userAt: Int? = nil, replyAt: Int? = nil,
                    earlier: [[String: Any]]? = nil) async {
    queue.async {
      guard self.turnGen == gen else { return }
      self.replyEnded = false
      self.replyStarted = false
      self.pcmCarry = Data()
    }
    defer {
      queue.async {
        guard self.turnGen == gen else { return }
        self.replyEnded = true
        self.drainPlayConverter()
        self.flushPlayback()
      }
    }
    guard let url = endpoint("api/talk") else {
      softFail("talk-url")
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    req.setValue(await cookieHeader(), forHTTPHeaderField: "Cookie")
    let zone = TimeZone.current.identifier
    var body: [String: Any] = [
      "text": text,
      "userMsgId": userId,
      "userCreatedAt": userAt ?? now,
      "replyId": replyId,
      "timeZone": zone,
      "nowMs": now,
    ]
    if let replyAt { body["replyCreatedAt"] = replyAt }
    // Her earlier messages in this round (the server keeps them, in order, before this one).
    if let earlier { body["earlier"] = earlier }
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    do {
      let (bytes, res) = try await Self.stream(req)
      let code = (res as? HTTPURLResponse)?.statusCode ?? 0
      guard code == 200 else {
        softFail("talk \(code)")
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
          guard let event = sseJSON(frame) else { continue }
          let kind = event["t"] as? String ?? ""
          if kind == "text", let delta = event["d"] as? String {
            speech += delta
            showReply(replyId, speech, to: userId, gen: gen)
          } else if kind == "text_end", let full = event["speech"] as? String, !full.isEmpty {
            speech = full
            showReply(replyId, speech, to: userId, gen: gen)
          } else if kind == "audio", let b64 = event["b"] as? String {
            let replace = event["replace"] as? Bool ?? false
            let mime = event["m"] as? String ?? ""
            queue.async {
              guard self.turnGen == gen else { return }
              self.playPCM(b64, mime: mime, replace: replace)
            }
          } else if kind == "err" {
            softFail((event["m"] as? String) ?? "talk")
            return
          } else if kind == "done" {
            failures = 0
            if speech.isEmpty, let full = event["speech"] as? String {
              speech = full
              showReply(replyId, speech, to: userId, gen: gen)
            }
            // The reply is complete at "done"; the stream stays open a moment longer while the server saves it.
            queue.async {
              guard self.turnGen == gen else { return }
              self.replyEnded = true
              self.drainPlayConverter()
              self.flushPlayback()
            }
          }
          continue
        }
        buf.append(byte)
        last = byte
      }
    } catch {
      if Task.isCancelled { return }
      softFail("talk \(error.localizedDescription)")
    }
  }

  /// His words on the page, unless this answer has been dropped in the meantime (she went on, or tapped him).
  private func showReply(_ id: String, _ text: String, to userId: String, gen: Int) {
    queue.async {
      guard self.turnGen == gen else { return }
      self.emit?(["type": "reply", "id": id, "text": text, "replyTo": userId])
    }
  }

  private func schedule(_ buffer: AVAudioPCMBuffer) {
    let gen = playGen
    let seconds = buffer.format.sampleRate > 0 ? Double(buffer.frameLength) / buffer.format.sampleRate : 0
    playEndsAt = max(playEndsAt, Date()).addingTimeInterval(seconds)
    pendingBuffers += 1
    player.scheduleBuffer(buffer, completionHandler: { [weak self] in
      self?.queue.async {
        guard let self, self.playGen == gen, self.pendingBuffers > 0 else { return }
        self.pendingBuffers -= 1
        if self.pendingBuffers == 0 {
          self.playIdleAt = Date()
          if self.running && !self.busy { self.emit?(["type": "phase", "phase": "listening"]) }
          if self.replyStarted { self.kick() }
        }
      }
    })
    if engine.isRunning && !player.isPlaying { player.play() }
  }

  private func playPCM(_ b64: String, mime: String, replace: Bool) {
    guard running, let raw = Data(base64Encoded: b64), let fmt = playerFormat, fmt.sampleRate > 0 else { return }
    if replace {
      dropPlayback()
      if engine.isRunning { player.play() }
    }
    // 16-bit samples can be split across two pieces; an odd byte waits for the next piece instead of shifting
    // every sample after it.
    var data = pcmCarry
    data.append(raw)
    pcmCarry = Data()
    if data.count % 2 == 1 {
      pcmCarry = Data(data.suffix(1))
      data.removeLast()
    }
    let frames = data.count / 2
    guard frames > 0 else { return }
    let rate = mime.range(of: "rate=").flatMap { rest -> Double? in
      let tail = mime[rest.upperBound...]
      let digits = tail.prefix { $0.isNumber }
      return Double(digits)
    } ?? 24000
    guard let srcFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: false),
          let src = AVAudioPCMBuffer(pcmFormat: srcFmt, frameCapacity: AVAudioFrameCount(frames)),
          let dst = src.int16ChannelData else { return }
    src.frameLength = AVAudioFrameCount(frames)
    data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
      for i in 0..<frames {
        let lo = UInt16(buf[i * 2])
        let hi = UInt16(buf[i * 2 + 1])
        dst[0][i] = Int16(bitPattern: lo | (hi << 8))
      }
    }
    if playConverter == nil || playConverter?.inputFormat.sampleRate != rate || playConverter?.outputFormat != fmt {
      playConverter = AVAudioConverter(from: srcFmt, to: fmt)
    }
    guard let conv = playConverter, let converted = convert(src, with: conv) else { return }
    waiting.append(converted)
    waitingFrames += Double(converted.frameLength)
    flushPlayback()
  }

  /// The last few milliseconds the resampler still holds once the reply is complete.
  private func drainPlayConverter() {
    guard let conv = playConverter,
          let out = AVAudioPCMBuffer(pcmFormat: conv.outputFormat, frameCapacity: 4096) else { return }
    var error: NSError?
    conv.convert(to: out, error: &error) { _, status in
      status.pointee = .endOfStream
      return nil
    }
    playConverter = nil
    if error == nil && out.frameLength > 0 {
      waiting.append(out)
      waitingFrames += Double(out.frameLength)
    }
  }

  /// Hands buffered pieces to the player: at once while he is already speaking, otherwise once enough is waiting
  /// (or the reply is complete).
  private func flushPlayback() {
    guard !waiting.isEmpty, let fmt = playerFormat, fmt.sampleRate > 0 else { return }
    if !playing && !replyEnded {
      let need = (replyStarted ? Self.holdSec : Self.startSec) * fmt.sampleRate
      if waitingFrames < need { return }
      // His voice ran dry mid-reply and had to wait: recorded, so a stutter can be traced.
      if replyStarted { mark("underrun") }
    }
    if !replyStarted {
      replyStarted = true
      // The lines this reply answers are done; any she added after it was asked stay for the next round.
      round.removeFirst(min(askedPieces, round.count))
      askedPieces = 0
      roundReply = nil
      emit?(["type": "phase", "phase": "speaking"])
    }
    for buffer in waiting { schedule(buffer) }
    waiting.removeAll()
    waitingFrames = 0
  }

  private func convert(_ buffer: AVAudioPCMBuffer, with conv: AVAudioConverter) -> AVAudioPCMBuffer? {
    let format = conv.outputFormat
    let ratio = format.sampleRate / buffer.format.sampleRate
    let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: max(cap, 32)) else { return nil }
    var consumed = false
    var error: NSError?
    conv.convert(to: out, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    if error != nil || out.frameLength == 0 { return nil }
    return out
  }

  private func softFail(_ why: String) {
    note(ok: false, error: why)
    failures += 1
    queue.async { self.playTone() }
    if failures >= 3 { dropAfter(failures: failures) }
  }

  private func dropAfter(failures n: Int) {
    guard n >= 3 else { return }
    let content = UNMutableNotificationContent()
    content.title = "清然"
    content.body = "通话断了"
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    DispatchQueue.main.async {
      CallEngine.shared.endCallFromWeb()
      self.emitHangup()
    }
  }

  private func playTone() {
    guard running, let fmt = playerFormat, fmt.sampleRate > 0, let dst = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(fmt.sampleRate * 0.18)) else { return }
    dst.frameLength = dst.frameCapacity
    let channels = Int(fmt.channelCount)
    let n = Int(dst.frameLength)
    let rate = Float(fmt.sampleRate)
    if let floats = dst.floatChannelData {
      for c in 0..<channels {
        for i in 0..<n {
          let env = 1 - Float(i) / Float(max(n, 1))
          floats[c][i] = sin(2 * .pi * 880 * Float(i) / rate) * 0.12 * env
        }
      }
    }
    schedule(dst)
  }

  private func emitHangup() {
    emit?(["type": "ended"])
    let hangup = onHangup
    DispatchQueue.main.async {
      hangup?()
    }
  }

  /// What happened to the call (engine on, background, restarted), so a silent call can be traced afterwards.
  private func mark(_ event: String) {
    note(ok: true, error: "", detail: event)
  }

  private func note(ok: Bool, error: String, detail: String = "") {
    Task {
      guard let url = self.endpoint("api/native-log") else { return }
      var req = URLRequest(url: url)
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.setValue(await self.cookieHeader(), forHTTPHeaderField: "Cookie")
      let state = await MainActor.run { UIApplication.shared.applicationState == .background ? "bg" : "fg" }
      let body: [String: Any] = ["ok": ok, "error": String(error.prefix(500)), "note": "native-call \(state) \(detail)".trimmingCharacters(in: .whitespaces)]
      req.httpBody = try? JSONSerialization.data(withJSONObject: body)
      _ = try? await URLSession.shared.data(for: req)
    }
  }

  private func endpoint(_ path: String) -> URL? {
    guard let base = QingranConfig.savedURL,
          var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
    parts.path = path.hasPrefix("/") ? path : "/" + path
    parts.query = nil
    parts.fragment = nil
    return parts.url
  }

  private func cookieHeader() async -> String {
    await withCheckedContinuation { cont in
      DispatchQueue.main.async {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
          let header = cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
          cont.resume(returning: header)
        }
      }
    }
  }

  private func sseJSON(_ frame: Data) -> [String: Any]? {
    guard let text = String(data: frame, encoding: .utf8) else { return nil }
    let line = text.split(separator: "\n").first { $0.hasPrefix("data:") }
    guard let line else { return nil }
    let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
    guard let data = payload.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return json
  }

  private func wavData(_ samples: [Int16]) -> Data {
    let dataSize = samples.count * 2
    var data = Data()
    data.reserveCapacity(44 + dataSize)
    func append(_ text: String) { data.append(contentsOf: text.utf8) }
    func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
    append("RIFF")
    u32(UInt32(36 + dataSize))
    append("WAVE")
    append("fmt ")
    u32(16)
    u16(1)
    u16(1)
    u32(UInt32(NativeVad.sampleRate))
    u32(UInt32(NativeVad.sampleRate * 2))
    u16(2)
    u16(16)
    append("data")
    u32(UInt32(dataSize))
    samples.withUnsafeBytes { data.append(contentsOf: $0) }
    return data
  }
}

/// One of her short messages in a round; its text is what she said (empty: nothing heard).
struct Piece {
  let id: String
  let at: Int
  let text: Task<String, Never>
}
