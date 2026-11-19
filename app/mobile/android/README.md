# mobile-AI Android

`main` 默认构建无角色形象的 mobile-AI。猫娘版位于 [codex/ayane](https://github.com/qianyuyingluo/yingluo-neko/tree/codex/ayane)，两款应用使用不同包名，可同时安装，数据与凭据相互独立。

使用 Node.js 24.9+、JDK 17+、Android SDK Platform 36+ 和 Android Build Tools。在 `app/` 安装前端依赖后，从仓库根目录执行：

```sh
node app/mobile/android/build.mjs
```

可显式指定 `--variant mobile-ai`。产物是 `app/mobile/mobile-AI.apk`，包名 `app.mobileai.mobile`，支持 Android 8.0+。构建器读取 `JAVA_HOME`、`ANDROID_HOME` 或工具常用安装位置，使用本机调试签名；跨电脑覆盖安装需沿用相同签名密钥。

Chat 在「齿轮 → 设置 → 模型」填写 API Key，手机直接调用模型。Work 通过 App 内扫码或手动输入电脑服务地址与配对码连接，兼容现有电脑控制页二维码；系统配对链接协议是 `mobile-ai://pair`。API Key 和配对令牌使用 Android Keystore 加密保存。

APK 不打包角色头像和背景动画，OPPO 回复通知使用普通状态图标。原生回复实况仅对 OPPO Android 16+ 启用：在侧栏「OPPO 实况通知」开启通知、流体云实时活动，并在耗电管理允许后台运行。完成时显示「回复完成」并保留 15 秒，回到应用后收起；取消、失败或缺失完成证据不会显示成功。服务最长保留 5 分钟，不自动重发被系统中断的请求。Work 的后台通知未接入。

`node app/mobile/android/reply-device-smoke.mjs` 使用本地模拟 SSE 测试通知，临时安装测试界面，最后恢复当前 mobile-AI APK；不读取真实模型密钥，不清除应用数据。通知权限需预先开启。基础流式解析测试位于 `tests/ReplyProgressTest.java`。

验证打包 UI 时，将 APK 的 `assets/web/` 解压至临时目录，然后运行：

```sh
node app/mobile/variant-smoke.mjs <解压后的目录>
```

测试覆盖纯净品牌、齿轮入口、设置、Chat 记忆提示、流式 Markdown 和 Work 配对入口，打印浅色与深色截图位置。它使用模拟模型，不代表真实供应商 API 或所有设备均已验证。
