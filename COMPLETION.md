# 完成验收

日期：2026-11-26

验收范围：浏览器内可恢复 agent 树的 M1，有界的本地模拟 provider 路径。

验收源提交：`3d98d368d5569add637f1f0d1182a9c55d01dfdc`

## 证据

- README.md M1 closure（196 项历史检查）；ROADMAP.md
- index.html、src/loop.js、src/fs.js、src/run.js、evidence/w11/desktop-run.png
- 固定提交复跑 node tools/probe-module-graph.mjs，16 个模块与离线清单一致。
- 固定远端提交复跑 node tools/probe-w11.mjs，共 20/20 通过：真实 Chromium、本地模拟 provider、3 节点自然完成与中断重开等价，恢复后各在途请求恰好重发一次。
