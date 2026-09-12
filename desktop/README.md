# AI Carry 客户端

与网页版共用 `dashboard/src/app/` 和同一份离线构建。点击功能后预览并复制请求，再发给用户选择的 Agent；没有 Agent 接收器、常驻连接、模型账号或后台任务队列。

客户端只读取用户明确选择的助手目录，使用随应用发布的可信读取器；不会执行所选目录的 JavaScript。窗口开启隔离与沙箱，网页不能直接读磁盘、调用系统命令或访问网络。选择 Skill 只取得路径，不读取或上传文件。

发行版直接打开 AI Carry 应用，无须 CMD 或单独安装 Node.js。Windows 包含 `AI Carry.exe`；macOS 使用 `.app`。Linux 继续使用网页版。未签名应用可能显示系统来源提示，不自动绕过系统安全设置。

首次安装（或补建入口）由 Agent 对固定版本应用执行：

```
AI Carry.exe --install-shortcuts --assistant-root "本次安装的 AI Carry 完整目录"
```

创建系统实际桌面上的网页版和客户端入口。已有同一助手的入口可更新；其他同名文件保留并另取名称。结果保存在应用用户目录的 `installation-result.json`。快捷方式失败只影响入口，不撤销安装或修改助手数据。不设置开机启动，不修改权限。

开发时可用 Electron 打开此目录；正式打包只接收已核验的公开源快照，不接收私密 Dev 全树。字体许可随包保留，Electron 与 Chromium 的 LICENSE/NOTICE 保留在发行包中。
