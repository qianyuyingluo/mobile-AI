# 绫音 Android

用 Node.js 24.9 或更高版本、JDK 17 或更高版本，以及带 Android SDK Platform 36 或更高版本和 Build Tools 的 Android SDK 打包。构建器读取 `JAVA_HOME`、`ANDROID_HOME` 或工具的常用安装位置。

在 `app` 中安装工作区依赖，再从工作区根目录执行：

```sh
node app/mobile/android/build.mjs
```

产物是 `app/mobile/Yingluo.apk`，支持 Android 8.0 或更高版本。构建会使用电脑上的调试签名。跨电脑重建想覆盖安装时，需要沿用同一签名密钥。

无猫娘的独立版本使用 `node app/mobile/android/build.mjs --variant mobile-ai`，产物为 `app/mobile/mobile-AI.apk`。它使用独立包名 `app.mobileai.mobile` 和链接协议 `mobile-ai://pair`，可与绫音共存，数据及凭据由 Android 应用沙箱隔离。App 内扫码仍可读取现有电脑控制页生成的配对二维码。该版本不打包角色图片和动画，OPPO 通知改用普通状态图标。构建只在临时目录应用品牌差异，不覆盖绫音 APK。

应用从 APK 加载界面、Harness 模型管理页和动画。Chat 在「设置 → 模型」管理服务商及 API Key，再从输入框旁选择模型。Work 需要在手机上输入电脑服务地址和一次性配对码。若手机相机能打开绫音配对链接，也可以通过该链接填写这两项内容。API Key 和配对令牌保存在 Android Keystore 加密的本地存储中。

## OPPO 实况通知

版本 0.8.0 对 OPPO Android 16+ 的 Chat 流式回复启用前台服务。`ReplyProgress` 从实际 SSE 事件提取阶段、字数和结束证据，不保存推理内容；没有完整结束标记、正文为空、报错或取消时不会显示成功。回桌面时请求原生 Live Update 提升；结束后使用 waving 帧与「回复完成」，保留 15 秒，返回应用时收起。

先在侧栏「OPPO 实况通知」中进入系统设置，打开「流体云显示实时活动」，并在应用详情的耗电管理中选择「完全允许后台行为」。前台服务和标准电池豁免不能代替 ColorOS 的耗电管理选项。不使用悬浮窗或 OPPO 商业推送服务。

原生动画帧从项目 `yingluo-animation-v2/frames-hd/{running,waving}` 打包为 `AnimationDrawable`。当前 ColorOS 17 实测只渲染静态帧；每 300ms 更换小图标虽能运动，但会不断重置右侧文字过渡，所以没有保留这条路径。连续动画尚未验收通过。回复服务最长保留 5 分钟，完成或失败后自动清理。系统强杀后不会自动重发模型请求。Work agent 的后台通知不在本版范围。

连接测试手机后，可以运行 `node app/mobile/android/reply-device-smoke.mjs`。脚本临时覆盖安装本地 SSE 测试界面，在桌面检查阶段及完成通知并保存截图，最后恢复已有正式 APK；不清除数据、不调用真实模型。通知及后台权限需预先开启。协议解析的真机测试入口为 `tests/ReplyProgressTest.java`。

接口依据：[Android Live Updates](https://developer.android.com/develop/ui/views/notifications/live-update)。最终胶囊布局由 ColorOS 控制。
