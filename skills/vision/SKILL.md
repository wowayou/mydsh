---
name: vision
description: 看图能力：把本地图片、截图、PDF 页面、视频帧发给视觉模型，拿回文字描述/OCR/UI 评审/图表读数/两图对比。适用于当前模型本身不支持图片输入（纯文本模型），或 read_image 报 UNSUPPORTED_CONTENT / 不可用时。
whenToUse: 用户给了图片、截图、设计稿、扫描件 PDF、录屏视频的路径，需要你了解里面的内容；或需要 OCR 取文字、审查界面、读图表数值、对比前后两张图。
metadata:
  author: mydsh
  requires: node>=22（可选 pdftoppm 处理 PDF、ffmpeg/ffprobe 处理视频与缩放）
---

# 视觉理解（本地文件 → 文字）

本技能通过一个零依赖 CLI 把本地视觉素材发给视觉模型，**返回纯文本**，所以即使你自己
是纯文本模型也能"看见"图片。

## 先决策：用 read_image 还是本技能

1. 如果 `read_image` 工具可用，**先试它** —— 图片直接进上下文，你自己看，最准也最省一跳。
2. `read_image` 报 `UNSUPPORTED_CONTENT`（当前路由不支持图片输入）、工具不存在、
   或素材是 PDF / 视频时 → 用本技能。
3. 需要的是"从图里抽结论"（OCR 全文、界面问题清单、图表数值、前后差异）而不是
   自己端到端看图时，本技能也更直接：一次调用就拿到结构化文字。

## 用法

脚本路径（已部署，直接用绝对路径调用；`$DSH_HOME` 默认 `~/.dsh`）：

```bash
node ~/.dsh/skills/vision/scripts/dsh-vision.mjs <文件...> [选项]
```

常用：

```bash
# 描述一张截图
node ~/.dsh/skills/vision/scripts/dsh-vision.mjs ./shot.png

# 取图里的文字（OCR）
node ~/.dsh/skills/vision/scripts/dsh-vision.mjs ./scan.png --preset ocr

# UI 审查：布局/对齐/对比度/可用性问题清单
node ~/.dsh/skills/vision/scripts/dsh-vision.mjs ./page.png --preset ui

# 扫描件 PDF 前三页转文字
node ~/.dsh/skills/vision/scripts/dsh-vision.mjs ./doc.pdf --pages 1-3 --preset ocr

# 录屏抽 4 帧，问具体问题
node ~/.dsh/skills/vision/scripts/dsh-vision.mjs ./demo.mp4 --frames 4 -p "用户依次点了哪些按钮？"

# 两图对比（改版前后）
node ~/.dsh/skills/vision/scripts/dsh-vision.mjs ./before.png ./after.png --preset diff
```

提问预设（`--preset`）：`describe`（默认）· `ocr` · `ui` · `chart` · `code` · `diff`。
自定义问题用 `-p/--prompt`，它会覆盖预设。**问得具体，回答就具体**——需要精确数值/
坐标/文案时，在 prompt 里明确要求逐项列出。

其他选项：`--pages 1-3,7`（PDF 页码）· `--frames n` / `--at 3,7.5`（视频抽帧）·
`--max-side 1280`（上传前缩放长边，0 关闭）· `--model provider/model`（指定视觉路由）·
`--max-chars`（返回上限）· `--json`（带 model/图列表/是否命中缓存的结构化输出）·
`--no-cache` · `--dry-run`（只打印计划，不发请求、不需要密钥）· `-h`。

## 行为与代价

- **路由**：自动读 `$DSH_HOME/settings.yaml` 里第一个像视觉模型的 provider/model
  （id 含 vl/vision/omni/multimodal），密钥取 `provider.apiKey` →
  同名环境变量 → `$DSH_HOME/.credentials.yaml`。密钥只进请求头，不打印、不记日志。
  猜不中时脚本会明确报错，此时用 `--model provider/model`。
- **要花钱**：每次调用都是一次真实 API 请求（按图片 token 计费）。同模型 + 同问题 +
  同图字节会命中本地缓存（`$DSH_HOME/mydsh/vision-cache`），重复问不重复付费。
  不确定要不要发的时候先 `--dry-run` 看清会发几张、多大。
- **一次最多 8 张图**，总 base64 上限 15MB；超了就减少 `--pages`/`--frames` 或分批。
- **审计**：每次调用（含被拒的读取）都追加到 `$DSH_HOME/mydsh/vision.jsonl`。

## 可读范围（会被拒的情况）

只能读**当前工作目录**内的文件，外加 `MYDSH_VISION_EXTRA_ROOTS`（`:` 分隔绝对路径）。
先 realpath 再校验，所以指向外部的符号链接也会被拒。部署方可设
`MYDSH_VISION_ROOTS` 固定权威根，此时命令行无法扩大范围。

被拒时脚本以 `ERROR: ...` 退出（exit 1）并说明原因（`不在允许根内` / `文件不存在` /
`不支持的类型` / `文件过大`）。**不要试图绕过它**（复制到 cwd、改环境变量、找别的
读取方式）；直接把限制告诉用户，让用户把文件放进工作区或自己设置额外根。

## 失败模式

| 现象 | 处理 |
| --- | --- |
| `自动选路失败` | settings.yaml 里没有视觉模型 → 用 `--model provider/model`，或告诉用户需要配一个 |
| `密钥取不到` | 报出的是环境变量名，让用户检查 `.credentials.yaml` / 环境变量；不要自己去读密钥文件 |
| `HTTP 429/5xx` | 已自动重试 2 次；仍失败就是上游问题，如实报告，别改成"看起来像"的猜测 |
| `需要 pdftoppm / ffmpeg` | 缺外部依赖 → 告诉用户装 poppler-utils / ffmpeg，或让用户自己先导出图片 |
| 没返回文本 | 可能被上游安全策略拦截；换个 prompt 或如实报告 |

**重要**：模型的描述可能有错（错字、误读小字、猜测数值）。把它当"一位看过图的助手的
转述"，涉及关键数值/代码/文案时说明来源是视觉模型转述，必要时提高 `--max-side`
或换 `--preset ocr` 再确认。
