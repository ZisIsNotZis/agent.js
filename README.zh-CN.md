[English](README.md) | **简体中文**

<img src="assets/logo.svg" alt="agent.js" width="200" height="40">

# agent.js

一个跑在浏览器标签页里的编码 agent：一个网址、你自己的 key、一份放在浏览器文件系统里的工作区，以及一棵在页面被杀掉之后仍然活着的 agent 树。

**整个 agent——循环、工具、git 提交、一棵子 agent 树——都在一个静态页面里运行，没有我们自己的服务器；因此杀掉标签页最多损失正在跑的那一步，工作区也从不离开你的浏览器。**

线上地址：**https://zisisnotzis.github.io/agent.js/**，由 GitHub Pages 直接从默认分支提供，没有构建步骤，没有后端。
源码：**https://github.com/ZisIsNotZis/agent.js**，公开，AGPL-3.0。

![一次三节点运行：树、每个节点的对话记录、所选步骤的 diff 以及时间线，全部从日志折叠而来](evidence/w11/desktop-run.png)

## 它做什么

打开网址，填入 endpoint、模型名和你的 key（只保存在这个页面的内存里），描述你要的修改，按 **Send**。模型调用工具；每次调用是一步，每一步是一次提交；屏幕上显示它规划出的节点树、每个节点各自的对话、任意一步的 diff，以及作为时间线的全部日志。除了你自己的 provider，什么都不会被发出去；除了这个浏览器，什么都不会被存下来。

如果你需要无人值守的运行（关掉标签页就什么都不跑）、现在就要一个真正的 shell，或者希望别人替你保管凭据，那它不适合你。

## 快速开始

没有东西需要安装：没有依赖，没有构建。用 Node 把这个目录当静态站点提供出去，整个工具链就这些。

```sh
git clone https://github.com/ZisIsNotZis/agent.js
cd agent.js
node tools/serve.mjs           # http://127.0.0.1:8137/ —— 属于安全上下文，OPFS 与 service worker 才能用
```

然后在第二个终端里起一个不花钱的 provider：

```sh
node tools/mock-provider.mjs   # http://127.0.0.1:8138/v1，OpenAI 形状，每个请求都记到 .tmp/
```

在页面里填 endpoint `http://127.0.0.1:8138/v1`、模型 `mock-model`、key `anything`，按 **Use key**，写一段提示词，按 **Send**。在你通过它的 `POST /__script` 控制端点给它一份剧本之前，mock 只会回 `script exhausted`（剧本的形状写在 `tools/mock-provider.mjs` 顶部），探针正是靠这个跑出真实的多步运行。

要真正跑一次，就用任意 OpenAI 兼容的 `…/chat/completions` 地址，配你自己的模型和 key。key 只是某一次 `fetch` 的参数，存在内存里，由 **Forget** 清除，不会写进任何日志、存储或 URL。

## 现在能做什么

- **一个确实存在的工作区。** 文件在 OPFS 里；`navigator.storage.persisted()` 按它的返回值原样显示，而不是按我们希望的样子；service worker 提供页面外壳，所以断网重载也能看到那棵树。外壳逐个条目安装——一个条目取不到只损失那一个条目，并且屏幕上会点名它。
- **日志即事实。** IndexedDB 里一份只追加的 `intent`/`result` 记录，唯一索引 `kind:seq` 保证一致性；启动时把日志折叠成已定状态，只有 intent 没有 result 的那一条靠*检查*效果是否已经落地来收尾，而不是靠假设。
- **一步一次提交。** `ls`、`read`、`write`、`git_commit`，跑在 OPFS 适配层上；`git_commit` 是用 `isomorphic-git` 对这一步真正碰过的那个路径做一次真提交，所以一步的 diff 就是 git diff。
- **执行，并且说清边界。** `run_js` 在 Worker 里跑原生 JS，以及剥掉类型之后的 TS；`enum`、`namespace`、装饰器和构造函数参数属性会被 AST 遍历拒绝，并点出构造和行号；worker 只拿到源码、文件名、语言和参数——它读不到 key，因为 key 从来不会被送进去。
- **每个节点自己的模型循环。** OpenAI 形状的 chat completions，关闭流式，`usage` 原样显示，没有 provider SDK。消息前缀稳定；`plan` 建立这棵树，`spawn` 给子节点自己的对话和工具；重新打开页面时，日志里仍是 `running` 的每个节点都会重启。
- **每次运行一份轨迹。** OPFS 里的 `trace.ndjson` 以及由它派生的 `summary.md`，随运行写入，并可以从页面导出——失败的那次运行靠证据排查，而不是靠重跑。
- **导出与导入。** 一个 `{v:1, …}` 的 JSON，原样装着账本和树缓存；导入会先校验整个包再动手，替换、重放、再读回来证明写入已经落地。

## 架构

页面就是产品：没有服务器，没有构建。`index.html` 是屏幕，`sw.js` 是外壳缓存，`src/` 是全部运行时——模块用 `import` 加载，只有浏览器拿不到的那两个库使用提交进仓库的打包产物。

```
index.html  manifest.webmanifest  sw.js  icon-*.png   站点本身——发布出去的就是项目根目录
src/
  app.js        屏幕：运行面板、树、对话、diff、时间线、导出/导入
  loop.js       一次 turn = 一次模型调用；工具调用即步骤；plan/spawn；每个节点的消息
  provider.js   chat-completions 客户端；key 只在这里，别处没有
  run.js        步骤驱动（intent → 效果 → result）以及启动时的重放
  log.js        IndexedDB 只追加账本；replay() 把它折叠成已定状态
  tools.js      ls / read / write / git_commit，每个都带“这件事是不是已经发生过？”
  fs.js         fs 适配层，OPFS 只在这里拼写，外加 isomorphic-git 需要的 promises 子集
  exec.js       执行的页面侧：起 worker、10 秒上限、跑飞了就 terminate
  worker.js     worker 本体：原生 JS、可擦除的 TS、以及按 AST 给出的拒绝
  state.js      OPFS 树缓存；transfer.js 导出/导入；trace.js 一次运行的 ndjson
vendor/         isomorphic-git + Buffer + TypeScript，提交进仓库，由 tools/vendor.mjs 重新生成
tools/          serve.mjs、mock-provider.mjs、各探针、shot.mjs、bench-iogit/
evidence/       记录下来的运行：轨迹、摘要和截图，作为证据提交
inbox/  mail/   设计记录，以及这个项目与它所属工作区之间的往来消息
ROADMAP.md      台账：每个 workset 让什么成真、它的验收和它的 commit
```

它们怎么对话：屏幕调用 loop，loop 把每次工具调用变成 `run.js` 里的一个 `step()`，每个步骤在它的效果前后各经过一次 `log.js`。效果要么是 `src/tools.js` 走在 `src/fs.js`（OPFS 与 git）上，要么是 `src/exec.js`（一个 Worker）。`trace.js` 把实际发出去的和实际收回来的东西边跑边写下来。重新打开页面时重放日志——所以屏幕是对日志的读取，而不是对上一次会话的记忆。

## 如何开发

```sh
node tools/serve.mjs                 # 站点在 http://127.0.0.1:8137/
node tools/mock-provider.mjs         # 不花钱的 provider，在 :8138
node tools/probe-w11.mjs             # ……一次一个探针，服务器已经起着
URL=https://zisisnotzis.github.io/agent.js/ node tools/probe-m1.mjs   # 或者对着线上地址跑
```

- 探针有 `probe-m1`、`probe-m2`、`probe-m3`、`probe-m4`、`probe-m6`、`probe-shell`、`probe-w7`、`probe-w8`、`probe-w10`、`probe-w11` 和 `probe-module-graph`；每个都打印自己的检查项，有一项失败就以非零退出。它们需要 `playwright-core`——直接装好，或者用 `PLAYWRIGHT_CORE` 指过去——playwright 自带的 Chromium 没装时还需要 `CHROME_PATH`。
- `node tools/probe-module-graph.mjs` 拿 `sw.js` 里的 `SHELL` 去对照真实的模块图，所以一个“发布了但没被缓存”的模块会让检查失败，而不是在离线时失败。`SHELL` 一改就要在 `sw.js` 里升 `CACHE`。
- `node tools/vendor.mjs` 按固定版本重新生成 `vendor/` 并打印体积。这些打包产物是构建输出，但依然提交进仓库，因为站点必须在不构建的情况下被服务出去。
- `SHOT=evidence/x.png WIDTH=1280 HEIGHT=1000 SHOT_RUN=1 node tools/shot.mjs` 在一次真实的脚本化运行之后给页面拍照；`SHOT_DEMO=1` 不用 mock 也能把树填起来。
- `tools/bench-iogit/` 是一次测量，不是产品路径：在 1k 与 10k 文件下，一次单步提交经过 OPFS 要花多少（`REPORT.md`：0.25–0.49 s 与 3.0–4.1 s，打包 91 KB gzip）。

根目录没有 linter、没有打包器、没有包清单，这是有意的：被跑的就是被服务的那些文件。

## 如何贡献

读 [`CONTRIBUTING.md`](CONTRIBUTING.md)——简短版：动手前后各跑一遍探针；让一个说法要么被测量过，要么被标为“reported”；要改就改产品本身，而不是它的副本。

## 路线图

每个 workset 的交付物、验收和 commit 都在 [`ROADMAP.md`](ROADMAP.md) 里。

**已实现**——持久化与被服务的副本（W1）、日志与恢复（W2）、导出/导入（W3）、文件 + git 每步一次提交（W4）、执行（W5）、逐条目安装的外壳（W6）、对着 mock 的循环（W7）、作为界面的树（W8）、被记录下来的轨迹（W9）、`plan` 让运行本身长出树（W10）、子节点跑自己的循环并在重开时恢复（W11）、外壳对照模块图做检查（W12）。

**计划中**——里程碑最后那一项判断，而它是人的判断：在你自己的 key 和 provider 上的第一次真实运行（循环已经对着 mock 验证过，我们不产生任何付费调用）；compaction 与缓存算术；grep 的路线（10k 文件下走 fs 适配层的遍历是否承受得起），它决定 grep 是否发布；作为惰性可选项的 Python；以及手机上、Safari 和 Firefox 上的一切，仍未测量。

方向：一棵人在标签页里看着并操纵的 agent 树——每个节点有自己的对话、自己的提交、自己那一份预算，整件事可以从日志里恢复，于是工作比页面活得更久，而服务器从不持有 key、文件或钱。

## 许可证

AGPL-3.0，© ZisIsNotZis。见 [`LICENSE`](LICENSE)。
