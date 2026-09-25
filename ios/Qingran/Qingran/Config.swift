import Foundation

enum QingranConfig {
  static let urlKey = "qingran.webURL"
  static let displayName = "清然"

  static var savedURLString: String {
    get { UserDefaults.standard.string(forKey: urlKey)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
    set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: urlKey) }
  }

  static var savedURL: URL? {
    let raw = savedURLString
    guard !raw.isEmpty else { return nil }
    let withScheme = raw.contains("://") ? raw : "https://\(raw)"
    return URL(string: withScheme)
  }

  static func looksLikeURL(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count > 8 else { return false }
    let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
    guard let url = URL(string: withScheme), let host = url.host, host.contains(".") else { return false }
    return url.scheme == "https" || url.scheme == "http"
  }
}

/// Matches the web call defaults in src/lib/lover/vad.ts.
enum NativeVad {
  static let sampleRate = 16_000
  static let startFloorMin: Float = 0.004
  static let startFloorMult: Float = 1.35
  static let noiseFloorCap: Float = 0.02
  static let silenceMs = 1_500
  static let maxUtteranceMs = 30_000
  static let minSpeechMs = 220
  static let spikeMs = 80
}
