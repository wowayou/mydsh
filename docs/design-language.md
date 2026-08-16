# mydsh 前端设计语言备忘（源自 DSH harness 设计令牌）

> 用途：mydsh 的浏览器插件是手写 bundle（无 CSS Modules、无组件库），
> 但视觉必须与 DSH 原生 UI 完全一致。本文件是从 harness 源码提取的
> 设计令牌与组件规范，做任何 UI 前先查这里，不要凭感觉写样式。

## 1. 颜色令牌（暗色主题 body[data-ds-dark-theme]）

| 令牌 | 值（暗色） | 用途 |
|---|---|---|
| `--dsw-specific-menu` | `--dsw-alias-bg-layer-3`（bluish-800） | **浮层/菜单卡片底** |
| `--dsw-specific-sidebar-fill` | bluish-900 | 侧栏底 |
| `--dsw-alias-border-inverted` | rgba(255,255,255,0.06) | **浮层卡片描边**（反色细线） |
| `--dsw-alias-border-l2` | rgba(255,255,255,0.12) | 一般分隔/描边 |
| `--dsw-alias-border-l1` | rgba(255,255,255,0.06) | 菜单内分隔线 |
| `--dsw-alias-label-primary` | bluish-50 | 主文字 |
| `--dsw-alias-label-secondary` | bluish-300 | 次文字 |
| `--dsw-alias-label-tertiary` | bluish-400 | 弱文字/头部/图标 |
| `--dsw-alias-interactive-bg-hover` | rgba(255,255,255,0.08) | hover 背景 |
| `--dsw-alias-interactive-bg-hover-danger` | rgba(242,90,90,0.15) | 危险 hover |
| `--dsw-shadow-lv3` | 0 0 1px rgba(0,0,0,.2), 0 0 4px rgba(0,0,0,.02), 0 12px 32px rgba(0,0,0,.08) | **浮层阴影** |

⚠️ 不要用 `--dsw-alias-bg-overlay`（那是模态遮罩底 bluish-700，不是浮层）。

## 2. 下拉菜单（Menu，figma MenuDropdown）

复刻 `packages/client/ui-primitives/src/Menu.module.css`：

```
卡片 .list:
  box-sizing: border-box; padding: 4px;           ← 内边距 4px
  border: 1px solid var(--dsw-alias-border-inverted);   ← 反色描边
  border-radius: 12px;
  background: var(--dsw-specific-menu);
  box-shadow: var(--dsw-shadow-lv3);
  min-width: 218px; max-width: 360px;
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 100;
  开在上方: top:auto; bottom: calc(100% + 4px);

菜单项 .item (figma .Menu_cell):
  display:flex; align-items:center; gap:8px;
  width:100%; min-height:40px; padding:8px 10px;
  border:none; border-radius:10px;
  background:transparent; cursor:pointer;
  font-size:14px; line-height:22px;
  color: var(--dsw-alias-label-primary); text-align:left;
  hover:not(:disabled): background: var(--dsw-alias-interactive-bg-hover);
  icon 槽: 16x16, flex:none, color: var(--dsw-alias-label-tertiary)
  label 槽: flex:1, ellipsis

头部 .label (不可选 heading):
  padding:8px 10px; font-size:12px; line-height:16px;
  color: var(--dsw-alias-label-tertiary);

分隔 .separator:
  height:1px; margin:4px 2px; background: var(--dsw-alias-border-l1);

滚动: .scrollable max-height: calc(100vh - 24px); .viewport overflow-y:auto;
```

## 3. 侧栏 footer 触发器（Settings trigger，figma sidebar foot）

```
.trigger: 34px 高 / 12px 圆角 / 透明底
  padding: 6px 2px 6px 10px; margin: 4px -4px 4px;
  hover: background: var(--dsw-alias-interactive-bg-hover);
  font-size:14px; line-height:22px; color: var(--dsw-alias-label-primary);
  icon 16px + 文字, gap 8px
.trigger.rail (折叠): 36px 圆形 / 居中 / padding 0 / margin 8px 0 10px
```

## 4. 新建会话主按钮（.newSession）

```
38px 高 / 12px 圆角 / pad 8px 16px / margin 0 2px 8px
border: 1px solid var(--dsw-alias-border-l2);
background: var(--dsw-alias-button-elevated-fill);
font-size:14px; font-weight:500; line-height:22px; color: label-primary;
hover: var(--dsw-alias-button-floating-hover)
折叠: 36px 方形 / 透明底
```

## 5. 硬性规则

1. **浮层一律用 `--dsw-specific-menu` + `--dsw-alias-border-inverted` + `--dsw-shadow-lv3` + r12 + 4px pad**
2. **菜单项一律 min-h 40 / r10 / pad 8 10 / 14/22 / label-primary / hover interactive-bg-hover**
3. **不用 `--dsw-alias-bg-overlay` 做浮层底**（那是模态遮罩）
4. 图标用 `fill="currentColor"` 的 16px 线条 SVG，与 DSH 图标库同风格
5. 侧栏 footer 按钮对齐 Settings trigger 的 34px/12px 语言
6. 菜单向上/向下开都保持 4px gap（`bottom: calc(100% + 4px)` / `top: calc(100% + 4px)`）
7. 手写 bundle 无 CSS Modules：hover 用 React state 模拟，但**值必须用上面的令牌**

## 6. 屏幕居中 Modal（Modal.module.css，figma Mask+Dialog 451:18655）

```
.root: position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center; padding: 24px;
.mask: position: absolute; inset: 0;
  background: var(--dsw-alias-bg-mask-1);          ← 暗色 rgba(0,0,0,0.5)
  backdrop-filter: var(--dsw-mask-blur);           ← blur(2px) 优雅模糊
.dialog: position: relative; z-index: 1;
  display: flex; flex-direction: column; gap: 20px;
  width: min(380px, 100%); padding: 0 0 24px; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-inverted);
  border-radius: 24px;                             ← r24（比菜单 r12 大一档）
  background: var(--dsw-alias-bg-layer-2);         ← 面板底（比菜单高一层）
  box-shadow: var(--dsw-shadow-lv3);
.header: display:flex; justify-content: space-between; gap:8px;
  padding: 22px 14px 12px 24px;
  title: 16px/24px, font-weight: 500, label-primary
  close: 28x28, r8, transparent, label-secondary; hover: interactive-bg-hover
.description: 14/22, pad 0 24, label-primary
.body: display:flex; flex-direction:column; min-width:0;
  margin-top: 20px; padding: 0 24px;
.footer: flex; justify-content: flex-end; gap:8px; padding: 0 24px;
```

⚠️ 需要 `createPortal`（react-dom）渲染到 body，避免祖先 overflow/stacking 裁剪。
手写 bundle：`const ReactDOM = require('react-dom')`。

## 7. 弹窗内列表行（宽松 + 优雅 hover）

弹窗面板里的可选项行（如工作区列表）不该用紧凑菜单项（min-h 40），
用宽松面板行：

```
min-height: 56px; padding: 12px 14px; border-radius: 12px;
两行布局: title(14/22 wt500 label-primary) + path(12/18 label-tertiary)
leading 图标 20x20 label-secondary
hover 底纹: background: var(--dsw-alias-interactive-bg-hover)
           （暗色 rgba(255,255,255,0.08)，半透明优雅过渡）
选中: trailing check 16px label-primary + 可选「最近使用」角标 12/18 label-tertiary
```

## 8. 侧栏底部按钮必须整行扩展（Settings trigger 关键细节）

之前漏掉的关键：侧栏 footer 按钮**不是**内容宽度的 pill，
是**整行 trigger**——底纹基本占满侧栏宽度：

```
.trigger {
  width: calc(100% + 8px);        ← 比父容器宽 8px
  margin: 4px -4px 4px;           ← 负 margin 抵消 padding
  height: 34px; border-radius: 12px;
  padding: 6px 2px 6px 10px; gap: 8px;
  background: transparent;         ← 平时透明，hover 才亮
}
```
配合侧栏 root 的 `margin-right: calc(-1 * var(--dsh-sidebar-inline-padding))`，
hover 底纹超出 padding 贴满侧栏宽度。
⚠️ 这是 DSH 侧栏按钮的语言：整行可点、整行 hover，不是小 pill。
折叠 rail 才收成 36px 圆形。

## 9. 面板高度克制（业界快速选择面板形态）

面板（Modal）高度必须克制，超高时内部滚动（参考 RiskConfirmation）：
- dialog: `max-height: calc(100vh - 48px)`，`overflow: hidden`
- 内容区: `min-height: 0; overflow-y: auto; overscroll-behavior: contain`
- header 紧凑（pad 18 14 8 24），描述 13-20 用 label-secondary（次级强调）
- 列表行收敛 min-h 44 / r10 / pad 10 12——不局促也不臃肿

## 10. 会话头操作按钮（JobListAction.trigger 权威形态）

`conversation.session.header.actions` 里的操作按钮：

```
min-height: 28px; padding: 3px 2px; gap: 3px;
border: 0; border-radius: 6px; background: transparent;
font-size: 12px; line-height: 18px;
color: var(--dsw-alias-label-tertiary);
hover / focus-visible: color: var(--dsw-alias-label-secondary);
```

## 11. 通用按钮（Button 组件，figma Button）

```
.button: display inline-flex; align-items center; justify-content center;
  gap: 4px; border: none; border-radius: 18px;
  font-size: 14px; line-height: 22px; padding: 0 14px;
.md: height: 36px;
.sm: height: 28px; font-size: 12px; line-height: 18px;
     padding: 0 10px; border-radius: 14px;
variant:
  primary: bg var(--dsw-alias-button-primary-fill); color label-primary-foreground;
           hover: button-primary-hover
  ghost: transparent; hover: interactive-bg-hover; active: interactive-bg-active
  outline: border 1px border-l2; hover: interactive-bg-hover
  toolbar: bg button-tool-bar-fill; hover: button-tool-bar-hover
```

设置行里的操作按钮（上传/试听/重置）用 **ghost**（不是 selector pill）；
danger 语义用 `--dsw-alias-state-warn-primary`。

## 12. 统一原则（全项目）

| 元素 | 语言 |
|---|---|
| 会话头操作 | JobListAction.trigger（28/r6/12-18/tertiary→secondary） |
| 设置行 | LanguageRow row（pad 16 0 / border-l2 / title 14-22） |
| 设置行操作 | Button ghost（36/r18/pad 0 14/14-22/hover） |
| 侧栏底部 | Settings trigger 整行（calc(100%+8px)/34/r12/transparent hover） |
| 浮层 | Menu 卡片（218+/4px pad/r12/specific-menu/border-inverted/lv3） |
| 居中弹窗 | Modal（380/r24/layer-2/max-height 100vh-48/内容滚动） |
