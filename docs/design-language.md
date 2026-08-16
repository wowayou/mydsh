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
