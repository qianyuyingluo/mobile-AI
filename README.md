# 绫音

这是保留猫娘形象的 `codex/ayane` 分支。日常功能开发以 [mobile-AI 主分支](https://github.com/qianyuyingluo/yingluo-neko/tree/main) 为主；本分支保留角色头像、背景动画和独立 Android 包名，可与 mobile-AI 同时安装。

一个带猫娘形象与背景动画的 AI 聊天和项目控制应用。手机可以直接与模型聊天，也可以通过局域网连接电脑，操作 Codex、DeepSeek Harness，或让绫音把项目任务交给 agent。

界面复用 DeepSeek Harness 的模型选择器、模型设置与 Markdown 渲染组件。模型通过 API Key 配置，不要求登录 DeepSeek 账号。

`app/` 是随主仓库一起提交的定制源码目录，直接克隆本仓库即可获得，不需要初始化 Git 子模块。本地参考副本 `deepseek-harness/` 不上传；依赖、密钥和本地 Git 历史备份也不纳入版本控制。

## 快速开始

**Android 安装包：[`app/mobile/Yingluo.apk`](app/mobile/Yingluo.apk)**，当前本地构建版本为 **0.8.14**，支持 Android 8.0 及以上。OPPO 流体云功能需要 Android 16 及以上。源码副本中如果没有 APK，可以按下文步骤构建。

**无角色版本：[`app/mobile/mobile-AI.apk`](app/mobile/mobile-AI.apk)**，应用名 **mobile-AI**，版本 **1.0.0**。去掉猫娘头像、背景动画和角色名称，左上角改用齿轮进入会话与设置，保留 Chat、Work、模型配置和手机 Chat 文本记忆。包名为 `app.mobileai.mobile`，可与绫音（`app.yingluo.mobile`）同时安装；两款应用的聊天记录、记忆、API Key 和配对状态各自独立，需要单独配置。OPPO 回复通知使用普通状态图标。

在配置好下文的 Android 构建环境后，运行 `node app/mobile/android/build.mjs --variant mobile-ai` 生成独立 APK。默认构建命令仍生成绫音版本。

| 模式 | 用途 | 是否需要电脑运行 |
| --- | --- | --- |
| Chat | 文字、图片聊天与联网搜索 | 不需要，手机直接请求模型 API |
| Work | 给电脑上的 agent 发任务、续聊、传文件 | 需要运行电脑端 Work 服务 |

### 在手机上聊天

1. 安装 APK，点击左上角头像展开侧栏，在底部进入「设置 → 模型」。
2. 编辑已有提供商，或添加模型提供商并填写 API Key。内置预设使用默认地址；自建服务可使用「自定义模型 API」。
3. 在输入框旁选择模型，然后发送消息。

手机 Chat 在打包时从项目锁定的 DeepSeek Harness 生成离线模型目录。每个模型继承原版的图片输入能力、推理档位及默认设置。在「添加模型提供商」中选 `kimi-coding`，填入 API Key 后即可在输入框选择 Kimi K3，使用低、高或最高档。需要专用协议或云端身份配置的目录项会标明暂不支持手机直连。

推理强度使用分档滑动条：Chat 点击模型入口即可调整，Work 点击推理等级打开。粉色轨道和上方文字随拖动更新，只显示当前模型或 agent 支持的档位；右上角回转箭头恢复默认。Chat 选择会保存在本机，Work 选择随下一条任务发送给电脑。

新建对话时，顶部可以选择 Chat / Work；发送第一条消息后隐藏模式选择。右上角圆形「＋」用于新建对话，输入框左侧「＋」用于添加附件。左右顶部入口的底框以 20% 不透明度显示，文字、头像和图标保持清晰；点击输入框开始编辑时，才展开附件、联网、模型和发送工具栏，发送后收起。

用户气泡采用更轻的描边与紧凑间距，省去重复的“你”标签（屏幕阅读器仍可识别）。对话顶部通过渐变模糊淡出滚过悬浮按钮的文字。收起的输入栏使用斜向展开图标，蓝色小圆点表示就绪；执行进度、错误与停止按钮仍显示完整内容。点击展开图标可编辑长消息，点击向下图标收起并保留草稿和光标位置。

历史侧栏从左侧滑入，关闭沿原路滑回。设置从底部展开，占可用屏幕约 90%；从侧栏进入设置后，关闭会回到原侧栏位置。下拉顶部把手可关闭设置，短距离拖动会回到展开位置，内容区域保持正常滚动。开关过程可中断，遮罩随位置连续变化；开启系统“减少动态效果”时改用淡入淡出。Android 返回键按当前面板层级关闭。

Chat 文本记忆默认开启，在「Chat → 头像 → 设置 → Chat 记忆」管理。所有本机 Chat 共用固定记忆（手动编辑，最多 1000 字）和自动记忆（最多 3000 字、100 条），每次请求附带全文，不使用 RAG，也不接入 Work 或同步电脑 Agent 的记忆。模型仅在有必要时于回复末尾输出隐藏的 `<memory_update>` 更新段；没有更新段就不写入记忆，不额外调用一次模型。App 在流式显示前过滤控制段，只在回复正常完成、格式与编号有效且设置未改变时保存。取消、断流、长度截断或存储失败不会提交更新。已保存的更新显示「已记住」，可查看来源、编辑、撤销最近一次自动记忆修改或清空；关闭记忆后仍保留本地内容，但不注入请求或接受自动更新。删除聊天不会自动删除共享记忆，需要在记忆页另行整理。记忆保存在当前设备，开启时会随 Chat 请求发送给所选模型；跨对话延续不代表跨设备同步。

### 连接电脑处理项目

推荐双击根目录 `Start-All.cmd`：准备 Harness 同步插件，启动绫音桌面同步服务、电脑控制页，以及已安装的 Codex 和 DeepSeek Harness。重复运行会复用服务和已打开的软件。双击 `Stop-All.cmd` 停止绫音服务并释放默认端口 3197，桌面软件保持打开。启动日志保存在 `%LOCALAPPDATA%\YingluoWork\launcher`。自定义端口使用 `Start-All.cmd -Port 3198`，关闭时使用同样的 `Stop-All.cmd -Port 3198`；非标准安装位置可设置 `AYANE_CODEX_EXE`、`AYANE_HARNESS_EXE`。启动器通过 CMD 调用 PowerShell，无需永久修改系统脚本执行策略。

Windows 双击根目录的 [Start-Desktop.cmd](Start-Desktop.cmd)，启动器会打开电脑控制页。点击「手机配对」生成二维码。已配对手机进入 Work，点击左上角头像，在侧栏直接展开 Codex 项目或 DeepSeek Harness 工作区，再选择原有会话。历史消息按页读取，顶部可加载更早的消息；连接恢复后重新读取电脑记录。

同步源是**电脑已安装的软件**：Codex 使用 `%USERPROFILE%\.codex` 的项目与历史数据库，Harness 使用 `%USERPROFILE%\.dsh` 的工作区与会话记录。支持 `CODEX_HOME`、`DSH_HOME` 指定实际数据目录。`deepseek-harness/` 源码副本不参与同步。

手机发送文字时，Codex 通过桌面会话 IPC 接口写入原会话，Harness 通过已安装桌面的同步插件写入原会话。两款桌面软件需要保持运行；如果 Codex 提示找不到会话处理端，先在桌面打开该会话。此接口随桌面版本变化，当前在 Codex 26.1111.2228 上验证。

启动器会为 Harness 的 desktop profile 加入 `ayane-desktop-sync` 插件，并将原配置备份到 `%LOCALAPPDATA%\YingluoWork\desktop-patch-*.backup`。插件按内容版本复制到该目录，升级时更新自己的插件路径。插件只监听电脑回环地址，并使用随机令牌；局域网请求仍需绫音配对。首次配置或插件升级后，请重新打开 Harness。

桌面原会话同步支持用户/助手文字与 Markdown，并以轮询更新已保存的消息。附件上传到原会话的项目目录；图片作为模型图片输入发送，Harness 需运行新版同步插件。已记录的图片附件与 Harness 生成文件显示为文件卡片，可点开图片和文本预览（单文件最多 5 MB，文本预览前 1 MB）。文件必须仍存在于会话工作区或软件附件目录中。工具卡片和审批操作尚未接入这条同步通道。

电脑准备 **Node.js 24.9 或更高版本**，并至少配置好 Codex 或 DeepSeek Harness 中的一种。下列命令均在本项目根目录运行；把项目路径换成希望 agent 操作的目录。

```powershell
node backend/server.mjs --lan --project "C:\Projects\my-project"
```

也可以运行：

```powershell
.\backend\Start-Work.cmd --project "C:\Projects\my-project"
```

1. 手机与电脑连接同一局域网。
2. 在电脑浏览器打开终端输出的控制页，默认是 `http://127.0.0.1:3197/control`。
3. 点击「手机配对」，在手机 Work 的电脑连接设置中扫码；也可以手动输入电脑的局域网地址和配对码。
4. 在手机选择助手，发送任务。电脑控制页也可以发送消息、查看进度、停止任务和删除会话。

配对码只能使用一次，有效期为 15 分钟。手机手动连接时填写终端输出的 `http://电脑局域网IP:3197`，不要填写 `127.0.0.1`。

服务运行期间保持终端打开；停止服务时在该终端按 **Ctrl+C**。可以用 `--port` 更换端口，或用 `--host` 指定本机网卡地址；`--host` 与 `--lan` 二选一。

更多配对、助手发现与项目配置说明见 [Work 使用说明](backend/README.md)。

## 功能

### 聊天与阅读

- Chat 流式输出，支持停止生成并保留已收到的回复。
- Chat 回复下方的循环箭头可重新生成，使用当前模型、推理等级与联网开关，保留原问题和图片；重试失败或取消保留原回复。重试较早的回答会新建带「重试」后缀的聊天，原聊天及后续消息保留。输入框中的草稿和待发附件不受重试影响。已从本机缓存移除的图片需要重新添加。
- 模型接口返回的思考内容或思考摘要显示在正文上方，默认折叠，可展开查看流式内容，随 Chat 历史保存。未返回思考内容时不显示空面板，签名或加密思考数据不会作为文本展示。此处的重试用于手机 Chat，不重新执行电脑 Work 任务。
- 渲染 Markdown 标题、表格、代码块与数学公式。
- 本地保存聊天记录，在头像侧栏中切换、删除会话。
- 输入框自动增高、内部滚动，支持展开为大编辑区；收起后保留内容与光标。
- Enter 换行，点击发送或按 Ctrl/Cmd+Enter 发送。
- 回复中触屏即暂停自动滚动，松手后保持阅读位置；点击「↓」回到最新消息并恢复跟随。发送新消息、切换会话时重新跟随。
- 左侧靠上的独立右箭头可点击或向右拉开对话进度，小箭头贴近左边缘、位于正文留白内且没有背景底框，建议点击展开，占对话区域宽度的 40%；上下滑动转动弧形目录，显示问题序号和提问开头。点击条目跳到对应提问并收起，持续回复不会抢走阅读位置。支持 Chat / Work、深色模式、减少动态效果及手机返回键。
- 图片缩略图可点击进入全屏查看，支持缩放与切换。
- 保留 Harness 配色，提供猫娘头像、背景动画及浅色／深色主题。

### OPPO 回复实况

Chat 回复中返回桌面后，通过原生实况通知显示绫音与当前阶段；完整回复结束后切换 `waving` 素材，右侧显示「回复完成」，15 秒后收起，点击通知可返回对应对话。显示等待、思考、搜索、回复阶段、用时与已回复字数，不估算完成百分比；停止和失败不会显示回复完成。

**动画限制：**当前 ColorOS 17 实测只显示动画的静态帧。逐帧更新通知虽能使角色动起来，但会让右侧文字反复消失，正式包保留文字稳定的版本。连续跑步／waving 动画尚未完成，不能把静态姿势视作动画验收通过。

在侧栏「OPPO 实况通知」中打开系统设置：

1. 通知管理中开启「允许通知」和「流体云显示实时活动」。
2. 应用详情 → 耗电管理 → 选择「完全允许后台行为」。仅开启 Android 电池优化豁免仍可能被 ColorOS 冻结。

仅针对 OPPO Android 16+ 启用；本次真机为 OPPO Find X7 / ColorOS 17。普通浏览器、其他品牌及 Work 的电脑 agent 暂不接入此功能。使用前台网络服务，无悬浮窗、无通知读取权限。强行停止应用、系统杀进程或断网仍会中断当前请求。

### 联网搜索

输入框「＋」旁边的地球按钮用于开关联网搜索：**黑色线条为关闭，蓝色线条为开启**，切换时显示 0.8 秒提示。

手机 Chat 根据当前模型和实际 API 地址选择搜索接口。DeepSeek 官方、百炼千问及智谱通用 GLM 使用模型端联网工具。OpenAI Responses 及兼容服务通过 `web_search` 调用搜索，参考资料同时读取模型引用和搜索工具返回的网址。Kimi 开放平台、Kimi Coding 和 GLM Coding Plan 使用各自的搜索服务，以当前问题检索，再把网页摘要交给模型。搜索使用当前提供商的密钥，费用和额度由套餐决定。地球按钮在已适配的接口上可用。

自定义 OpenAI Chat Completions 和 Responses 接口默认允许发送图片，目录或手工设置中明确为纯文本的模型按其设置处理。

回复末尾用最多三个堆叠网站图标和来源数量展示参考资料。点击后从底部弹出资料面板，可查看标题、引用标记与完整网址；点击网址打开浏览器。面板支持「收起」、点击遮罩和手机返回键关闭。网站图标不可用时显示首字母。

### Work 与电脑会话

- 通过局域网配对电脑，直接与 Codex 或 DeepSeek Harness 对话。
- 查看当前项目下电脑端 agent 的近期会话，续聊支持恢复的会话。
- 查看运行状态、任务事件和结果，取消正在执行的任务。
- 支持上传文件：每条消息最多 8 个，总计 12 MB；原件保存到目标项目的 `.yingluo-uploads` 目录，agent 收到对应文件路径。
- 按模型或助手能力提供推理等级选项。
- 可配置一个 OpenAI 兼容模型作为绫音项目助手，由它回复普通问题或派发项目任务。

### 让绫音派发任务（可选）

在启动 Work 服务的同一个 PowerShell 窗口设置：

```powershell
$env:YINGLUO_AI_BASE_URL = "https://你的模型服务地址/v1"
$env:YINGLUO_AI_MODEL = "你的模型ID"
$env:YINGLUO_AI_API_KEY = "你的API密钥"
node backend/server.mjs --lan --project "C:\Projects\my-project"
```

配置后，Work 助手列表会出现「绫音」。派单要求模型支持工具调用，并且电脑已检测到可用的 Codex 或 DeepSeek Harness。它使用电脑端环境配置，与手机 Chat 的模型设置分别管理；真实密钥不要写入仓库文件。

显示名称已改为「绫音」。为保留已有配置和覆盖安装兼容性，项目目录、APK 文件名、Android 包名与内部存储键继续使用 `yingluo` / `Yingluo`。

## 项目目录

```text
yingluo-neko/
├── app/                     定制版 DeepSeek Harness 与手机应用
│   ├── mobile/
│   │   ├── ui/              手机和电脑控制页共用界面
│   │   ├── picker/          Harness 模型选择器、设置与渲染组件构建
│   │   ├── android/         Android 原生壳、网络桥接与打包脚本
│   │   └── Yingluo.apk      本地生成的 Android 安装包
│   └── Start-Yingluo.ps1    定制版 Harness 启动入口
├── backend/                 局域网 Work 服务、配对、会话与 agent 调用
├── image/                   图片素材
├── yingluo-animation-v2/     猫娘动画素材
└── deepseek-harness/         原版参考源码，根目录 .gitignore 已忽略
```

实际开发使用 `app/`；原版参考目录与定制版分开保存。根目录没有 `package.json`，前端依赖安装在 `app/` 中。

## 从源码运行与构建

### 安装前端依赖

使用 Node.js 24.9+，pnpm 版本以 [`app/package.json`](app/package.json) 的 `packageManager` 字段为准。

```powershell
Push-Location app
pnpm install
Pop-Location
```

### 浏览器界面

```powershell
node app/mobile/picker/build.mjs
node backend/server.mjs --lan --project "C:\Projects\my-project"
```

浏览器打开服务地址即可使用手机共用界面，电脑控制页位于 `/control`。浏览器 Chat 还取决于提供商是否允许跨域请求；Android 使用原生网络桥接，不受浏览器 CORS 限制。

### 定制版 Harness

需要定制版完整 Harness 界面时，可使用独立入口：

```powershell
Push-Location app
pnpm run build
Pop-Location
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\app\Start-Yingluo.ps1
```

此脚本启动完整 Harness 界面，不是局域网 Work 服务。脚本使用 `%LOCALAPPDATA%\YingluoHarness` 保存独立配置。`ExecutionPolicy Bypass` 只作用于这次启动的 PowerShell 进程，用于避免系统默认执行策略拦截 `.ps1`。

### 构建 Android APK

除前端依赖外，还需要 JDK 17+、Android SDK Platform 36+ 和 Android Build Tools。设置 `JAVA_HOME` 与 `ANDROID_HOME`，然后运行：

```powershell
node app/mobile/android/build.mjs
```

输出到 [`app/mobile/Yingluo.apk`](app/mobile/Yingluo.apk)。打包会自动构建手机组件资源并包含界面和动画；默认使用本机调试签名，跨电脑重建后覆盖安装需要沿用同一签名密钥。详细说明见 [Android 打包说明](app/mobile/android/README.md)。

### 本地验证

```powershell
node --test backend/agents.test.mjs backend/server.test.mjs backend/desktop-sync.test.mjs
node --test app/mobile/chat-providers.test.mjs app/mobile/streaming.test.mjs app/mobile/native-streaming.test.mjs app/mobile/web-search.test.mjs
node --test app/mobile/chat-memory.test.mjs
node app/mobile/chat-memory-smoke.mjs
node app/mobile/reply-smoke.mjs
node app/mobile/ui-smoke.mjs
node app/mobile/reading-navigation-smoke.mjs
```

界面冒烟测试需要前端依赖、已构建的组件资源和本机 Microsoft Edge。测试使用临时目录与模拟模型，覆盖手机竖屏、窄屏和横屏、输入框、流式回复、联网开关与参考资料面板；阅读导航测试额外验证触屏暂停、恢复跟随、目录拖动、问题跳转和 Chat / Work 切换。成功后打印截图目录。模拟测试通过不代表真实模型 API 或所有手机型号都已经验证。

模型只返回记忆更新段时，App 在保存成功后显示「已更新记忆」；更新段位于正常回答之前时也能正确过滤并保留后续正文。无效、重复或不完整的记忆段不写入，并显示具体的记忆处理提示。

## 数据与当前范围

- Android API Key 和配对令牌使用 Android Keystore 加密保存；浏览器 Chat 密钥使用当前浏览器会话存储。
- Chat 历史保存在设备本地；Work 会话由电脑服务按项目保存。未提供跨设备 Chat 历史同步。
- 应用会保留部分设置，例如模型选择与联网开关；自动提取用户偏好、跨会话检索的长期记忆系统尚未完成。
- Chat 已实现增量流式显示；Work 的输出粒度由后端 agent 适配器决定，不保证与 Chat 一样逐字输出。
- 此版本面向局域网电脑连接，没有内置公网中转服务。

## 常见问题

**手机连接不上电脑？** 确认 Work 服务仍在运行、两台设备处于同一局域网，并使用终端输出的局域网地址。检查 Windows 防火墙是否允许 Node.js 在当前专用网络上连接；访客 Wi-Fi 或设备隔离也可能阻止访问。配对码失效后在电脑控制页重新生成。

**Chat 是否必须启动电脑？** 不需要。安装 APK 并填写可用 API Key 后，手机独立访问模型服务。

**助手显示未配置？** 先确认对应 CLI 在电脑能正常使用。必要时通过 `YINGLUO_CODEX_COMMAND` 或 `YINGLUO_DSH_COMMAND` 指定命令名或可执行文件路径。

**开启联网后为什么没有来源？** 开关允许模型搜索，但模型可能选择直接回答；搜索失败会显示提示。来源只展示接口实际返回的资料与引用。

## 上游

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 定制。上游使用与开发说明保留在 [`app/README.md`](app/README.md) 中；分发时请保留项目所附的上游许可与第三方声明。
