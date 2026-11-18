# 绫音 Work

## 手机端

安装 `app/mobile/Yingluo.apk`。在 Chat 模式打开「设置 → 模型」，编辑现有服务商，或通过「添加模型提供商」选择第三方预设并填写 API Key。预设使用服务商的默认地址。通过「自定义模型 API」也可以接入自己的接口。配置后从输入框旁选择模型。Chat 从手机直接访问模型服务，电脑可以关机。

Chat 在输入栏点「＋」添加图片，再发送给支持图片的模型，例如 DeepSeek-V4.1-Flash。点当前 DeepSeek 模型名称，再进入「推理等级」，可选 Off、Low、High、Max。

Work 模式通过局域网连接电脑。配对后可以新建 Codex 或 DeepSeek Harness 会话，查看运行进度、续聊和取消。点「＋」添加文件，按「发送」后原件会保存到当前电脑项目的 `.yingluo-uploads` 目录，助手会收到文件路径。每条消息最多 8 个文件，合计 12 MB。输入栏可为当前会话选择所用助手的推理等级。

## 电脑端

准备 Node.js 24 和已配置模型的 Codex、DeepSeek Harness。应用会从 PATH、Windows 安装记录和同级的 `app` 源码副本查找命令。也可以用 `YINGLUO_CODEX_COMMAND` 或 `YINGLUO_DSH_COMMAND` 指定命令名或可执行文件。

在任意项目目录打开 PowerShell，通过 `backend/Start-Work.cmd` 启动。也可以在当前仓库运行下面的命令，把项目目录换成自己的目录。

```powershell
node backend/server.mjs --lan --project "你的项目目录"
```

手机和电脑连同一局域网。在电脑打开终端打印的「电脑控制页」（默认 `http://127.0.0.1:3197/control`），点「手机配对」。在手机 Work 的「电脑连接」里点「扫码连接」，扫完确认。也可以手动输入局域网地址和配对码。配对码使用一次或 15 分钟后失效。电脑控制页同时支持发消息、查看结果、停止和删除 Work 会话。

在手机 Work 模式点头像，侧栏的「电脑端近期会话」显示当前项目下的 Codex 和 DeepSeek Harness 本地记录。选中可续聊的会话后发消息即可沿用电脑端上下文，之前的消息正文留在电脑端。使用 Harness Agent 预设的会话会标为「在 Harness 继续」。

`--project` 决定 agent 的工作目录。省略时使用启动目录。使用 `--host <本机局域网地址>` 可以只监听一个网卡，`--port` 可以改端口。各项目的会话和配对分开存储。更换电脑后在新电脑启动服务并重新配对。

Codex 使用电脑端已有登录和模型配置。DeepSeek Harness 使用自己的 API 配置，也可通过 `DEEPSEEK_API_KEY` 提供密钥。Windows 上要沿用定制版 Harness 的模型配置，可以在启动 Work 前把 `DSH_HOME` 设为 `Join-Path $env:LOCALAPPDATA 'YingluoHarness'`。

## 让绫音自动派单

在电脑端设置 `YINGLUO_AI_BASE_URL`、`YINGLUO_AI_MODEL` 和对应的 `YINGLUO_AI_API_KEY`，再启动服务。Work 的新建会话中会出现「绫音」。模型支持工具调用时，绫音可以把你交给她的项目任务转交给一个 agent，并给出继续原会话的入口。

## 浏览器与重新打包

Chat 输入框的「🌐」开启后变蓝，并记住开关状态。当前适配 DeepSeek 官方配置的 Flash 和 V4 Pro：Flash 使用 `deepseek_web_search`，Pro 使用 `web_search_20250305`，沿用模型 API Key，无需连接电脑。是否实际执行搜索由模型决定；未适配的模型会禁用此开关。搜索进度实时显示，返回的参考资料位于回复末尾，带网站图标；点击资料展开完整网址，再点击网址用浏览器打开。图标加载失败时显示网站首字母。来源区区分模型引用与其他搜索结果，搜索失败会明确提示。协议依据 [DeepSeek Web Tools](https://api-docs.deepseek.com/guides/web_tools/) 和 [Messages 兼容文档](https://api-docs.deepseek.com/guides/anthropic_api/)。

同一局域网的浏览器也可以打开电脑端地址，使用同一套 Work 界面。浏览器中的 Chat 取决于模型服务是否允许跨域请求。Android APK 直接使用应用内网络请求。

从源码安装浏览器版时，先在 `app` 中安装工作区依赖，再从工作区根目录执行 `node app/mobile/picker/build.mjs` 生成模型选择器资源。Android 打包器会在打包时自动完成此步骤。

APK 的本地构建步骤见 [Android 打包说明](../app/mobile/android/README.md)。
