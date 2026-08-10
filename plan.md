不要一开始就通读 VS Code 源码。这个项目太大，应该采用“理解一层、运行一个最小实验”的方式。

## 第一步：先确认项目要求

向导师确认这几个问题：

1. “离线”是指断网后仍能运行吗？
2. 是否允许浏览器之外运行本地代理程序？
3. 是否要求完全在浏览器中运行？
4. 需要支持哪些功能：文件、终端、编译、扩展、调试？
5. 是否必须使用 v86 的 32 位 Arch Linux？

尤其是“是否允许外部代理”会直接决定网络方案。

## 第二步：理解整体架构

按以下顺序阅读：

1. [VS Code 源码结构](https://github.com/microsoft/vscode/wiki/Source-Code-Organization)
2. [Code OSS 与官方 VS Code 的区别](https://github.com/microsoft/vscode/wiki/Differences-between-the-repository-and-Visual-Studio-Code)
3. [Extension Host 架构](https://code.visualstudio.com/api/advanced-topics/extension-host)
4. [Remote Development 架构](https://code.visualstudio.com/api/advanced-topics/remote-extensions)

重点理解四个概念：

```text
Workbench：浏览器中的界面
Remote Agent：远程服务器
Extension Host：运行扩展
Remote File System：访问远程文件
```

完成后，你应该能自己画出：

```text
浏览器 Workbench
      ↓ WebSocket
Remote Agent
      ↓
文件系统 / 终端 / 扩展 / 编译器
```

## 第三步：先在普通 Ubuntu 上连接 Server

暂时不要碰 v86。

阅读：

- [monaco-vscode-api README](https://github.com/CodinGame/monaco-vscode-api)
- [完整 Workbench 演示](https://monaco-vscode-api.netlify.app/?mode=full-workbench)
- [连接 VS Code Server 的教程](https://github.com/CodinGame/monaco-vscode-api/wiki/How-to-install-and-use-VSCode-server-with-monaco%E2%80%90vscode%E2%80%90api)
- [OpenVSCode Server](https://github.com/gitpod-io/openvscode-server)

实验目标：

1. 在 Ubuntu 上启动 OpenVSCode Server。
2. 确认浏览器可以打开它。
3. 本地运行 `monaco-vscode-api` demo。
4. 让 demo 连接 Ubuntu 上的 Server。
5. 打开远程目录、编辑文件、启动终端。

这一步能把“VS Code 集成问题”和“v86 问题”分开。

## 第四步：学习 v86

按以下顺序：

1. [v86 README](https://github.com/copy/v86/blob/master/Readme.md)
2. [v86 基础示例](https://github.com/copy/v86/tree/master/examples)
3. [v86 TypeScript API](https://github.com/copy/v86/blob/master/v86.d.ts)
4. [v86 网络文档](https://github.com/copy/v86/blob/master/docs/networking.md)
5. [TCP Terminal 示例](https://github.com/copy/v86/blob/master/examples/tcp_terminal.html)
6. [inbrowser 实现](https://github.com/copy/v86/blob/master/src/browser/inbrowser_network.js)

实验目标：

1. 自己写一个最小 HTML 页面启动 v86。
2. 在 guest 运行：
   ```bash
   uname -m
   ip addr
   ```
3. 在 guest 启动 TCP 服务：
   ```bash
   socat PIPE TCP-LISTEN:1234,fork
   ```
4. 网页通过：
   ```javascript
   emulator.network_adapter.tcp_probe(1234)
   emulator.network_adapter.connect(1234)
   ```
   与 guest 双向通信。

这是当前最重要的实验。

## 第五步：研究真正的 Server

优先顺序：

1. [OpenVSCode Server 开发文档](https://github.com/gitpod-io/openvscode-server/blob/docs/development.md)
2. [VSCodium REH 说明](https://github.com/VSCodium/vscodium/blob/master/docs/others.md)
3. [VS Code server.main.ts](https://github.com/microsoft/vscode/blob/main/src/vs/server/node/server.main.ts)
4. [Remote Agent Server](https://github.com/microsoft/vscode/blob/main/src/vs/server/node/remoteExtensionHostAgentServer.ts)

这里的 `REH` 是 Remote Extension Host。

暂时不要深入：

- 整个 `code-server/src`
- 整个 VS Code 仓库
- `server.cli.ts`

这些目前会产生大量无关信息。

## 第六步：处理两个核心风险

### 风险一：网络桥接

`monaco-vscode-api` 通常使用浏览器 WebSocket，但 v86 的 `connect()` 返回自定义 TCP 字节流。

需要调查：

```text
能否给 VS Code BrowserSocketFactory 注入自定义连接？
        或
是否需要实现 WebSocket ↔ v86 TCP 适配层？
```

先证明网页能连接 guest TCP，再研究 VS Code 协议。

### 风险二：32 位兼容

v86 Arch 是 32 位 x86，而官方 Server 通常没有 i686 包。

需要验证：

```bash
uname -m
node --version
getconf LONG_BIT
```

然后调查：

- 32 位 Node.js 是否可用
- `node-pty`、SQLite、ripgrep 等原生模块能否为 ia32 构建
- OpenVSCode Server 构建任务能否增加 `linux-ia32`
- 是否需要删减不支持的原生功能

不要在 v86 中编译。在 Ubuntu 主机上构建，再放入虚拟机镜像。

## 推荐的实际执行顺序

第一周只做五件事：

1. 阅读 VS Code Remote 架构。
2. 本机运行 monaco-vscode-api demo。
3. 本机运行 OpenVSCode Server。
4. 让二者在普通 Ubuntu 上连接。
5. 完成网页与 v86 guest 的 TCP echo 实验。

完成后再决定是否进入 32 位构建。如果第 4、5 步不能分别成功，直接构建完整 Server 没有意义。

最终项目可以拆成四个里程碑：

```text
M1：Monaco 前端连接普通 Linux Server
M2：网页连接 v86 guest TCP 服务
M2.5 / M2.75：传输 shim + webSocketFactory
M3a：降级后端 compile_agent + 浏览器 IDE
M3b：自构建 ia32 REH（搁置）
M4：monaco-vscode-api Workbench + v86 串口编译 ← 当前
```

跨会话交接（给后续 agent）：见 `agent/CONTEXT.md`。

### Option A 产品页

轻量 IDE（textarea）：

```text
http://localhost:8000/examples/alpine-ide.html
```

VS Code 式 Workbench（monaco-vscode-api demo，本地编辑器 + v86）：

```text
cd monaco-vscode-api/demo && npm start
# http://localhost:5173/?mode=full-workbench
# 可选: &ucdTransport=auto|tcp|serial  （默认 auto：TCP agent，失败回退串口）
# 命令：UCD: Run C in Alpine (v86) 或 Ctrl+Alt+B
```

- 默认传输：guest `compile_agent.js`（virtio-net）
  - 控制口 **:1234**：framed JSON（`compile|write|read|list|mkdir|unlink|exec|ping`）
  - Shell 口 **:1235**：原始 `/bin/sh -i`（Workbench Terminal）
  - 工作区：guest `/root/workspace`；编辑器 **Save** 同步写入
- 回退：串口 base64 → gcc（`ucdTransport=serial` 或 auto 失败时）
- **不是** VS Code Server；持久化（IndexedDB save_state）下一步

试用：

1. `Ready (tcp)` 后打开 **Terminal** → 应连上 guest shell（`ls` 看 workspace）
2. 编辑 `main.c` → **Save** → 终端里 `cat main.c` 应看到改动
3. **Ctrl+Alt+B** 或命令 `UCD: Run C in Alpine` 编译运行
4. `UCD: Sync open editors to guest workspace` 可手动全量同步