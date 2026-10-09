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
