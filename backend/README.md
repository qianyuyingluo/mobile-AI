# mobile-AI Work

## 手机端

安装 `app/mobile/Yingluo.apk`。在 Chat 模式打开「设置 → 模型」，编辑现有服务商，或通过「添加模型提供商」选择第三方预设并填写 API Key。预设使用服务商的默认地址。通过「自定义模型 API」也可以接入自己的接口。配置后从输入框旁选择模型。Chat 从手机直接访问模型服务，电脑可以关机。

Chat 在输入栏点「＋」添加图片，再发送给支持图片的模型，例如 DeepSeek-V4.1-Flash。点当前 DeepSeek 模型名称，再进入「推理等级」，可选 Off、Low、High、Max。

Work 模式通过局域网连接电脑。配对后可以新建 Codex 或 DeepSeek Harness 会话，查看运行进度、续聊和取消。点「＋」添加文件，按「发送」后原件会保存到当前电脑项目的 `.yingluo-uploads` 目录，助手会收到文件路径。每条消息最多 8 个文件，合计 12 MB。输入栏可为当前会话选择所用助手的推理等级。

## 电脑端

`backend/Start-Work.cmd` 也默认开启桌面对话同步，与根目录 `Start-Desktop.cmd` 使用相同模式。需要单项目独立会话时再使用下方的 `--lan --project` 命令；这种模式的近期会话入口只接续上下文，不显示电脑完整历史。

Windows 双击仓库根目录的 `Start-Desktop.cmd`，到自动打开的控制页配对。手机进入 Work 后点左上角头像，侧栏直接显示 Codex 项目与 Harness 工作区。选择会话即可查看电脑原会话的用户/助手文字；顶部加载更早消息，轮询和重新连接都会更新已显示的历史范围。

这里读取已安装软件的数据：Codex 的 `.codex` 数据库、DeepSeek Harness 的 `.dsh/storages/workspace.json` 和 `.dsh/sessions`，不扫描本仓库的 Harness 源码。可通过 `CODEX_HOME`、`DSH_HOME` 指定实际数据目录。

发送到原会话要求桌面软件运行。Codex 使用桌面 IPC 的会话所有者接口；Harness 使用 `backend/harness-desktop-plugin.mjs`，启动器将插件加入 `.dsh/profiles/desktop/cordis.patch.yml`，并先在 `%LOCALAPPDATA%/YingluoWork` 备份原配置。首次配置后可能需要重启 Harness。同步插件只监听回环地址，使用随机令牌；手机仍通过已配对的 Work 服务访问。

原会话发送采用持久化发送编号，避免网络重试造成重复消息；附件也计入内容校验。未知结果不会自动重发，需要先核对原会话。文件上传到原会话项目目录，图片同时传给模型。Harness 图片输入要求同步插件 protocol 2，升级插件后需重开桌面软件；旧插件会明确提示更新。图片记录和 Harness 生成文件可点开预览，限制为工作区/附件目录内的 5 MB 以下文件。工具卡片和审批尚未接入。以下单项目 Work 通道保留任务控制功能。

准备 Node.js 24 和已配置模型的 Codex、DeepSeek Harness。Work 在 Windows 上通过安装记录定位 DeepSeek Harness 随附的 dsh.cmd，找不到时查找 PATH 中的 dsh。Codex 从 PATH 和 Windows 安装记录查找。也可以用 `YINGLUO_CODEX_COMMAND` 或 `YINGLUO_DSH_COMMAND` 指定命令名或可执行文件。

在任意项目目录打开 PowerShell，通过 `backend/Start-Work.cmd` 启动。也可以在当前仓库运行下面的命令，把项目目录换成自己的目录。

```powershell
node backend/server.mjs --lan --project "你的项目目录"
```

手机和电脑连同一局域网。在电脑打开终端打印的「电脑控制页」（默认 `http://127.0.0.1:3197/control`），点「手机配对」。在手机 Work 的「电脑连接」里点「扫码连接」，扫完确认。也可以手动输入局域网地址和配对码。配对码使用一次或 15 分钟后失效。电脑控制页同时支持发消息、查看结果、停止和删除 Work 会话。

在手机 Work 模式点头像，侧栏的「电脑端近期会话」显示当前项目下的 Codex 和 DeepSeek Harness 本地记录。选中可续聊的会话后发消息即可沿用电脑端上下文，完整的文字记录可在桌面同步模式下通过「项目与工作区」打开。使用 Harness Agent 预设的会话会标为「在 Harness 继续」。

`--project` 决定 agent 的工作目录。省略时使用启动目录。使用 `--host <本机局域网地址>` 可以只监听一个网卡，`--port` 可以改端口。各项目的会话和配对分开存储。更换电脑后在新电脑启动服务并重新配对。

Codex 使用电脑端已有登录和模型配置。DeepSeek Harness 使用自己的 API 配置，也可通过 `DEEPSEEK_API_KEY` 提供密钥。工作区同步使用安装版 Harness 的用户数据目录，默认是用户目录下的 `.dsh`。仅当桌面软件也在使用自定义目录时，才设置相同的 `DSH_HOME`。

## 让 AI 自动派单

在电脑端设置 `YINGLUO_AI_BASE_URL`、`YINGLUO_AI_MODEL` 和对应的 `YINGLUO_AI_API_KEY`，再启动服务。Work 的新建会话中会出现「AI」。模型支持工具调用时，AI 可以把你交给它的项目任务转交给一个 agent，并给出继续原会话的入口。

## 浏览器与重新打包

Chat 输入框的「🌐」开启后变蓝，并记住开关状态。当前适配 DeepSeek 官方配置的 Flash 和 V4 Pro：Flash 使用 `deepseek_web_search`，Pro 使用 `web_search_20250305`，沿用模型 API Key，无需连接电脑。是否实际执行搜索由模型决定；未适配的模型会禁用此开关。搜索进度实时显示，返回的参考资料位于回复末尾，带网站图标；点击资料展开完整网址，再点击网址用浏览器打开。图标加载失败时显示网站首字母。来源区区分模型引用与其他搜索结果，搜索失败会明确提示。协议依据 [DeepSeek Web Tools](https://api-docs.deepseek.com/guides/web_tools/) 和 [Messages 兼容文档](https://api-docs.deepseek.com/guides/anthropic_api/)。

同一局域网的浏览器也可以打开电脑端地址，使用同一套 Work 界面。浏览器中的 Chat 取决于模型服务是否允许跨域请求。Android APK 直接使用应用内网络请求。

从源码安装浏览器版时，先在 `app` 中安装工作区依赖，再从工作区根目录执行 `node app/mobile/picker/build.mjs` 生成模型选择器资源。Android 打包器会在打包时自动完成此步骤。

APK 的本地构建步骤见 [Android 打包说明](../app/mobile/android/README.md)。
