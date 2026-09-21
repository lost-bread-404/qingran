import SwiftUI

struct RootView: View {
  @State private var urlString = QingranConfig.savedURLString
  @State private var ready = QingranConfig.savedURL != nil

  var body: some View {
    Group {
      if ready, let url = QingranConfig.savedURL {
        WebContainer(url: url) {
          ready = false
        }
        .ignoresSafeArea()
      } else {
        SetupView(urlString: $urlString) {
          QingranConfig.savedURLString = urlString
          ready = QingranConfig.savedURL != nil
        }
      }
    }
    .background(Color.black.ignoresSafeArea())
  }
}
