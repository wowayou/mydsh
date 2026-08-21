// mydsh ui-session-tabs — browser-side: open session in new tab + URL deep-linking.
//
// Three pieces:
// 1. "Open in new tab" button in conversation.session.header.actions
//    (the session header action row — the three-dots area on each session).
//    Uses sessionId from PropsRuntime framework kit.
// 2. URL session opener: null component in conversation.input.dock that reads
//    ?session=<id> from the URL and opens the matching session.
// 3. "New session in new tab" button in sidebar.footer.action: opens a fresh
//    tab WITHOUT ?session= so the new tab initializes a blank New Session via
//    the standard startInitialSelection flow (not a deep link to an existing
//    session). Sits beside Settings at the sidebar foot.
//
// Hand-written __ModuleLoader__ bundle (zero build deps): only requires react.
window.__ModuleLoader__.load({
	id: '@mydsh/ui-session-tabs',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');
		const ReactDOM = require('react-dom');
		const { useState, useEffect, useMemo, useRef, useCallback, createElement } = React;

		function isZh() {
			try { return (navigator.language || '').toLowerCase().startsWith('zh'); } catch { return false; }
		}
		var T = isZh()
			? { openTab: '在新标签页打开本会话（链接已复制）', copied: '✓',
			    newTabLabel: '新建会话', newTab: '新建会话',
			    modalTitle: '新建会话', modalDesc: '选择目标工作区，将在新标签页打开。',
			    workspacePickAria: '新建会话：选择目标工作区（将打开新标签页）',
			    noWorkspace: '暂无工作区',
			    recentHint: '最近使用', close: '关闭' }
			: { openTab: 'Open this session in a new tab (link copied)', copied: '✓',
			    newTabLabel: 'New session', newTab: 'New session',
			    modalTitle: 'New session', modalDesc: 'Choose a workspace; it opens in a new tab.',
			    workspacePickAria: 'New session: choose a workspace (opens a new tab)',
			    noWorkspace: 'No workspace yet',
			    recentHint: 'Recent', close: 'Close' };

		function deepLink(sessionId) {
			try {
				var u = new URL(window.location.href);
				u.searchParams.set('session', String(sessionId));
				return u.toString();
			} catch {
				return window.location.href.split('#')[0] + '?session=' + encodeURIComponent(String(sessionId));
			}
		}

		/** 当前页面 URL 去掉 ?session= 参数后的地址：新标签页打开它即等于
		 *  「新建会话」（走 startInitialSelection，不指向任何已存在会话）。 */
		function blankTabUrl() {
			try {
				var u = new URL(window.location.href);
				u.searchParams.delete('session');
				return u.toString();
			} catch {
				return window.location.href.split('#')[0].split('?')[0];
			}
		}

		// "Open in new tab" button for the session header action row.
		// 对齐 JobListAction.trigger（会话头操作按钮权威形态）：
		//   min-h 28 / r6 / transparent / 12-18 / label-tertiary → hover secondary。
		function OpenTabAction(props) {
			var sessionId = props.sessionId;
			var state = useState(false);
			var copied = state[0]; var setCopied = state[1];
			var hoverState = useState(false);
			var isHovered = hoverState[0]; var setHovered = hoverState[1];
			var timer = useRef(undefined);

			useEffect(function() { return function() {
				if (timer.current !== undefined) clearTimeout(timer.current);
			}; }, []);

			var onClick = useCallback(function() {
				var url = deepLink(sessionId);
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(url).catch(function() {});
					}
				} catch {}
				try { window.open(url, '_blank'); } catch {}
				setCopied(true);
				if (timer.current !== undefined) clearTimeout(timer.current);
				timer.current = setTimeout(function() { setCopied(false); }, 1500);
			}, [sessionId]);

			var color = copied
				? 'var(--dsw-alias-state-success-primary)'
				: isHovered
					? 'var(--dsw-alias-label-secondary)'
					: 'var(--dsw-alias-label-tertiary)';

			return createElement('button', {
				title: T.openTab,
				onClick: onClick,
				onMouseEnter: function() { setHovered(true); },
				onMouseLeave: function() { setHovered(false); },
				style: {
					display: 'inline-flex', alignItems: 'center', gap: '3px',
					minHeight: '28px', padding: '3px 2px',
					background: 'transparent', border: 'none', cursor: 'pointer',
					borderRadius: '6px', lineHeight: '18px',
					fontSize: '12px', font: 'inherit',
					color: color,
				},
			}, copied ? T.copied : '⧉');
		}

		// URL session opener: null component, opens session from ?session=<id>.
		function UrlSessionOpener(props) {
			var useSessions = props.useSessions;
			var sessions = props.sessions;
			var target = useMemo(function() {
				try { return new URLSearchParams(window.location.search).get('session'); } catch { return null; }
			}, []);
			var listed = useSessions(function(s) { return s && s.phase === 'ready' && target !== null && s.ids.indexOf(target) !== -1; });
			var opened = useRef(false);
			useEffect(function() {
				if (!listed || opened.current || sessions === undefined || sessions === null) return;
				opened.current = true;
				try { sessions.open(target); } catch {}
			}, [listed, target, sessions]);
			return null;
		}

		// "New session in new tab" button for the sidebar footer action slot.
		// 视觉完全对齐 DSH footer 的 Settings trigger（figma sidebar foot）：
		//   34px 高 / 12px 圆角 / 透明 + hover interactive-bg-hover / 14px label-primary /
		//   16px 线条图标（与顶部 New Session 同款 ic_ds_new_chat_outline_16 path）。
		// wide: 图标 + 文字；折叠 rail: 36px 圆形只留图标（与 Settings 折叠态一致）。
		// 手写 bundle 无 CSS Modules，hover 背景用 React state 模拟。
		//
		// 行为：点击弹出 workspace 选择框（浮层），选一个 workspace 后
		// connectWorkspace(id) 拿到（复用或新建的）会话 id，再在新标签页深链打开。
		// 没有 workspace 可选项时退化为「打开空标签页」（新标签页自己初始化）。
		// DSH 同款 ic_ds_folder_close_16 path（按钮 + 菜单项 leading 图标，workspace 语义）。
		var FOLDER_ICON_PATH =
			'M5.05582 0.518756L4.50669 0.86654L5.05582 0.518756ZM13 9.4837L13.65 9.4837L13.65 3.53962L13 3.53962L12.35 3.53962L12.35 9.4837L13 9.4837ZM11.3264 1.86603L11.3264 1.21603L6.52313 1.21603L6.52313 1.86603L6.52313 2.51603L11.3264 2.51603L11.3264 1.86603ZM5.58054 1.34727L6.12968 0.999489L5.60495 0.170972L5.05582 0.518756L4.50669 0.86654L5.03141 1.69506L5.58054 1.34727ZM4.11323 1.23058e-13L4.11323 -0.65L1.67359 -0.65L1.67359 5.00699e-14L1.67359 0.65L4.11323 0.65L4.11323 1.23058e-13ZM0 1.67359L-0.65 1.67359L-0.65 9.4837L0 9.4837L0.65 9.4837L0.65 1.67359L0 1.67359ZM11.3264 11.1573L11.3264 10.5073L1.67359 10.5073L1.67359 11.1573L1.67359 11.8073L11.3264 11.8073L11.3264 11.1573ZM0 9.4837L-0.65 9.4837C-0.65 10.767 0.390308 11.8073 1.67359 11.8073L1.67359 11.1573L1.67359 10.5073C1.10828 10.5073 0.65 10.049 0.65 9.4837L0 9.4837ZM1.67359 5.00699e-14L1.67359 -0.65C0.390307 -0.65 -0.65 0.390309 -0.65 1.67359L0 1.67359L0.65 1.67359C0.65 1.10828 1.10828 0.65 1.67359 0.65L1.67359 5.00699e-14ZM5.05582 0.518756L5.60495 0.170972C5.28121 -0.340193 4.71829 -0.65 4.11323 -0.65L4.11323 1.23058e-13L4.11323 0.65C4.27282 0.65 4.4213 0.731715 4.50669 0.86654L5.05582 0.518756ZM6.52313 1.86603L6.52313 1.21603C6.36354 1.21603 6.21507 1.13431 6.12968 0.999489L5.58054 1.34727L5.03141 1.69506C5.35515 2.20622 5.91808 2.51603 6.52313 2.51603L6.52313 1.86603ZM13 3.53962L13.65 3.53962C13.65 2.25634 12.6097 1.21603 11.3264 1.21603L11.3264 1.86603L11.3264 2.51603C11.8917 2.51603 12.35 2.97431 12.35 3.53962L13 3.53962ZM13 9.4837L12.35 9.4837C12.35 10.049 11.8917 10.5073 11.3264 10.5073L11.3264 11.1573L11.3264 11.8073C12.6097 11.8073 13.65 10.767 13.65 9.4837L13 9.4837Z';

		function FolderIcon() {
			return createElement('svg', {
				width: 16, height: 16, viewBox: '0 0 16 16',
				fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
				'aria-hidden': true,
			}, createElement('path', { transform: 'translate(1.5 2.429)', d: FOLDER_ICON_PATH, fill: 'currentColor' }));
		}

		// DSH 同款 ic_ds_check_outline_16（菜单选中项 trailing check）。
		var CHECK_PATH =
			'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z';

		function CheckIcon() {
			return createElement('svg', {
				width: 16, height: 16, viewBox: '0 0 16 16',
				fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
				'aria-hidden': true, style: { flexShrink: 0 },
			}, createElement('path', { d: CHECK_PATH, fill: 'currentColor' }));
		}

		// DSH 同款 ic_ds_close_outline_16（Modal 关闭按钮）。
		var CLOSE_PATH =
			'M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197ZM13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z';

		function CloseIcon() {
			return createElement('svg', {
				width: 14, height: 14, viewBox: '0 0 16 16',
				fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
				'aria-hidden': true,
			}, createElement('path', { d: CLOSE_PATH, fill: 'currentColor' }));
		}

		// ── workspace 选择纯逻辑（可测） ─────────────────────────────────

		/** workspaces.list 快照 → 选择框选项 [{id, title, path}]（按列表顺序）。 */
		function workspaceChoices(list) {
			try {
				var items = (list && list.items) || [];
				return items.map(function(w) {
					return { id: w.workspaceId, title: w.title, path: w.path };
				});
			} catch { return []; }
		}

		/**
		 * 在指定 workspace 下新建会话并打开新标签页。
		 * @returns 'opened' | 'fallback' | 'error'
		 *   - 'opened': connectWorkspace 成功，已 window.open 深链
		 *   - 'fallback': 无 workspace 可选 / 无 workspaces 服务，退化为打开空标签页
		 *   - 'error': connectWorkspace 失败（已在 console 记录）
		 */
		function openNewTabInWorkspace(workspaces, workspaceId, win) {
			var w = win || (typeof window !== 'undefined' ? window : null);
			// 无目标 workspace 或服务缺失：打开空标签页，让新标签页自己初始化。
			if (!workspaces || typeof workspaces.connectWorkspace !== 'function' || workspaceId == null) {
				try { if (w) w.open(blankTabUrl(), '_blank'); } catch {}
				return 'fallback';
			}
			try {
				workspaces.connectWorkspace(workspaceId).then(function(sessionId) {
					try { if (w) w.open(deepLink(sessionId), '_blank'); } catch {}
				}, function(reason) {
					try { console.warn('mydsh: new tab in workspace failed:', reason); } catch {}
				});
				return 'opened';
			} catch (error) {
				try { console.warn('mydsh: connectWorkspace threw:', error); } catch {}
				return 'error';
			}
		}

		// ── NewTabButton 组件 ───────────────────────────────────────────
		// 视觉规范见 docs/design-language.md（DSH 设计令牌提取）：
		//  - 按钮对齐 Settings trigger（34px/12px/14px/hover interactive-bg-hover）
		//  - 选择框浮层完全复刻 DSH Menu：
		//      卡片: --dsw-specific-menu 底 / --dsw-alias-border-inverted 描边 /
		//            --dsw-shadow-lv3 / r12 / 4px pad / min-width 218
		//      菜单项: min-h 40 / r10 / pad 8 10 / 14-22 / label-primary /
		//            hover interactive-bg-hover / 16px 图标槽 / label ellipsis
		//      头部: 12-16 / label-tertiary / pad 8 10
		//      4px gap（bottom: calc(100% + 4px)）

		function NewTabButton(props) {
			var wide = props.wide !== false;
			var workspaces = props.workspaces;
			var hovered = useState(false);
			var isHovered = hovered[0]; var setHovered = hovered[1];
			var openState = useState(false);
			var isOpen = openState[0]; var setOpen = openState[1];

			// 弹窗内容：workspace 列表快照 + 最近使用的工作区（默认选中标记）。
			var recentId = null;
			var choices = [];
			if (isOpen && workspaces && workspaces.list) {
				var snap = workspaces.list.getSnapshot();
				choices = workspaceChoices(snap);
				recentId = snap && snap.recentWorkspaceId ? snap.recentWorkspaceId : null;
			}

			var onPick = useCallback(function(id) {
				setOpen(false);
				openNewTabInWorkspace(workspaces, id);
			}, [workspaces]);

			var onToggle = useCallback(function() {
				// 无 workspace 可选项：直接打开空标签页（新标签页自己初始化），不弹空框。
				var list = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
				var opts = workspaceChoices(list);
				if (opts.length === 0) {
					openNewTabInWorkspace(workspaces, null);
					return;
				}
				setOpen(function(v) { return !v; });
			}, [workspaces]);

			// Escape 关闭（对齐 Modal.tsx：监听挂载在 open 期间）。
			useEffect(function() {
				if (!isOpen) return;
				var onKey = function(e) {
					try { if (e.key === 'Escape') setOpen(false); } catch {}
				};
				try { document.addEventListener('keydown', onKey); } catch {}
				return function() { try { document.removeEventListener('keydown', onKey); } catch {} };
			}, [isOpen]);

			// 按钮：整行 trigger（复刻 SettingsRoot.module.css .trigger）——
			//   width: calc(100% + 8px) + margin 4px -4px，底纹超出侧栏 padding
			//   基本占满侧栏宽度；h34 / r12 / pad 6 2 6 10 / gap 8 / 14-22。
			//   rail 折叠：36px 圆形只留文件夹图标（.trigger.rail）。
			var baseStyle = {
				flex: 'none',
				display: 'inline-flex', alignItems: 'center', gap: '8px',
				boxSizing: 'border-box',
				width: wide ? 'calc(100% + 8px)' : '36px',
				height: wide ? '34px' : '36px',
				margin: wide ? '4px -4px 4px' : '8px 0 10px',
				padding: wide ? '6px 2px 6px 10px' : '0',
				justifyContent: wide ? 'flex-start' : 'center',
				border: 'none',
				borderRadius: wide ? '12px' : '50%',
				background: isHovered || isOpen ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
				cursor: 'pointer',
				overflow: 'hidden',
				color: 'var(--dsw-alias-label-primary)',
				font: 'inherit', fontSize: '14px', lineHeight: '22px',
			};

			// ── Modal（复刻 Modal.module.css + RiskConfirmation 的高度克制）─
			// .root: fixed inset 0 / z-1000 / flex 居中 / pad 24
			// .mask: --dsw-alias-bg-mask-1 + backdrop-filter var(--dsw-mask-blur)
			// .dialog: r24 / layer-2 底 / inverted 描边 / shadow-lv3 / 宽 380
			//   max-height: calc(100vh - 48px)，超高内部滚动（业界快速选择面板形态）
			// .header: pad 22 14 12 24 / title 16-24 wt500 / close 28px r8 hover
			// .description: 14-22 / pad 0 24
			// .body: pad 0 24 / margin-top 20 / min-height 0 + overflow-y auto
			var modalRootStyle = {
				position: 'fixed', inset: '0', zIndex: 1000,
				display: 'flex', alignItems: 'center', justifyContent: 'center',
				padding: '24px',
			};
			var maskStyle = {
				position: 'absolute', inset: '0',
				background: 'var(--dsw-alias-bg-mask-1)',
				backdropFilter: 'var(--dsw-mask-blur)',
			};
			var dialogStyle = {
				position: 'relative', zIndex: 1,
				display: 'flex', flexDirection: 'column', gap: '12px',
				width: 'min(380px, 100%)',
				maxHeight: 'calc(100vh - 48px)',
				padding: '0 0 16px',
				overflow: 'hidden',
				border: '1px solid var(--dsw-alias-border-inverted)',
				borderRadius: '24px',
				background: 'var(--dsw-alias-bg-layer-2)',
				boxShadow: 'var(--dsw-shadow-lv3)',
			};
			var headerStyle = {
				display: 'flex', alignItems: 'center', justifyContent: 'space-between',
				gap: '8px', padding: '18px 14px 8px 24px',
			};
			var titleStyle = {
				margin: '0', fontSize: '16px', lineHeight: '24px', fontWeight: 500,
				color: 'var(--dsw-alias-label-primary)',
			};
			var closeBtnStyle = {
				flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
				width: '28px', height: '28px', border: 'none', borderRadius: '8px',
				background: 'transparent', cursor: 'pointer',
				color: 'var(--dsw-alias-label-secondary)',
			};
			var descStyle = {
				margin: '0', padding: '0 24px',
				fontSize: '13px', lineHeight: '20px', fontWeight: 400,
				color: 'var(--dsw-alias-label-secondary)',
			};
			var bodyStyle = {
				display: 'flex', flexDirection: 'column', minWidth: '0',
				minHeight: '0', overflowY: 'auto',
				overscrollBehavior: 'contain',
				marginTop: '4px', padding: '4px 16px 0',
				gap: '2px',
			};
			// 工作区行：两行布局（title + path），hover 整行圆角底纹。
			// 底纹用 --dsw-alias-interactive-bg-hover（半透明白，暗色 rgba(255,255,255,0.08)），
			// 行 min-h 44 / r10 / pad 10 12——紧凑面板行，不局促也不臃肿。
			var rowStyle = {
				display: 'flex', alignItems: 'center', gap: '12px',
				width: '100%', minHeight: '44px',
				padding: '10px 12px',
				border: 'none', borderRadius: '10px',
				background: 'transparent', cursor: 'pointer',
				textAlign: 'left', font: 'inherit',
			};
			var rowTextStyle = {
				flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '2px',
			};
			var rowTitleStyle = {
				fontSize: '14px', lineHeight: '22px', fontWeight: 500,
				color: 'var(--dsw-alias-label-primary)',
				overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
			};
			var rowPathStyle = {
				fontSize: '12px', lineHeight: '18px',
				color: 'var(--dsw-alias-label-tertiary)',
				overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
			};
			var rowIconStyle = {
				display: 'inline-flex', flex: 'none',
				width: '20px', height: '20px',
				alignItems: 'center', justifyContent: 'center',
				color: 'var(--dsw-alias-label-secondary)',
			};
			var checkWrapStyle = {
				flex: 'none', display: 'inline-flex',
				color: 'var(--dsw-alias-label-primary)',
			};
			// 最近使用角标（选中行）：小号 tertiary 文字。
			var recentBadgeStyle = {
				flex: 'none', fontSize: '12px', lineHeight: '18px',
				color: 'var(--dsw-alias-label-tertiary)',
			};

			// hover 底纹：每行独立 state（优雅的过渡，用 onMouseEnter/Leave）。
			var Row = function(rowProps) {
				var hState = useState(false);
				var rowHovered = hState[0]; var setRowHovered = hState[1];
				var c = rowProps.choice;
				var isSelected = c.id === rowProps.recentId;
				return createElement('button', {
					type: 'button', key: c.id,
					onClick: function() { onPick(c.id); },
					onMouseEnter: function() { setRowHovered(true); },
					onMouseLeave: function() { setRowHovered(false); },
					'aria-pressed': isSelected || undefined,
					style: Object.assign({}, rowStyle, {
						background: rowHovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
					}),
				},
					createElement('span', { style: rowIconStyle },
						createElement(FolderIcon, {})),
					createElement('span', { style: rowTextStyle },
						createElement('span', { style: rowTitleStyle }, c.title),
						createElement('span', { style: rowPathStyle }, c.path)),
					isSelected ? createElement('span', { style: checkWrapStyle },
						createElement(CheckIcon, {})) : null,
					isSelected && rowProps.recentId === c.id
						? createElement('span', { style: recentBadgeStyle }, T.recentHint) : null);
			};

			// 按钮 + 模态（createPortal 到 body，复刻 Modal.tsx）。
			return createElement(React.Fragment, null,
				createElement('button', {
					type: 'button',
					onClick: onToggle,
					onMouseEnter: function() { setHovered(true); },
					onMouseLeave: function() { setHovered(false); },
					'aria-label': T.workspacePickAria, title: T.workspacePickAria,
					'aria-haspopup': 'dialog', 'aria-expanded': isOpen || undefined,
					style: baseStyle,
				}, createElement(FolderIcon, {}),
					wide ? createElement('span', { style: { overflow: 'hidden', whiteSpace: 'nowrap' } }, T.newTab) : null),
				isOpen ? ReactDOM.createPortal(
					createElement('div', { style: modalRootStyle, role: 'presentation' },
						createElement('div', { style: maskStyle, 'aria-hidden': true, onClick: function() { setOpen(false); } }),
						createElement('div', {
							style: dialogStyle, role: 'dialog', 'aria-modal': true,
							'aria-label': T.modalTitle,
						},
							createElement('div', { style: headerStyle },
								createElement('h2', { style: titleStyle }, T.modalTitle),
								createElement('button', {
									type: 'button', style: closeBtnStyle,
									'aria-label': T.close,
									onClick: function() { setOpen(false); },
								}, createElement(CloseIcon, {}))),
							createElement('p', { style: descStyle }, T.modalDesc),
							createElement('div', { style: bodyStyle },
								choices.map(function(c) {
									return createElement(Row, { key: c.id, choice: c, recentId: recentId });
								}),
							),
						),
					),
					typeof document !== 'undefined' ? document.body : null,
				) : null,
			);
		}

		// ── 重复挂载防护 ───────────────────────────────────────────────────
		// 两条安装路径都走一遍（仓库 install.sh 写 profile 的 cordis.patch.yml + npm 包
		// 自带的 bundle patch 层），组合后的 loader tree 里就会有两行同 id 的插件行：
		// 会话头出现两个「⧉」、侧栏底两个「新建会话」、?session= 深链被打开两次。
		// 别人安装时最容易踩这个，所以插件自己兜住：第二份只警告，不注册。
		var MOUNT_KEY = '__mydshUiSessionTabsMounts';

		/** 认领本进程内的唯一挂载权；返回 false 表示自己是重复的那份。 */
		function claimMount(ctx) {
			var g = typeof window !== 'undefined' ? window : globalThis;
			var n = (g[MOUNT_KEY] || 0) + 1;
			g[MOUNT_KEY] = n;
			ctx.effect(function() {
				return function() { g[MOUNT_KEY] = Math.max(0, (g[MOUNT_KEY] || 1) - 1); };
			}, '@mydsh/ui-session-tabs: mount counter');
			if (n > 1) {
				try {
					console.warn(
						'[@mydsh/ui-session-tabs] mounted ' + n + ' times — the plugin row appears more than once in '
						+ 'the composed tree, so this copy registered nothing. Keep ONE install path: either the npm '
						+ 'bundle layer (`dsh plugin --profile web add @mydsh/ui-session-tabs`) or the mydsh repo rows in '
						+ '$DSH_HOME/profiles/web/cordis.patch.yml — not both. Check with `dsh --profile web --dump-config`.',
					);
				} catch {}
				return false;
			}
			return true;
		}

		module.exports = {
			name: '@mydsh/ui-session-tabs',
			inject: ['slots', 'sessions', 'workspaces'],
			apply(ctx) {
				var sessions = ctx.get('sessions');
				var workspaces = ctx.get('workspaces');
				var slots = ctx.get('slots');
				if (slots === undefined) {
					// 静默 return 会让「装上了但什么都没发生」无从排查（例如宿主重命名了服务）。
					try {
						console.warn(
							'[@mydsh/ui-session-tabs] the host exposes no `slots` service — nothing was registered. '
							+ 'This build targets the dsh web profile (verified against dsh 0.1.0-rc.5).',
						);
					} catch {}
					return;
				}
				if (!claimMount(ctx)) return;
				// 1. "Open in new tab" button in session header actions (three dots area)
				ctx.effect(
					() => slots.inject('conversation.session.header.actions', () => slots.register({
						name: 'conversation.session.header.actions',
						id: 'mydsh-open-tab',
						order: 30,
					}, OpenTabAction)),
					'@mydsh/ui-session-tabs: open-tab action',
				);
				// 2. URL session opener (null component in input dock)
				ctx.effect(
					() => slots.inject('conversation.input.dock', (ownerProps) => slots.register({
						name: 'conversation.input.dock',
						id: 'mydsh-url-session',
						order: 50,
					}, (props) => UrlSessionOpener({ ...props, sessions }))),
					'@mydsh/ui-session-tabs: url opener',
				);
				// 3. "New session in new tab" button at the sidebar foot (beside Settings).
				//    点击弹出 workspace 选择框：选一个 workspace 后 connectWorkspace(id)
				//    拿会话 id，再在新标签页深链打开。无 workspace 时退化为打开空标签页。
				ctx.effect(
					() => slots.inject('sidebar.footer.action', (ownerProps) => slots.register({
						name: 'sidebar.footer.action',
						id: 'mydsh-new-tab',
						order: 0,
					}, () => NewTabButton({ wide: ownerProps && ownerProps.wide, workspaces }))),
					'@mydsh/ui-session-tabs: new-tab footer action',
				);
			},
			// 供 tests 直接驱动的纯逻辑（不参与运行时）。
			__test: { deepLink, blankTabUrl, workspaceChoices, openNewTabInWorkspace },
		};
		return module.exports;
	}
});