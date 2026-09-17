import SwiftUI

struct SetupView: View {
  @Binding var urlString: String
  var onOpen: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Spacer(minLength: 24)
      Text("清然")
        .font(.system(size: 34, weight: .semibold))
        .foregroundStyle(Color(red: 0.95, green: 0.93, blue: 0.89))
      Text("这是给你自己用的通话壳。打开后，系统会把清然当成一个会打电话的 App：麦克风权限在「设置 → 清然」，切到别的软件也可以继续说。")
        .font(.system(size: 16))
        .foregroundStyle(Color(red: 0.82, green: 0.78, blue: 0.72))
        .fixedSize(horizontal: false, vertical: true)
      Text("把你正在用的清然网页地址贴进来（一般是 xxx.grok.me）。记忆和对话都在那个网址上，换错了会是空的。")
        .font(.system(size: 15))
        .foregroundStyle(Color(red: 0.62, green: 0.58, blue: 0.54))
        .fixedSize(horizontal: false, vertical: true)
      TextField("https://你的清然.grok.me", text: $urlString)
        .keyboardType(.URL)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(14)
        .background(Color(white: 0.12))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .foregroundStyle(.white)
      Button(action: onOpen) {
        Text("打开清然")
          .font(.system(size: 17, weight: .semibold))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 14)
          .background(QingranConfig.looksLikeURL(urlString) ? Color(red: 0.69, green: 0.44, blue: 0.44) : Color(white: 0.22))
          .foregroundStyle(.white)
          .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      }
      .disabled(!QingranConfig.looksLikeURL(urlString))
      Spacer()
    }
    .padding(28)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(red: 0.05, green: 0.04, blue: 0.04))
  }
}
