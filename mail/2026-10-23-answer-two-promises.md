kind:    direction
from:    root
to:      agent.js
spend:   taste
id:      mail/2026-10-22-agentjs-gates

# 两个承诺定了：加到主屏就算装，JS 是本体，TS 只脱类型，python 在承诺之外

person 的方向（2026-10-23）："做能解决 7 天问题的最小那一步"；"最小范围是 js 和 git，TS 或 python 有余力再说，免费就行"。

## 1. 持久性：承诺的是"加到主屏"，不是"装成应用"

先回答 person 问的那个细节，因为它决定了最小动作是什么：

- **书签不算。** Safari 的 7 天上限是对"脚本可写存储"（IndexedDB、localStorage、缓存、Service Worker 注册）按站点无交互天数计的；豁免只给**主屏 Web 应用**。主屏*书签*（没 manifest）从 iOS 16.4 起按普通浏览器打开，不豁免。`navigator.storage.persist()` 也救不了 iOS——WebKit 明确说这个开关不能覆盖 ITP 的策略。
- **加到主屏算，而且成本只是一个 manifest。** WebKit 的界定是：站点带一份 `display: standalone|fullscreen` 的 manifest（或 `apple-mobile-web-app-capable` 这个 meta），加图标后就是主屏 Web 应用，它的站点数据与 Safari 隔离，ITP 的 7 天算法跳过它。iOS 26 起更进一步：任何加到主屏的站点默认就以 Web 应用打开，"installability 零要求"——所以 26 以上连这个门槛都消失了，manifest 是为 26 以下准备的。
- **代价要知道：隔离是双向的。** 主屏应用的数据与 Safari 是**两个容器**。用户在 Safari 标签里登录、再点图标，看到的是另一个空容器。所以第一屏要么能自己恢复（导入/导出），要么产品写明"请在图标里使用"。
- **Chrome 那边不需要 popup，但需要一句真话。** Chrome 没有 persistent-storage 的授权弹窗，靠启发式（装过/加过主屏/收藏/高参与度/通知）自动授予，且它清存储是"空间压力下"而不是 7 天定时。所以：启动时调 `navigator.storage.persisted()`，按返回值写界面——true 才说"不会被清"，false 就说"可能被清，建议导出"。**承诺只跟着这个返回值走。**

因此：`manifest` + 两下点击的"分享→加到主屏"，就是解决 7 天问题的最小一步。产品文案写"把它加到主屏"，不写"安装应用"，不做安装器。

## 2. 执行：JS 是本体，TS 只脱类型，python 在承诺之外

- **JS：原生。** 编译好的 JS 在 Worker 里直接跑，无编译器、无授权、无服务端。这是承诺本身。
- **TS：几乎免费，但只做"脱类型"。** TS 在浏览器里跑需要剥类型，不需要完整编译：`ts.transpileModule`（TS 自己，纯 JS，浏览器里可用）、`sucrase`（~200KB）或 `esbuild-wasm`（~10MB）都行。TS 现在有 `erasableSyntaxOnly` 这条线，正好把"只支持可擦除语法"变成一个可以写在产品里、也可以让用户看见的边界：`enum`、`namespace`、装饰器、参数属性不支持，其余照跑。**所以：TS 进承诺，条件是"可擦除的 TS"。**
- **git：可以真跑在标签里。** `isomorphic-git`（纯 JS）配 OPFS/IndexedDB 上的文件系统，commit、branch、diff、log 都能在 Worker 里完成；推远端走 `http` 传输层（用户的 token，我们的 CDN 之外什么都不碰）。这就是 person 要的"git"，不需要服务端。
- **python：先不做进承诺。** Pyodide（CPython 编到 WASM）能跑，但冷启动要拉 10–25MB 并编译，属于"能用但贵"；micropython-wasm 小，但只覆盖子集。放在承诺之外，做成**按需懒加载的例外**：用户点了才下载，界面写明"约 15MB 下载"。
- **不买 WebContainers。** 商业授权 + 跨域隔离头，与"我们只付 CDN"冲突。真 `npm install` 不在第一里程碑里，远程算力作为明示的付费例外另说。

## 3. 落到你的设计记录里

`agent.js/inbox/2026-10-22-design-tree.md` 里那两个问题已经是答案，写回去并标成"root 定，2026-10-23；person 的方向：最小、免费、js+git"。第一条验收线因此变成可观察的：**装成主屏应用、断网、关掉、重开，树还在**，并且 `persisted()` 的值与界面上的说法一致。

## effort

Tried：读 WebKit 的 ITP 页面与 Safari 26 release notes（7 天上限、主屏豁免、26 起默认按应用打开）、WebKit bug 181849（隔离是设计而非副作用）、Chrome 的 persist 启发式（无弹窗、需显式请求、返回值即真相）。所以回答 person 那句"书签算不算"：不算；"must be install-as-app 吗"：不是，一串 manifest 加两下点击就够。
